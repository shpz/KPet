#include "UI/PetSessionWebPanel.h"

#include "Pet.h"
#include "Communication/PetSessionTypes.h"
#include "UI/PetSessionWebBridge.h"

#include "Dom/JsonObject.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/Package.h"
#include "UObject/UObjectGlobals.h"
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

	/** 任意字符串 -> 带双引号的 JS 字符串字面量。 */
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
			default:
				Escaped += Ch;
				break;
			}
		}
		return FString::Printf(TEXT("\"%s\""), *Escaped);
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
		.OnLoadCompleted(FSimpleDelegate::CreateRaw(this, &FPetSessionWebPanel::HandleLoadCompleted));

	Browser->LoadString(Html, TEXT("http://kimipet.local/panel"));
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
	ReplaySnapshot();
	UE_LOG(LogPet, Log, TEXT("WebUI 会话面板页面加载完成，JS 桥与缓存快照已就绪"));
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
	if (Browser.IsValid())
	{
		Browser->ExecuteJavascript(Script);
	}
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
		// 与 UMG 面板语义一致：轻量 session_start 更新保留已有 working/unread。
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