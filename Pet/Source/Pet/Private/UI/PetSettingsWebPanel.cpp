#include "UI/PetSettingsWebPanel.h"

#include "Pet.h"
#include "Communication/PetSessionTypes.h"
#include "UI/PetSettingsWebBridge.h"

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
		TEXT("<p>设置面板加载失败</p>")
		TEXT("<p style=\"color:#8a90a3;font-size:12px;\">无法读取 Content/UI/Web/settings.html</p>")
		TEXT("</div></body></html>");

	/** 把配置快照转成与 JS 契约一致的 FJsonObject（snake_case 字段、布尔原值）。 */
	TSharedRef<FJsonObject> SettingsSnapshotToJson(const FPetSettingsSnapshot& Snapshot)
	{
		TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
		Json->SetStringField(TEXT("open_target"), Snapshot.OpenTarget);
		Json->SetStringField(TEXT("open_web_url"), Snapshot.OpenWebUrl);
		Json->SetStringField(TEXT("ui_theme"), Snapshot.UiTheme);
		Json->SetBoolField(TEXT("fps_monitor"), Snapshot.bFpsMonitor);
		return Json;
	}

	/**
	 * JSON 文本直接作为 JS 对象字面量注入 ExecuteJavascript。
	 * U+2028/U+2029 在 JSON 中合法，但作为 JS 源码字面量时旧引擎会当行分隔符，
	 * 统一替换为 \uXXXX 等价转义（与会话面板同一口径）。
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
		FJsonSerializer::Serialize(Value, FString(), Writer);
		return EscapeJsSource(JsonText);
	}

	/** 设置快照 -> JS 对象字面量文本（applySettings 的入参）。 */
	FString SettingsSnapshotToJsObject(const FPetSettingsSnapshot& Snapshot)
	{
		return WriteJsonAsJsSource(MakeShared<FJsonValueObject>(SettingsSnapshotToJson(Snapshot)));
	}

	/**
	 * 禁用 CEF 加速绘制（共享纹理），强制走软件位图路径（OnPaint）。
	 * 加速路径的共享纹理输出没有 alpha，本面板的透明卡片外区域会渲染成黑框；
	 * 且密集重绘（如连切主题）时 CEF 偶发回退软件 OnPaint，引擎随即释放纹理
	 * 重建、仅按脏矩形部分上传，未初始化区域显示为彩色重影，两个模式来回
	 * 切换导致透明时好时坏。CanSupportAcceleratedPaint 在创建首个浏览器窗口时
	 * 静态缓存该命令行参数，必须在 SAssignNew(Browser, ...) 之前追加。
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

FPetSettingsWebPanel::FPetSettingsWebPanel()
	: Bridge(NewObject<UPetSettingsWebBridge>(GetTransientPackage()))
{
}

FPetSettingsWebPanel::~FPetSettingsWebPanel()
{
	if (Browser.IsValid())
	{
		// 页面仍可能持有桥的 JS 引用；先摘除绑定再释放浏览器与桥，避免回调失效对象。
		Browser->UnbindUObject(TEXT("petsettings"), Bridge.Get(), true);
		Browser.Reset();
	}
	Bridge.Reset();
}

bool FPetSettingsWebPanel::Create()
{
	if (Browser.IsValid())
	{
		return true;
	}

	DisableCefAcceleratedPaint();
	VerifyBlitSwapChainForLayeredWindows();

	if (!IWebBrowserModule::Get().IsWebModuleAvailable())
	{
		UE_LOG(LogPet, Error, TEXT("WebBrowser 模块不可用（CEF 加载失败），设置面板不可用"));
		return false;
	}

	FString Html;
	const FString HtmlPath = FPaths::ProjectContentDir() / TEXT("UI/Web/settings.html");
	if (!FFileHelper::LoadFileToString(Html, *HtmlPath) || Html.IsEmpty())
	{
		UE_LOG(LogPet, Warning, TEXT("读取 Web 设置面板 HTML 失败（%s），改用内嵌中文兜底页"), *HtmlPath);
		Html = EmbeddedFallbackHtml;
	}

	SAssignNew(Browser, SWebBrowser)
		.InitialURL(TEXT("about:blank"))
		.ShowControls(false)
		.ShowAddressBar(false)
		.ShowErrorMessage(false)
		.ShowInitialThrobber(false)
		// settings.html 的 html/body 全透明、仅圆角卡片有底色，浏览器必须支持透明背景：
		// 卡片外区域以透明像素上屏，配合 Host 侧强制 blit 的 swapchain 与色键/逐像素 alpha
		// （见 FPetSessionWindowHost::ApplyWindowOpacity）透出桌面。
		// 实测警告：若改为不透明合成（SupportsTransparency(false) + 黑底），色键不再抠除、
		// 卡片外区域呈现为整圈黑框——两条合成路径不要混用。
		.SupportsTransparency(true)
		.BackgroundColor(FColor(0, 0, 0, 0))
		.BrowserFrameRate(30)
		// SLATE_EVENT 的 (this,&Method) 绑定要求目标继承 TSharedFromThis，本面板由
		// TUniquePtr 独占持有，因此用 CreateRaw 直接绑定裸指针。
		.OnLoadCompleted(FSimpleDelegate::CreateRaw(this, &FPetSettingsWebPanel::HandleLoadCompleted))
		.OnLoadError(FSimpleDelegate::CreateRaw(this, &FPetSettingsWebPanel::HandleLoadError))
		.OnConsoleMessage(FOnConsoleMessageDelegate::CreateRaw(this, &FPetSettingsWebPanel::HandleConsoleMessage));

	// DummyURL 用独立路径避免与会话面板的请求拦截冲突；同样不能真实可达，也不用 .local。
	Browser->LoadString(Html, TEXT("http://kimipet/settings"));
	return true;
}

TSharedRef<SWidget> FPetSettingsWebPanel::GetContentWidget() const
{
	return Browser.IsValid() ? Browser.ToSharedRef() : SNullWidget::NullWidget;
}

void FPetSettingsWebPanel::HandleLoadCompleted()
{
	bPageLoaded = true;
	BindBridge();
	ReplaySnapshot();
	UE_LOG(LogPet, Log, TEXT("WebUI 设置面板页面加载完成，JS 桥与缓存快照已就绪"));
}

void FPetSettingsWebPanel::HandleLoadError()
{
	// 说明加载失败的实际后果，便于现场排查：面板将保持空白、快照只入缓存不上屏。
	UE_LOG(LogPet, Error, TEXT("WebUI 设置面板页面加载失败（OnLoadError）：面板将保持空白，"
		"后续设置快照仅入缓存不会上屏"));
}

void FPetSettingsWebPanel::HandleConsoleMessage(
	const FString& Message,
	const FString& Source,
	int32 Line,
	EWebBrowserConsoleLogSeverity Severity)
{
	UE_LOG(LogPet, Log, TEXT("设置面板控制台 [%s:%d] %s"), *Source, Line, *Message);
}

void FPetSettingsWebPanel::BindBridge()
{
	if (Browser.IsValid() && Bridge.IsValid())
	{
		// 对象挂到 JS 的 window.ue.petsettings，函数名小写：setopentarget / settheme /
		// setfpsmonitor / closesettings / reportfps（见 UPetSettingsWebBridge 注释）。
		Browser->BindUObject(TEXT("petsettings"), Bridge.Get(), true);
	}
}

void FPetSettingsWebPanel::ReplaySnapshot()
{
	if (Browser.IsValid() && CachedSnapshot.IsValid())
	{
		ExecutePanelScript(FString::Printf(
			TEXT("if (window.KimiPetSettings) { window.KimiPetSettings.applySettings(%s); }"),
			*SettingsSnapshotToJsObject(*CachedSnapshot)));
	}
}

void FPetSettingsWebPanel::ExecutePanelScript(const FString& Script) const
{
	// 页面未就绪或面板隐藏（压栈）期间不下发 JS：隐藏期 CEF 被 WasHidden(true) 停帧，
	// 注入 DOM 变更会在恢复后按脏矩形重绘时损坏画面（圆角不透明 / 整板黑）。
	// 恢复可见时由 SetPanelVisible(true) 按 CachedSnapshot 重放补齐。
	if (!bPageLoaded || !bPanelVisible || !Browser.IsValid())
	{
		return;
	}
	Browser->ExecuteJavascript(Script);
}

void FPetSettingsWebPanel::ApplySnapshot(const FPetSettingsSnapshot& Snapshot)
{
	CachedSnapshot = MakeShared<FPetSettingsSnapshot>(Snapshot);
	// 页面未就绪或面板隐藏（压栈）时只进缓存；恢复可见后由 SetPanelVisible(true) 重放。
	if (bPageLoaded && bPanelVisible)
	{
		ReplaySnapshot();
	}
}

void FPetSettingsWebPanel::SetPanelVisible(bool bVisible)
{
	bPanelVisible = bVisible;
	// 恢复可见且页面就绪且已有缓存快照时重放，保证打开时状态最新。
	if (bVisible && bPageLoaded && CachedSnapshot.IsValid())
	{
		ReplaySnapshot();
	}
}
