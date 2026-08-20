#include "UI/PetSessionWebPanel.h"

#include "Pet.h"
#include "Communication/PetSessionTypes.h"
#include "UI/PetSessionWebBridge.h"

#include "Dom/JsonObject.h"
#include "HAL/IConsoleManager.h"
#include "Misc/CommandLine.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/Package.h"
#include "UObject/UObjectGlobals.h"
#include "WebBrowserModule.h"
#include "Widgets/SNullWidget.h"
#include "SWebBrowser.h"
#include "Widgets/SWidget.h"

namespace
{
	/** HTML 读取失败时的内嵌中文兜底页。 */
	const TCHAR* EmbeddedFallbackHtml =
		TEXT("<html><head><meta charset=\"utf-8\"><style>")
		TEXT("html,body{height:100%;margin:0;background:#14161e;color:#e6e8f0;")
		TEXT("font-family:\"Microsoft YaHei\",sans-serif;display:flex;align-items:center;justify-content:center;}")
		TEXT("p{margin:4px 0;text-align:center;}")
		TEXT("</style></head><body><div>")
		TEXT("<p>会话面板加载失败</p>")
		TEXT("<p style=\"color:#8a90a3;font-size:12px;\">无法读取 Content/UI/Web/session-panel.html</p>")
		TEXT("</div></body></html>");

	/** 把单条会话转成与 JS 契约一致的 FJsonObject（camelCase 字段名、布尔原值）。 */
	TSharedRef<FJsonObject> SessionToJson(const FPetSessionInfo& Session)
	{
		TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
		Json->SetStringField(TEXT("sessionId"), Session.SessionId);
		Json->SetStringField(TEXT("title"), Session.Title);
		Json->SetStringField(TEXT("cwd"), Session.Cwd);
		Json->SetBoolField(TEXT("active"), Session.bActive);
		Json->SetBoolField(TEXT("working"), Session.bWorking);
		Json->SetBoolField(TEXT("unread"), Session.bUnread);
		return Json;
	}

	/**
	 * JSON 文本直接作为 JS 对象字面量注入 ExecuteJavascript。
	 * U+2028/U+2029 在 JSON 中合法，但作为 JS 源码字面量时旧引擎会当行分隔符，
	 * 统一替换为 \uXXXX 等价转义，保证任意会话文本都能安全注入。
	 */
	FString EscapeJsSource(const FString& JsonText)
	{
		FString Result = JsonText;
		Result = Result.Replace(TEXT("\u2028"), TEXT("\\u2028"), ESearchCase::CaseSensitive);
		Result = Result.Replace(TEXT("\u2029"), TEXT("\\u2029"), ESearchCase::CaseSensitive);
		return Result;
	}

