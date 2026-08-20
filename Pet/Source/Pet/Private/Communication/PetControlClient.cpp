#include "Communication/PetControlClient.h"

#include "Pet.h"
#include "Communication/PetConfigProtocol.h"
#include "Containers/StringConv.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "HAL/PlatformMisc.h"
#include "HAL/PlatformFileManager.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "HAL/RunnableThread.h"
#include "Misc/DateTime.h"
#include "Misc/Guid.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/ScopeLock.h"
#include "Serialization/JsonSerializer.h"

#include "Windows/AllowWindowsPlatformTypes.h"
#include <Windows.h>
#include "Windows/HideWindowsPlatformTypes.h"

/** 本进程软件版本（随 hello.version 上报，§4.3）。 */
static const TCHAR* PetClientVersion = TEXT("0.1.0");

namespace
{
	/**
	 * 用户关闭标记与 bridge/src/bridge/daemon.ts 共用 %TEMP%/kimi-pet/pet.disabled。
	 * UE 在控制管道断开时也先落标记，确保当前会话后续钩子不会重新拉起宠物。
	 */
	bool WriteCloseSuppressionMarker()
	{
		const FString MarkerDirectory = FPaths::Combine(FPlatformProcess::UserTempDir(), TEXT("kimi-pet"));
		IPlatformFile& PlatformFile = FPlatformFileManager::Get().GetPlatformFile();
		if (!PlatformFile.CreateDirectoryTree(*MarkerDirectory))
		{
			UE_LOG(LogPet, Warning, TEXT("无法创建用户关闭标记目录: %s"), *MarkerDirectory);
			return false;
		}

		const FString MarkerPath = FPaths::Combine(MarkerDirectory, TEXT("pet.disabled"));
		const FString Contents = FDateTime::UtcNow().ToIso8601() + LINE_TERMINATOR;
		if (!FFileHelper::SaveStringToFile(Contents, *MarkerPath, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
		{
			UE_LOG(LogPet, Warning, TEXT("无法写入用户关闭标记: %s"), *MarkerPath);
			return false;
		}
		return true;
	}
}

FPetControlClient::FPetControlClient()
{
}

FPetControlClient::~FPetControlClient()
{
	Shutdown();
}

void FPetControlClient::Start()
{
	if (WorkerThread)
	{
		return;
	}

	bStop.store(false);
	PipeName = BuildPipeName();
	StartSeconds = FPlatformTime::Seconds();
	LastHeartbeatTime = StartSeconds;

	UE_LOG(LogPet, Log, TEXT("控制管道客户端启动，目标 %s"), *PipeName);
	WorkerThread = FRunnableThread::Create(this, TEXT("PetControlClient"), 0, TPri_Normal);
}

void FPetControlClient::Stop()
{
	bStop.store(true);
}

void FPetControlClient::Shutdown()
{
	Stop();

	// 先清空成员指针，保证 Shutdown 可重复调用。FRunnableThread 析构时会调用
	// Runnable->Stop()，该回调现在只设置停止标志，不再等待或销毁线程。
	FRunnableThread* ThreadToDelete = WorkerThread;
	WorkerThread = nullptr;
	if (ThreadToDelete)
	{
		ThreadToDelete->WaitForCompletion();
		delete ThreadToDelete;
	}
}

void FPetControlClient::Tick()
{
	// 收包：工作线程按 \n 分帧入队，游戏线程解析分发
	FString Line;
	while (Inbox.Dequeue(Line))
	{
		HandleIncomingLine(Line);
	}

	// 心跳（§4.3：每 3 秒；断线期间不发）
	if (bConnected.load())
	{
		const double Now = FPlatformTime::Seconds();
		if (Now - LastHeartbeatTime >= HeartbeatIntervalSec)
		{
			LastHeartbeatTime = Now;
			SendHeartbeat();
		}
	}
}

void FPetControlClient::SendOpenTui(const FString& SessionId)
{
	TSharedPtr<FJsonObject> Payload = MakeShared<FJsonObject>();
	Payload->SetStringField(TEXT("source"), TEXT("pet"));
	if (SessionId.IsEmpty())
	{
		Payload->SetField(TEXT("session_id"), MakeShared<FJsonValueNull>());
	}
	else
	{
		Payload->SetStringField(TEXT("session_id"), SessionId);
	}
	EnqueueEnvelope(TEXT("open_tui"), Payload);
}

void FPetControlClient::SendPetMoved(int32 X, int32 Y)
{
	// 显示器 id：取窗口位置所在显示器（§4.3 pet_moved / §5.7 多显示器）
	FString MonitorId = TEXT("unknown");
	POINT Pt = { X, Y };
	if (HMONITOR Mon = MonitorFromPoint(Pt, MONITOR_DEFAULTTONEAREST))
	{
		MONITORINFOEXW Info = {};
		Info.cbSize = sizeof(Info);
		if (GetMonitorInfoW(Mon, &Info))
		{
			MonitorId = FString(Info.szDevice); // 形如 \\.\DISPLAY1
		}
	}

	TSharedPtr<FJsonObject> Payload = MakeShared<FJsonObject>();
	Payload->SetNumberField(TEXT("x"), X);
	Payload->SetNumberField(TEXT("y"), Y);
	Payload->SetStringField(TEXT("monitor_id"), MonitorId);
	EnqueueEnvelope(TEXT("pet_moved"), Payload);
	UE_LOG(LogPet, Log, TEXT("已发送 pet_moved (x=%d, y=%d, monitor=%s)"), X, Y, *MonitorId);
}

void FPetControlClient::SendUpdateConfig(const FPetConfigPatch& Patch)
{
	// 只组装补丁中已提供的字段；守护进程校验合并后写回并回推 config_snapshot。
	const TSharedPtr<FJsonObject> Payload = PetConfigProtocol::BuildUpdateConfigPayload(Patch);
	if (!EnqueueEnvelope(TEXT("update_config"), Payload))
	{
		return;
	}
	FString Fields;
	const auto AppendField = [&Fields](const FString& Name, const FString& Value)
	{
		Fields += FString::Printf(TEXT("%s%s=%s"), Fields.IsEmpty() ? TEXT("") : TEXT(", "), *Name, *Value);
	};
	if (Patch.OpenTarget.IsSet()) { AppendField(TEXT("open_target"), Patch.OpenTarget.GetValue()); }
	if (Patch.UiTheme.IsSet()) { AppendField(TEXT("ui_theme"), Patch.UiTheme.GetValue()); }
	if (Patch.FpsMonitor.IsSet()) { AppendField(TEXT("fps_monitor"), Patch.FpsMonitor.GetValue() ? TEXT("true") : TEXT("false")); }
	UE_LOG(LogPet, Log, TEXT("已发送 update_config: %s"), Fields.IsEmpty() ? TEXT("(空)") : *Fields);
}

bool FPetControlClient::SendClosePet()
{
	const bool bMarkerWritten = WriteCloseSuppressionMarker();
	TSharedPtr<FJsonObject> Payload = MakeShared<FJsonObject>();
	Payload->SetStringField(TEXT("reason"), TEXT("user"));
	const bool bQueued = EnqueueEnvelope(TEXT("close_pet"), Payload);
	if (bQueued)
	{
		UE_LOG(LogPet, Log, TEXT("已发送 close_pet(reason=user, marker=%s)"), bMarkerWritten ? TEXT("ok") : TEXT("failed"));
	}
	else if (bMarkerWritten)
	{
		UE_LOG(LogPet, Log, TEXT("控制管道未连接，但用户关闭标记已写入"));
	}
	return bQueued;
}

uint32 FPetControlClient::Run()
{
	WorkerLoop();
	return 0;
}

void FPetControlClient::WorkerLoop()
{
	bool bEverConnected = false;
	while (!bStop.load())
	{
		if (TryConnect())
		{
			bEverConnected = true;
			bConnected.store(true);
			UE_LOG(LogPet, Log, TEXT("控制管道已连接 (%s)"), *PipeName);
			if (!SendHello() || !ReadAndWriteLoop())
			{
				if (!bStop.load())
				{
					UE_LOG(LogPet, Warning, TEXT("控制管道写入/读取失败，连接关闭"));
				}
			}
			ClosePipe();
			bConnected.store(false);
			// 清空断线前未发完的消息（对旧连接的过期数据，避免重连后补发旧心跳等）
			{
				FScopeLock Lock(&SendLock);
				PendingSends.Reset();
			}
			if (bStop.load())
			{
				break;
			}
			UE_LOG(LogPet, Log, TEXT("控制管道断开，%d 秒后重连（离线渲染，冻结当前状态，不自行推导）"),
				ReconnectDelayMs / 1000);
		}
		else if (!bStop.load())
		{
			UE_LOG(LogPet, Log, TEXT("控制管道未就绪（守护进程未启动？），%d 秒后重试"),
				bEverConnected ? ReconnectDelayMs / 1000 : InitialConnectDelayMs / 1000);
		}

		// 休眠按 100ms 分片，及时响应 Stop()
		const int32 DelayMs = bEverConnected ? ReconnectDelayMs : InitialConnectDelayMs;
		for (int32 i = 0; i < DelayMs / 100 && !bStop.load(); ++i)
		{
			FPlatformProcess::Sleep(0.1f);
		}
	}
}

bool FPetControlClient::TryConnect()
{
	// 渲染进程为客户端：CreateFile 打开服务端已创建的管道（§4.1）
	HANDLE H = CreateFileW(*PipeName,
		GENERIC_READ | GENERIC_WRITE,
		0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
	if (H != INVALID_HANDLE_VALUE)
	{
		PipeHandle = H;
		return true;
	}

	DWORD Err = GetLastError();
	if (Err == ERROR_PIPE_BUSY)
	{
		// 服务端瞬间达到满实例数：等待片刻后重试一次
		if (WaitNamedPipeW(*PipeName, 1000))
		{
			H = CreateFileW(*PipeName,
				GENERIC_READ | GENERIC_WRITE,
				0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
			if (H != INVALID_HANDLE_VALUE)
			{
				PipeHandle = H;
				return true;
			}
		}
	}
	return false;
}

bool FPetControlClient::ReadAndWriteLoop()
{
	TArray<uint8> ReadBuf;
	ReadBuf.SetNum(4096);

	OVERLAPPED Ov = {};
	Ov.hEvent = CreateEventW(nullptr, 1 /*TRUE*/, 0 /*FALSE*/, nullptr); // UE 头文件环境里 TRUE/FALSE 宏被隐藏
	if (!Ov.hEvent)
	{
		return false;
	}

	bool bReadPending = false;
	auto CleanupRead = [&]()
	{
		// OVERLAPPED、读取缓冲和事件在栈上，离开函数前必须保证挂起读取已经结束。
		if (bReadPending && PipeHandle)
		{
			CancelIoEx(PipeHandle, &Ov);
			DWORD IgnoredBytes = 0;
			GetOverlappedResult(PipeHandle, &Ov, &IgnoredBytes, 1 /*TRUE*/);
			bReadPending = false;
		}
		if (Ov.hEvent)
		{
			CloseHandle(Ov.hEvent);
			Ov.hEvent = nullptr;
		}
	};

	const DWORD WaitMs = 1000;
	while (!bStop.load())
	{
		// 1) 冲刷发送队列（游戏线程入队，本线程独占写入）
		TArray<FString> ToSend;
		{
			FScopeLock Lock(&SendLock);
			if (PendingSends.Num() > 0)
			{
				Swap(PendingSends, ToSend);
			}
		}
		for (const FString& Msg : ToSend)
		{
			if (!WriteLine(Msg))
			{
				CleanupRead();
				return false;
			}
		}

		// 2) 重叠读：单次挂起一个读，1 秒超时片内检查发送队列与停止标志
		if (!bReadPending)
		{
			DWORD BytesRead = 0;
			ResetEvent(Ov.hEvent);
			if (ReadFile(PipeHandle, ReadBuf.GetData(), ReadBuf.Num(), &BytesRead, &Ov))
			{
				if (BytesRead == 0)
				{
					CleanupRead();
					return false; // 对端关闭
				}
				LineBuffer.Append(ReadBuf.GetData(), BytesRead);
				ProcessLineBuffer();
				continue;
			}
			const DWORD ReadErr = GetLastError();
			if (ReadErr == ERROR_IO_PENDING)
			{
				bReadPending = true;
			}
			else
			{
				UE_LOG(LogPet, Warning, TEXT("控制管道读失败: %u（对端关闭？）"), ReadErr);
				CleanupRead();
				return false;
			}
		}
		else
		{
			const DWORD Wait = WaitForSingleObject(Ov.hEvent, WaitMs);
			if (Wait == WAIT_OBJECT_0)
			{
				DWORD BytesRead = 0;
				bReadPending = false;
				if (!GetOverlappedResult(PipeHandle, &Ov, &BytesRead, 0 /*FALSE*/))
				{
					UE_LOG(LogPet, Warning, TEXT("控制管道读完成错误: %u"), GetLastError());
					CleanupRead();
					return false;
				}
				if (BytesRead == 0)
				{
					CleanupRead();
					return false; // 对端关闭
				}
				LineBuffer.Append(ReadBuf.GetData(), BytesRead);
				ProcessLineBuffer();
			}
			else if (Wait == WAIT_TIMEOUT)
			{
				continue; // 读仍挂起：回循环头处理发送队列与 bStop
			}
			else
			{
				CleanupRead();
				return false;
			}
		}
	}
	CleanupRead();
	return true;
}

bool FPetControlClient::WriteLine(const FString& Line)
{
	// 同步写（本线程独占写操作）；UTF-8 编码 + '\n' 行分帧（全局约定：一条消息 = 一个 JSON 对象 + \n，§4.2）
	const FTCHARToUTF8 Utf8(*(Line + TEXT("\n")));
	DWORD Written = 0;
	if (!WriteFile(PipeHandle, Utf8.Get(), Utf8.Length(), &Written, nullptr))
	{
		UE_LOG(LogPet, Warning, TEXT("控制管道写失败: %u"), GetLastError());
		return false;
	}
	return true;
}

bool FPetControlClient::SendHello()
{
	// 工作线程直接发送（连接建立后首条，§4.3）；内容全为常量，无转义问题
	const int32 Pid = FPlatformProcess::GetCurrentProcessId();
	const FString Msg = FString::Printf(
		TEXT("{\"v\":1,\"type\":\"hello\",\"id\":\"%s\",\"ts\":\"%s\",\"session_id\":null,"
			"\"payload\":{\"protocol_version\":1,\"role\":\"renderer\",\"pid\":%d,\"version\":\"%s\","
			"\"capabilities\":[\"pet_state\",\"sessions_snapshot\",\"config_snapshot\",\"session_state\",\"task_start\",\"task_end\",\"tasks_snapshot\",\"notify\","
			"\"open_tui\",\"heartbeat\",\"pet_moved\",\"close_pet\",\"update_config\",\"shutdown\"]}}"),
		*FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens),
		*FDateTime::UtcNow().ToIso8601(),
		Pid,
		PetClientVersion);
	const bool bOk = WriteLine(Msg);
	UE_LOG(LogPet, Log, TEXT("已发送 hello (pid=%d, version=%s, role=renderer)"), Pid, PetClientVersion);
	return bOk;
}

void FPetControlClient::ProcessLineBuffer()
{
	// 按 \n 分帧（全局约定：一条消息 = 一个 JSON 对象 + \n）
	int32 StartIdx = 0;
	for (;;)
	{
		int32 NewlineIdx = INDEX_NONE;
		for (int32 i = StartIdx; i < LineBuffer.Num(); ++i)
		{
			if (LineBuffer[i] == (uint8)'\n')
			{
				NewlineIdx = i;
				break;
			}
		}
		if (NewlineIdx == INDEX_NONE)
		{
			break;
		}
		const int32 LineLen = NewlineIdx - StartIdx;
		if (LineLen > 0)
		{
			const ANSICHAR* Bytes = reinterpret_cast<const ANSICHAR*>(LineBuffer.GetData() + StartIdx);
			Inbox.Enqueue(FString(FUTF8ToTCHAR(Bytes, LineLen)));
		}
		StartIdx = NewlineIdx + 1;
	}
	if (StartIdx > 0)
	{
		LineBuffer.RemoveAt(0, StartIdx, EAllowShrinking::No);
	}
	if (LineBuffer.Num() > MaxLineBytes)
	{
		// 单条消息上限 64KB（§4.1）：超长且无换行，丢弃并记日志，不中断连接
		UE_LOG(LogPet, Warning, TEXT("控制管道收到超长行（>%d 字节）且无换行，丢弃 %d 字节"),
			MaxLineBytes, LineBuffer.Num());
		LineBuffer.Reset();
	}
}

void FPetControlClient::ClosePipe()
{
	if (PipeHandle)
	{
		CloseHandle(PipeHandle);
		PipeHandle = nullptr;
	}
}

void FPetControlClient::HandleIncomingLine(const FString& Line)
{
	// 解析（游戏线程；Json 模块发布版可用，§4.1）
	TSharedPtr<FJsonObject> Envelope;
	TSharedRef<TJsonReader<TCHAR>> Reader = TJsonReaderFactory<TCHAR>::Create(Line);
	if (!FJsonSerializer::Deserialize(Reader, Envelope) || !Envelope.IsValid())
	{
		RecordProtocolError(TEXT("非法 JSON"), Line);
		return;
	}

	// 信封校验（§4.2 / §4.4：非法/缺信封字段跳过本条并回 protocol_error）
	int32 V = 0;
	if (!Envelope->TryGetNumberField(TEXT("v"), V) || V != 1)
	{
		RecordProtocolError(TEXT("信封 v 字段缺失或 != 1"), Line);
		return;
	}
	FString Type;
	if (!Envelope->TryGetStringField(TEXT("type"), Type) || Type.IsEmpty())
	{
		RecordProtocolError(TEXT("信封 type 字段缺失或非字符串"), Line);
		return;
	}
	FString Ts;
	{
		FDateTime TsParsed;
		if (!Envelope->TryGetStringField(TEXT("ts"), Ts) || !FDateTime::ParseIso8601(*Ts, TsParsed))
		{
			RecordProtocolError(TEXT("信封 ts 字段缺失或不可解析"), Line);
			return;
		}
	}
	const TSharedPtr<FJsonValue>* SessionValue = Envelope->Values.Find(TEXT("session_id"));
	if (!SessionValue || !SessionValue->IsValid() ||
		((*SessionValue)->Type != EJson::String && (*SessionValue)->Type != EJson::Null))
	{
		RecordProtocolError(TEXT("信封 session_id 字段缺失或必须为字符串或 null"), Line);
		return;
	}
	FString SessionId;
	if (SessionValue && SessionValue->IsValid() && (*SessionValue)->Type == EJson::String)
	{
		SessionId = (*SessionValue)->AsString();
	}
	const TSharedPtr<FJsonObject>* PayloadField = nullptr;
	if (!Envelope->TryGetObjectField(TEXT("payload"), PayloadField) || !PayloadField->IsValid())
	{
		RecordProtocolError(TEXT("信封 payload 字段缺失或非对象"), Line);
		return;
	}
	const TSharedPtr<FJsonObject>& Payload = *PayloadField;

	// 消息分发（§4.3；未知类型忽略并记日志，§4.2 向前兼容）
	if (Type == TEXT("hello"))
	{
		int32 ProtoVer = 0, Pid = 0;
		FString Role, Version;
		Payload->TryGetNumberField(TEXT("protocol_version"), ProtoVer);
		Payload->TryGetStringField(TEXT("role"), Role);
		Payload->TryGetNumberField(TEXT("pid"), Pid);
		Payload->TryGetStringField(TEXT("version"), Version);
		UE_LOG(LogPet, Log, TEXT("收到 hello: protocol_version=%d role=%s pid=%d version=%s"),
			ProtoVer, *Role, Pid, *Version);
	}
	else if (Type == TEXT("pet_state"))
	{
		FString State;
		if (!Payload->TryGetStringField(TEXT("state"), State) ||
			(State != TEXT("Idle") && State != TEXT("Working")))
		{
			UE_LOG(LogPet, Warning, TEXT("协议: pet_state 的 state 字段非法（%s），忽略"), *State);
			return;
		}
		FString Reason;
		Payload->TryGetStringField(TEXT("reason"), Reason);
		UE_LOG(LogPet, Log, TEXT("收到 pet_state: %s (reason=%s)"), *State, *Reason);
		CurrentState = State; // 状态唯一入口（§2.2 D3）：断线期间冻结，不自行推导
		if (OnPetState)
		{
			OnPetState(State, Reason);
		}
	}
	else if (Type == TEXT("shutdown"))
	{
		FString Reason;
		Payload->TryGetStringField(TEXT("reason"), Reason);
		UE_LOG(LogPet, Log, TEXT("收到 shutdown (reason=%s)，退出游戏"), *Reason);
		if (OnShutdown)
		{
			OnShutdown(Reason);
		}
	}
	else if (Type == TEXT("sessions_snapshot"))
	{
		const TArray<TSharedPtr<FJsonValue>>* SessionValues = nullptr;
		TArray<FPetSessionInfo> Sessions;
		if (!Payload->TryGetArrayField(TEXT("sessions"), SessionValues) || !SessionValues)
		{
			// 缺少必需数组不是“权威空快照”。若继续广播空数组会把当前面板
			// 全部清空，并让一次坏包看起来像所有会话突然消失。
			RecordProtocolError(TEXT("sessions_snapshot 缺少 sessions 数组"), Line);
			return;
		}

		Sessions.Reserve(SessionValues->Num());
		for (const TSharedPtr<FJsonValue>& Value : *SessionValues)
		{
			if (!Value.IsValid() || Value->Type != EJson::Object)
			{
				continue;
			}
			const TSharedPtr<FJsonObject> Item = Value->AsObject();
			FPetSessionInfo Session;
			if (!Item.IsValid() || !Item->TryGetStringField(TEXT("session_id"), Session.SessionId) || Session.SessionId.IsEmpty())
			{
				continue;
			}
			Item->TryGetStringField(TEXT("title"), Session.Title);
			Item->TryGetStringField(TEXT("cwd"), Session.Cwd);
			Item->TryGetBoolField(TEXT("active"), Session.bActive);
			Item->TryGetBoolField(TEXT("working"), Session.bWorking);
			Item->TryGetBoolField(TEXT("unread"), Session.bUnread);
			Sessions.Add(MoveTemp(Session));
		}
		UE_LOG(LogPet, Log, TEXT("收到 sessions_snapshot: %d 个 Kimi Code 会话"), Sessions.Num());
		if (OnSessionsSnapshot)
		{
			OnSessionsSnapshot(Sessions);
		}
	}
	else if (Type == TEXT("config_snapshot"))
	{
		FPetSettingsSnapshot Snapshot;
		if (!PetConfigProtocol::ParseConfigSnapshot(Payload, Snapshot))
		{
			RecordProtocolError(TEXT("config_snapshot 的 open_target/ui_theme/fps_monitor/open_web_url 字段非法"), Line);
			return;
		}
		UE_LOG(LogPet, Log, TEXT("收到 config_snapshot: open_target=%s ui_theme=%s fps_monitor=%d open_web_url=%s"),
			*Snapshot.OpenTarget, *Snapshot.UiTheme, Snapshot.bFpsMonitor ? 1 : 0, *Snapshot.OpenWebUrl);
		if (OnConfigSnapshot)
		{
			OnConfigSnapshot(Snapshot);
		}
	}
	else if (Type == TEXT("tasks_snapshot"))
	{
		const TArray<TSharedPtr<FJsonValue>>* Tasks = nullptr;
		Payload->TryGetArrayField(TEXT("tasks"), Tasks);
		UE_LOG(LogPet, Log, TEXT("收到 tasks_snapshot: %d 个任务（悬浮卡后续任务实现）"), Tasks ? Tasks->Num() : 0);
	}
	else if (Type == TEXT("task_start"))
	{
		FString TaskId, Title, Tool;
		Payload->TryGetStringField(TEXT("task_id"), TaskId);
		Payload->TryGetStringField(TEXT("title"), Title);
		Payload->TryGetStringField(TEXT("tool"), Tool);
		UE_LOG(LogPet, Log, TEXT("收到 task_start: task_id=%s tool=%s title=%s"), *TaskId, *Tool, *Title);
	}
	else if (Type == TEXT("task_end"))
	{
		FString TaskId, Status, Title;
		Payload->TryGetStringField(TEXT("task_id"), TaskId);
		Payload->TryGetStringField(TEXT("status"), Status);
		Payload->TryGetStringField(TEXT("title"), Title);
		UE_LOG(LogPet, Log, TEXT("收到 task_end: task_id=%s status=%s title=%s"), *TaskId, *Status, *Title);
	}
	else if (Type == TEXT("notify"))
	{
		FString Text, Level;
		Payload->TryGetStringField(TEXT("text"), Text);
		Payload->TryGetStringField(TEXT("level"), Level);
		UE_LOG(LogPet, Log, TEXT("收到 notify: level=%s text=%s（气泡后续任务实现）"), *Level, *Text);
	}
	else if (Type == TEXT("session_start"))
	{
		FString Cwd;
		bool Resume = false;
		Payload->TryGetStringField(TEXT("cwd"), Cwd);
		Payload->TryGetBoolField(TEXT("resume"), Resume);
		UE_LOG(LogPet, Log, TEXT("收到 session_start: session=%s cwd=%s resume=%d"), *SessionId, *Cwd, Resume ? 1 : 0);
		if (!SessionId.IsEmpty() && OnSessionStart)
		{
			OnSessionStart(SessionId, Cwd, Resume);
		}
	}
	else if (Type == TEXT("session_end"))
	{
		FString Reason;
		Payload->TryGetStringField(TEXT("reason"), Reason);
		UE_LOG(LogPet, Log, TEXT("收到 session_end: session=%s reason=%s"), *SessionId, *Reason);
		if (!SessionId.IsEmpty() && OnSessionEnd)
		{
			OnSessionEnd(SessionId, Reason);
		}
	}
	else if (Type == TEXT("session_state"))
	{
		bool bWorking = false;
		bool bUnread = false;
		if (SessionId.IsEmpty() || !Payload->TryGetBoolField(TEXT("working"), bWorking) ||
			!Payload->TryGetBoolField(TEXT("unread"), bUnread))
		{
			UE_LOG(LogPet, Warning, TEXT("协议: session_state 字段非法，忽略"));
			return;
		}
		UE_LOG(LogPet, Log, TEXT("收到 session_state: session=%s working=%d unread=%d"),
			*SessionId, bWorking ? 1 : 0, bUnread ? 1 : 0);
		if (OnSessionState)
		{
			OnSessionState(SessionId, bWorking, bUnread);
		}
	}
	else if (Type == TEXT("protocol_error"))
	{
		FString Description;
		Payload->TryGetStringField(TEXT("description"), Description);
		UE_LOG(LogPet, Warning, TEXT("收到 protocol_error: %s"), *Description);
	}
	else if (Type == TEXT("heartbeat") || Type == TEXT("open_tui") || Type == TEXT("pet_moved") || Type == TEXT("close_pet") ||
		Type == TEXT("update_config") || Type == TEXT("host_event"))
	{
		// 按 §4.3 这些类型不会发往渲染进程；收到仅记日志
		UE_LOG(LogPet, Verbose, TEXT("收到 %s（本角色不应收到，忽略）"), *Type);
	}
	else
	{
		UE_LOG(LogPet, Log, TEXT("协议: 忽略未知消息类型 %s（向前兼容，§4.2）"), *Type);
	}
}

void FPetControlClient::RecordProtocolError(const FString& Description, const FString& RawExcerpt)
{
	UE_LOG(LogPet, Warning, TEXT("协议: %s，忽略本条并回 protocol_error"), *Description);
	SendProtocolError(Description, RawExcerpt);
	if (++ProtocolErrorCount >= ProtocolErrorWarnCount)
	{
		UE_LOG(LogPet, Warning, TEXT("协议: 连续错误达 %d 条/分钟（不中断连接，§4.4）"), ProtocolErrorWarnCount);
		ProtocolErrorCount = 0;
	}
}

void FPetControlClient::SendProtocolError(const FString& Description, const FString& RawExcerpt)
{
	TSharedPtr<FJsonObject> Payload = MakeShared<FJsonObject>();
	Payload->SetStringField(TEXT("description"), Description);
	Payload->SetStringField(TEXT("raw_excerpt"), RawExcerpt.Left(MaxRawExcerptChars));
	EnqueueEnvelope(TEXT("protocol_error"), Payload);
}

void FPetControlClient::SendHeartbeat()
{
	TSharedPtr<FJsonObject> Payload = MakeShared<FJsonObject>();
	Payload->SetNumberField(TEXT("pid"), FPlatformProcess::GetCurrentProcessId());
	Payload->SetNumberField(TEXT("uptime_s"), FPlatformTime::Seconds() - StartSeconds);
	Payload->SetStringField(TEXT("state"), CurrentState);
	EnqueueEnvelope(TEXT("heartbeat"), Payload);
	UE_LOG(LogPet, Log, TEXT("已发送 heartbeat (state=%s)"), *CurrentState);
}

bool FPetControlClient::EnqueueEnvelope(const FString& Type, const TSharedPtr<FJsonObject>& Payload)
{
	if (!bConnected.load())
	{
		// §6.5：断线时不重试轰炸，只记日志；心跳/位置等离线数据同样丢弃
		UE_LOG(LogPet, Log, TEXT("控制管道未连接，丢弃待发消息 %s"), *Type);
		return false;
	}

	TSharedPtr<FJsonObject> Envelope = MakeShared<FJsonObject>();
	Envelope->SetNumberField(TEXT("v"), 1);
	Envelope->SetStringField(TEXT("type"), Type);
	Envelope->SetStringField(TEXT("id"), FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens));
	Envelope->SetStringField(TEXT("ts"), FDateTime::UtcNow().ToIso8601());
	Envelope->SetField(TEXT("session_id"), MakeShared<FJsonValueNull>());
	Envelope->SetObjectField(TEXT("payload"), Payload);

	// 紧凑输出（无内部换行），保证 \n 行分帧不被消息内换行破坏（全局约定，§4.2）
	// 注：UE 5.8 的 TJsonWriterFactory 默认是美化（多行）输出，必须显式指定紧凑策略
	FString Out;
	TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
		TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out);
	FJsonSerializer::Serialize(Envelope.ToSharedRef(), Writer);

	{
		FScopeLock Lock(&SendLock);
		PendingSends.Add(Out);
	}
	return true;
}

FString FPetControlClient::BuildPipeName()
{
	// 取当前 Windows 用户名（与 bridge 端 getUserName 一致：GetUserName → USERNAME → USER）
	FString UserName;
	{
		WCHAR Buf[256] = {};
		DWORD Size = 256;
		if (GetUserNameW(Buf, &Size))
		{
			UserName = Buf;
		}
	}
	if (UserName.IsEmpty())
	{
		UserName = FPlatformMisc::GetEnvironmentVariable(TEXT("USERNAME"));
	}
	if (UserName.IsEmpty())
	{
		UserName = FPlatformMisc::GetEnvironmentVariable(TEXT("USER"));
	}
	return FString::Printf(TEXT("\\\\.\\pipe\\KimiPet.PET.%s"), *SanitizeUserName(UserName));
}

FString FPetControlClient::SanitizeUserName(const FString& In)
{
	// 过滤规则与 bridge/src/bridge/user.ts 一致：\ / : * ? " < > | 与控制字符（0x00-0x1F）替换为 _，trim 后为空回退 default
	static const TCHAR* InvalidChars = TEXT("\\/:*?\"<>|");
	FString Out = In;
	for (TCHAR& C : Out)
	{
		if (FCString::Strchr(InvalidChars, C) != nullptr || C < 32)
		{
			C = TEXT('_');
		}
	}
	Out.TrimStartAndEndInline();
	if (Out.IsEmpty())
	{
		Out = TEXT("default");
	}
	return Out;
}
