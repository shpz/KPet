#pragma once

#include "CoreMinimal.h"
#include "HAL/Runnable.h"
#include "Communication/PetSessionTypes.h"

#include "Windows/AllowWindowsPlatformTypes.h"
#include <Windows.h>
#include "Windows/HideWindowsPlatformTypes.h"

class FJsonObject;

/**
 * 控制管道客户端（渲染进程侧，§4.1）：
 * - 客户端主动连入 \\.\pipe\KimiPet.PET.<用户名>（守护进程为服务端）；用户名过滤规则与 bridge/src/bridge/user.ts 一致
 * - 收发放在工作线程（FRunnable）：字节流按 \n 行分帧（全局约定：一条消息 = 一个 JSON 对象 + \n），
 *   完整行经 SPSC 队列转交游戏线程用引擎 Json 模块解析并分发
 * - 连接建立即发 hello；每 3 秒发 heartbeat（§4.3）；断线后每 5 秒重连，期间冻结当前状态、保持离线渲染（§4.5-5）
 * - pet_state 是状态唯一入口（§2.2 D3）：渲染进程只执行，不自行推导
 * - 回调（OnPetState / OnShutdown）全部在游戏线程触发
 */
class FPetControlClient : public FRunnable
{
public:
	FPetControlClient();
	virtual ~FPetControlClient() override;

	/** 启动工作线程（游戏线程调用）。 */
	void Start();

	/** 请求停止并等待工作线程退出（游戏线程调用；最迟约 1 秒读超时片内退出）。 */
	void Shutdown();

	/** 游戏线程每帧调用：转交收包、分发回调、发送心跳。 */
	void Tick();

	/** 当前宠物状态（Idle/Working，仅由收到的 pet_state 更新；断线期间冻结不推导）。 */
	const FString& GetCurrentState() const { return CurrentState; }

	bool IsConnected() const { return bConnected.load(); }

	/** 上报会话打开请求；SessionId 为空时恢复最近会话。 */
	void SendOpenTui(const FString& SessionId = FString());

	/** 上报拖拽结束（§6.4 → pet_moved，含所在显示器 id）。 */
	void SendPetMoved(int32 X, int32 Y);

	/** 请求更新守护进程配置（update_config，字段缺省表示不修改）。 */
	void SendUpdateConfig(const FPetConfigPatch& Patch);

	/** 请求用户关闭宠物。返回 false 表示当前未连接，调用方应执行本地退出兜底。 */
	bool SendClosePet();

	// ---- 事件回调（游戏线程触发） ----
	TFunction<void(const FString& State, const FString& Reason)> OnPetState;
	TFunction<void(const TArray<FPetSessionInfo>& Sessions)> OnSessionsSnapshot;
	TFunction<void(const FPetSettingsSnapshot& Snapshot)> OnConfigSnapshot;
	TFunction<void(const FString& SessionId, const FString& Cwd, bool bResume)> OnSessionStart;
	TFunction<void(const FString& SessionId, const FString& Reason)> OnSessionEnd;
	TFunction<void(const FString& SessionId, bool bWorking, bool bUnread)> OnSessionState;
	TFunction<void(const FString& Reason)> OnShutdown;

private:
	// ---- FRunnable ----
	virtual uint32 Run() override;
	/** FRunnableThread 的停止回调：只发停止信号，不能在这里等待或销毁线程。 */
	virtual void Stop() override;

	// ---- 工作线程 ----
	void WorkerLoop();
	bool TryConnect();
	/** 循环：冲刷发送队列 + 重叠读（1 秒超时片），返回 false 表示连接已不可用。 */
	bool ReadAndWriteLoop();
	bool WriteLine(const FString& Line);
	bool SendHello();
	/** 按 \n 分帧，完整行入 Inbox，超长残留丢弃。 */
	void ProcessLineBuffer();
	void ClosePipe();

	// ---- 游戏线程 ----
	void HandleIncomingLine(const FString& Line);
	void RecordProtocolError(const FString& Description, const FString& RawExcerpt);
	void SendProtocolError(const FString& Description, const FString& RawExcerpt);
	void SendHeartbeat();
	/** 构造 §4.2 信封并入发送队列（未连接时丢弃并记日志，§6.5 不重试轰炸）。 */
	bool EnqueueEnvelope(const FString& Type, const TSharedPtr<FJsonObject>& Payload);

	// ---- 工具 ----
	static FString BuildPipeName();
	static FString SanitizeUserName(const FString& In);

	FRunnableThread* WorkerThread = nullptr;
	FString PipeName; // Start() 中构建，创建线程后只读
	std::atomic<bool> bStop{ false };
	std::atomic<bool> bConnected{ false };

	// 发送队列：游戏线程入队，工作线程取出写入管道
	FCriticalSection SendLock;
	TArray<FString> PendingSends;

	// 收包队列：工作线程入队（SPSC），游戏线程出队
	TQueue<FString, EQueueMode::Spsc> Inbox;

	// 以下仅工作线程访问
	HANDLE PipeHandle = nullptr;
	TArray<uint8> LineBuffer;

	// 以下仅游戏线程访问
	FString CurrentState = TEXT("Idle"); // 初始 Idle，断线期间冻结（§4.5-5）
	double StartSeconds = 0.0;
	double LastHeartbeatTime = 0.0;
	int32 ProtocolErrorCount = 0;

	static constexpr double HeartbeatIntervalSec = 3.0;  // §4.3：每 3 秒
	static constexpr int32 ReconnectDelayMs = 5000;      // §4.5-5：断线后每 5 秒重连
	static constexpr int32 InitialConnectDelayMs = 1000; // 从未连上时更快重试（守护进程可能尚未启动）
	static constexpr int32 MaxLineBytes = 64 * 1024;     // 单条消息上限（§4.1）
	static constexpr int32 MaxRawExcerptChars = 256;     // §4.3：protocol_error.raw_excerpt 截断
	static constexpr int32 ProtocolErrorWarnCount = 10;  // §4.4：1 分钟连续错误告警阈值
};