	/** 输出紧凑 JSON 文本并做 JS 源码转义。 */
	FString WriteJsonAsJsSource(const TSharedPtr<FJsonValue>& Value)
	{
		FString JsonText;
		TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
			TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&JsonText);
		// UE 5.8 的 FJsonSerializer::Serialize 由方法模板推导 CharType/PrintPolicy，
		// bCloseWriter 默认 true，序列化完成后会自动关闭 Writer。
		FJsonSerializer::Serialize(Value, FString(), Writer);
		return EscapeJsSource(JsonText);
	}

	/** 会话数组 -> JS 数组字面量文本。 */
	FString SessionsToJsArray(const TArray<FPetSessionInfo>& Sessions)
	{
		TArray<TSharedPtr<FJsonValue>> Items;
		Items.Reserve(Sessions.Num());
		for (const FPetSessionInfo& Session : Sessions)
		{
			Items.Add(MakeShared<FJsonValueObject>(SessionToJson(Session)));
		}
		return WriteJsonAsJsSource(MakeShared<FJsonValueArray>(Items));
	}

	/** 会话对象 -> JS 对象字面量文本。 */
	FString SessionToJsObject(const FPetSessionInfo& Session)
	{
		return WriteJsonAsJsSource(MakeShared<FJsonValueObject>(SessionToJson(Session)));
	}

	/**
	 * 任意字符串 -> 带双引号的 JS 字符串字面量。
	 * U+2028/U+2029 会截断 JS 字符串字面量造成 SyntaxError，与 EscapeJsSource 口径一致，
	 * 统一替换为 \uXXXX 等价转义，保证任意文本都能安全注入。
	 */
	FString QuoteJsString(const FString& Raw)
	{
		FString Escaped;
		Escaped.Reserve(Raw.Len() + 16);
		for (TCHAR Ch : Raw)
		{
			switch (Ch)
			{
			case TEXT('"'):
				Escaped += TEXT("\\\"");
				break;
			case TEXT('\\'):
				Escaped += TEXT("\\\\");
				break;
			case TEXT('\n'):
				Escaped += TEXT("\\n");
				break;
			case TEXT('\r'):
				Escaped += TEXT("\\r");
				break;
			case TEXT('\t'):
				Escaped += TEXT("\\t");
				break;
			case TEXT('\u2028'):
				Escaped += TEXT("\\u2028");
				break;
			case TEXT('\u2029'):
				Escaped += TEXT("\\u2029");
				break;
			default:
				Escaped += Ch;
				break;
			}
		}
		return FString::Printf(TEXT("\"%s\""), *Escaped);
	}

	/**
	 * 禁用 CEF 加速绘制（共享纹理），强制走软件位图路径（OnPaint）。
	 * 与设置面板共用同一处置：加速路径下 CEF 偶发回退软件 OnPaint，引擎随即
	 * 释放纹理重建、仅按脏矩形部分上传，未初始化区域会显示为彩色重影；
	 * 本面板虽不透明，但两面板共用进程级 CEF 配置，谁先创建浏览器都要先禁用。
	 * CanSupportAcceleratedPaint 在创建首个浏览器窗口时静态缓存该命令行参数，
	 * 必须在 SAssignNew(Browser, ...) 之前追加。
	 */
	void DisableCefAcceleratedPaint()
	{
		static bool bApplied = false;
		if (!bApplied && !FParse::Param(FCommandLine::Get(), TEXT("nocefaccelpaint")))
		{
			FCommandLine::Append(TEXT(" -nocefaccelpaint"));
			UE_LOG(LogPet, Log, TEXT("已禁用 CEF 加速绘制（-nocefaccelpaint），WebUI 面板改走软件位图路径以保证透明合成稳定"));
		}
		bApplied = true;
	}

	/**
	 * 校验弹窗 swapchain 是否已走 blit 模型（关闭 ALLOW_TEARING）。
	 * r.D3D11.UseAllowTearing 是 ECVF_ReadOnly 且在首个 FD3D11Viewport 构造时被锁存进
	 * 静态变量（引擎 WindowsD3D11Viewport.cpp），运行时 CVar->Set() 无效，必须写进
	 * DefaultEngine.ini 的 [SystemSettings]（GSystemSettings.Initialize 早于 RHIInit）在
	 * RHI 初始化前生效。此处只回读有效值并记日志：值为 0 表示 blit 已生效（弹窗 Host
	 * 的黑色色键 LWA_COLORKEY 可被 DWM 合成、透出桌面）；非 0 提示 ini 未生效、flip 交换链
	 * 下 DWM 不保证色键合成，设置面板透明区域可能显示为黑框。
	 * 与设置面板同一路由：两面板共用同一弹窗宿主，谁先创建都要先校验。
	 */
	void VerifyBlitSwapChainForLayeredWindows()
	{
		if (IConsoleVariable* CVar = IConsoleManager::Get().FindConsoleVariable(TEXT("r.D3D11.UseAllowTearing")))
		{
			const int32 Value = CVar->GetInt();
			if (Value == 0)
			{
				UE_LOG(LogPet, Log, TEXT("弹窗 blit swapchain 校验通过：r.D3D11.UseAllowTearing=0（DefaultEngine.ini [SystemSettings] 已生效）"));
			}
			else
			{
				UE_LOG(LogPet, Warning, TEXT("r.D3D11.UseAllowTearing=%d：ini 未生效或被运行时改写，弹窗可能走 flip 交换链，"
					"DWM 不保证色键合成，设置面板透明区域可能显示为黑框"), Value);
			}
		}
		else
		{
			UE_LOG(LogPet, Warning, TEXT("未找到 CVar r.D3D11.UseAllowTearing，无法校验弹窗 swapchain 模式"));
		}
	}
}

FPetSessionWebPanel::FPetSessionWebPanel()
	: Bridge(NewObject<UPetSessionWebBridge>(GetTransientPackage()))
{
}

FPetSessionWebPanel::~FPetSessionWebPanel()
{
	if (Browser.IsValid())
	{
		// 页面仍可能持有桥的 JS 引用；先摘除绑定再释放浏览器与桥，避免回调失效对象。
		Browser->UnbindUObject(TEXT("petbridge"), Bridge.Get(), true);
		Browser.Reset();
	}
	Bridge.Reset();
}

bool FPetSessionWebPanel::Create()
{
	if (Browser.IsValid())
	{
		return true;
	}

	DisableCefAcceleratedPaint();
	VerifyBlitSwapChainForLayeredWindows();

	// SWebBrowserView::Construct 只在 WebBrowser 模块已加载时才会创建 CEF 浏览器窗口，
	// 否则 BrowserWindow 为空、控件永远黑屏且无任何回调。Build.cs 的模块依赖不会触发
	// 运行时 StartupModule，必须在这里显式 Get()（即 LoadModuleChecked）完成加载与 CEF 初始化。
	if (!IWebBrowserModule::Get().IsWebModuleAvailable())
	{
		UE_LOG(LogPet, Error, TEXT("WebBrowser 模块不可用（CEF 加载失败），会话面板不可用"));
		return false;
	}

	FString Html;
	const FString HtmlPath = FPaths::ProjectContentDir() / TEXT("UI/Web/session-panel.html");
	if (!FFileHelper::LoadFileToString(Html, *HtmlPath) || Html.IsEmpty())
	{
		UE_LOG(LogPet, Warning, TEXT("读取 Web 会话面板 HTML 失败（%s），改用内嵌中文兜底页"), *HtmlPath);
		Html = EmbeddedFallbackHtml;
	}

	SAssignNew(Browser, SWebBrowser)
		.InitialURL(TEXT("about:blank"))
		.ShowControls(false)
		.ShowAddressBar(false)
		.ShowErrorMessage(false)
		.ShowInitialThrobber(false)
		.SupportsTransparency(false)
		.BackgroundColor(FColor(20, 22, 30, 255))
		.BrowserFrameRate(30)
		// SLATE_EVENT 的 (this,&Method) 绑定要求目标继承 TSharedFromThis，本面板由
		// TUniquePtr 独占持有，因此用 CreateRaw 直接绑定裸指针。
		.OnLoadCompleted(FSimpleDelegate::CreateRaw(this, &FPetSessionWebPanel::HandleLoadCompleted))
		.OnLoadError(FSimpleDelegate::CreateRaw(this, &FPetSessionWebPanel::HandleLoadError))
		.OnConsoleMessage(FOnConsoleMessageDelegate::CreateRaw(this, &FPetSessionWebPanel::HandleConsoleMessage));

	// LoadString 通过请求拦截把 HTML 注入 DummyURL 的响应。DummyURL 不能真实可达，
	// 也不用 .local（mDNS 保留后缀，拦截失效时 Chromium 解析会长时间挂起）。
	Browser->LoadString(Html, TEXT("http://kimipet/panel"));
	return true;
}

TSharedRef<SWidget> FPetSessionWebPanel::GetContentWidget() const
{
	return Browser.IsValid() ? Browser.ToSharedRef() : SNullWidget::NullWidget;
}

void FPetSessionWebPanel::HandleLoadCompleted()
{
	bPageLoaded = true;
	BindBridge();
	// 面板已可见时立即全量重放；隐藏（压栈）期间不下发，恢复可见时由
	// SetPanelVisible(true) 经 PushFullStateToPage 补齐。
	if (bPanelVisible)
	{
		PushFullStateToPage();
	}
	UE_LOG(LogPet, Log, TEXT("WebUI 会话面板页面加载完成，JS 桥与缓存快照已就绪"));
}

void FPetSessionWebPanel::PushFullStateToPage()
{
	ReplaySnapshot();
	// 与快照同口径：主题 / FPS 设置补发一次，避免页面加载期间或隐藏期间丢设置。
	if (!LastTheme.IsEmpty())
	{
		ExecutePanelScript(FString::Printf(
			TEXT("if (window.KimiPetPanel) { window.KimiPetPanel.setTheme(%s); }"),
			*QuoteJsString(LastTheme)));
	}
	// FPS 开关无条件按当前值补发：只推 true 会把「隐藏期被关掉」的状态漏成持续上报。
	ExecutePanelScript(FString::Printf(
		TEXT("if (window.KimiPetPanel) { window.KimiPetPanel.setFpsMonitor(%s); }"),
		bFpsMonitorEnabled ? TEXT("true") : TEXT("false")));
}

void FPetSessionWebPanel::HandleLoadError()
{
	// 说明加载失败的实际后果，便于现场排查：面板将保持空白、后续会话数据只入缓存
	// 不会上屏（UMG 路径已移除，无回退路径）。
	UE_LOG(LogPet, Error, TEXT("WebUI 会话面板页面加载失败（OnLoadError）：面板将保持空白，"
		"后续会话数据仅入缓存不会上屏"));
}

void FPetSessionWebPanel::HandleConsoleMessage(
	const FString& Message,
	const FString& Source,
	int32 Line,
	EWebBrowserConsoleLogSeverity Severity)
{
	UE_LOG(LogPet, Log, TEXT("WebUI 控制台 [%s:%d] %s"), *Source, Line, *Message);
}

void FPetSessionWebPanel::BindBridge()
{
	if (Browser.IsValid() && Bridge.IsValid())
	{
		// 对象挂到 JS 的 window.ue.petbridge，函数名小写：selectsession / closepanel。
		Browser->BindUObject(TEXT("petbridge"), Bridge.Get(), true);
	}
}

void FPetSessionWebPanel::ReplaySnapshot()
{
	if (Browser.IsValid())
	{
		ExecutePanelScript(FString::Printf(
			TEXT("if (window.KimiPetPanel) { window.KimiPetPanel.applySnapshot(%s); }"),
			*SessionsToJsArray(Sessions)));
	}
}

void FPetSessionWebPanel::ExecutePanelScript(const FString& Script) const
{
	// 页面未就绪或面板隐藏（压栈）期间不下发 JS：隐藏期 CEF 被 WasHidden(true) 停帧，
	// 此时注入的 DOM 变更会在恢复后按脏矩形重绘时损坏画面（圆角不透明 / 整板黑）。
	// 缓存由各 Setter 照常维护，恢复可见时由 SetPanelVisible(true) 全量重放补齐。
	if (!bPageLoaded || !bPanelVisible || !Browser.IsValid())
	{
		return;
	}
	Browser->ExecuteJavascript(Script);
}

void FPetSessionWebPanel::PublishChangesOnlyWhenReady(const FString& Script)
{
	if (bPageLoaded)
	{
		ExecutePanelScript(Script);
	}
}

FPetSessionInfo* FPetSessionWebPanel::FindSession(const FString& SessionId)
{
	return Sessions.FindByPredicate(
		[&SessionId](const FPetSessionInfo& Session)
		{
			return Session.SessionId == SessionId;
		});
}

void FPetSessionWebPanel::ApplySnapshot(const TArray<FPetSessionInfo>& InSessions)
{
	Sessions = InSessions;
	PublishChangesOnlyWhenReady(FString::Printf(
		TEXT("if (window.KimiPetPanel) { window.KimiPetPanel.applySnapshot(%s); }"),
		*SessionsToJsArray(InSessions)));
}

void FPetSessionWebPanel::AddOrUpdateSession(const FPetSessionInfo& Session)
{
	if (FPetSessionInfo* Existing = FindSession(Session.SessionId))
	{
		*Existing = Session;
	}
	else
	{
		Sessions.Add(Session);
	}
	PublishChangesOnlyWhenReady(FString::Printf(
		TEXT("if (window.KimiPetPanel) { window.KimiPetPanel.addOrUpdate(%s); }"),
		*SessionToJsObject(Session)));
}

void FPetSessionWebPanel::AddOrUpdateSession(
	const FString& SessionId,
	const FString& Title,
	const FString& Cwd,
	bool bActive)
{
	FPetSessionInfo Session;
	Session.SessionId = SessionId;
	Session.Title = Title;
	Session.Cwd = Cwd;
	Session.bActive = bActive;

	if (FPetSessionInfo* Existing = FindSession(SessionId))
	{
		// 与历史面板语义一致：轻量 session_start 更新保留已有 working/unread。
		Session.bWorking = Existing->bWorking;
		Session.bUnread = Existing->bUnread;
		*Existing = Session;
	}
	else
	{
		Sessions.Add(Session);
	}
	PublishChangesOnlyWhenReady(FString::Printf(
		TEXT("if (window.KimiPetPanel) { window.KimiPetPanel.addOrUpdate(%s); }"),
		*SessionToJsObject(Session)));
}

void FPetSessionWebPanel::RemoveSession(const FString& SessionId)
{
	Sessions.RemoveAll(
		[&SessionId](const FPetSessionInfo& Session)
		{
			return Session.SessionId == SessionId;
		});
	PublishChangesOnlyWhenReady(FString::Printf(
		TEXT("if (window.KimiPetPanel) { window.KimiPetPanel.removeSession(%s); }"),
		*QuoteJsString(SessionId)));
}

void FPetSessionWebPanel::SetSessionActive(const FString& SessionId, bool bActive)
{
	if (FPetSessionInfo* Session = FindSession(SessionId))
	{
		Session->bActive = bActive;
	}
	PublishChangesOnlyWhenReady(FString::Printf(
		TEXT("if (window.KimiPetPanel) { window.KimiPetPanel.setActive(%s, %s); }"),
		*QuoteJsString(SessionId),
		bActive ? TEXT("true") : TEXT("false")));
}

void FPetSessionWebPanel::UpdateSessionState(const FString& SessionId, bool bWorking, bool bUnread)
{
	if (FPetSessionInfo* Session = FindSession(SessionId))
	{
		Session->bWorking = bWorking;
		Session->bUnread = bUnread;
	}
	PublishChangesOnlyWhenReady(FString::Printf(
		TEXT("if (window.KimiPetPanel) { window.KimiPetPanel.updateState(%s, {\"working\":%s,\"unread\":%s}); }"),
		*QuoteJsString(SessionId),
		bWorking ? TEXT("true") : TEXT("false"),
		bUnread ? TEXT("true") : TEXT("false")));
}

void FPetSessionWebPanel::SetTheme(const FString& ThemeId)
{
	if (ThemeId.IsEmpty())
	{
		return;
	}
	LastTheme = ThemeId;
	// 页面未就绪时下拉丢弃；加载完成后由 HandleLoadCompleted 按 LastTheme 重放。
	PublishChangesOnlyWhenReady(FString::Printf(
		TEXT("if (window.KimiPetPanel) { window.KimiPetPanel.setTheme(%s); }"),
		*QuoteJsString(ThemeId)));
}

void FPetSessionWebPanel::SetFpsMonitor(bool bEnabled)
{
	bFpsMonitorEnabled = bEnabled;
	PublishChangesOnlyWhenReady(FString::Printf(
		TEXT("if (window.KimiPetPanel) { window.KimiPetPanel.setFpsMonitor(%s); }"),
		bEnabled ? TEXT("true") : TEXT("false")));
}

void FPetSessionWebPanel::SetPanelVisible(bool bVisible)
{
	bPanelVisible = bVisible;
	// 恢复可见且页面已就绪时全量重放：隐藏期间可能累积了快照 / 主题 / FPS 更新，
	// 一次补齐到页面（期间 CEF 停帧、JS 一概不下发）。
	if (bVisible && bPageLoaded)
	{
		PushFullStateToPage();
	}
}