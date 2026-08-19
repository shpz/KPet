#pragma once

#include "CoreMinimal.h"
#include "Templates/UniquePtr.h"
#include "UObject/StrongObjectPtr.h"

class SWebBrowser;
class SWidget;
class UPetSessionWebBridge;
struct FPetSessionInfo;
enum class EWebBrowserConsoleLogSeverity;

/**
 * WebUI 会话面板（PoC）。
 *
 * 用 SWebBrowser 加载 Content/UI/Web/session-panel.html，把 UMG 会话面板的
 * 数据 API 镜像为 C++ -> JS 调用（window.KimiPetPanel.*），并持有
 * UPetSessionWebBridge 供 JS -> C++ 回调。全部方法必须在游戏线程调用。
 *
 * 该面板只负责 Web 内容与数据收发，不创建 SWindow；窗口由
 * FPetSessionWindowHost 承载，与 UMG 回退路径共用同一宿主。
 */
class FPetSessionWebPanel
{
public:
	FPetSessionWebPanel();
	~FPetSessionWebPanel();

	/**
	 * 创建 SWebBrowser 并加载页面。HTML 读取失败时改用内嵌中文兜底页，不返回失败；
	 * 但 WebBrowser 模块不可用（CEF 加载失败）时返回 false，调用方需据此回退到 UMG 路径。
	 * 页面本身的加载结果由 OnLoadCompleted / OnLoadError 回调体现。
	 */
	bool Create();

	/** 返回 SWebBrowser 控件，交给 FPetSessionWindowHost 放入 SWindow。 */
	TSharedRef<SWidget> GetContentWidget() const;

	/** 供 Pawn 绑定桥的委托。裸指针生命周期随本面板，由 TStrongObjectPtr 保证。 */
	UPetSessionWebBridge* GetBridge() const { return Bridge.Get(); }

	/** 全量快照；直接替换本地缓存并重放。 */
	void ApplySnapshot(const TArray<FPetSessionInfo>& Sessions);

	/** 增量新增或更新会话。 */
	void AddOrUpdateSession(const FPetSessionInfo& Session);

	/** 兼容增量 session_start 的轻量重载；已有会话的 working/unread 会被保留。 */
	void AddOrUpdateSession(
		const FString& SessionId,
		const FString& Title,
		const FString& Cwd,
		bool bActive);

	void RemoveSession(const FString& SessionId);
	void SetSessionActive(const FString& SessionId, bool bActive);
	void UpdateSessionState(const FString& SessionId, bool bWorking, bool bUnread);

private:
	void HandleLoadCompleted();
	void HandleLoadError();
	void HandleConsoleMessage(
		const FString& Message,
		const FString& Source,
		int32 Line,
		EWebBrowserConsoleLogSeverity Severity);
	void BindBridge();
	void ReplaySnapshot();
	void ExecutePanelScript(const FString& Script) const;
	FPetSessionInfo* FindSession(const FString& SessionId);
	/** 页面加载完成前只更新缓存；完成后同时下发增量 JS。 */
	void PublishChangesOnlyWhenReady(const FString& Script);

	/** SWebBrowser 控件本体。 */
	TSharedPtr<SWebBrowser> Browser;

	/** JS 桥；TStrongObjectPtr 防止桥被 GC，绑定期间必须存活。 */
	TStrongObjectPtr<UPetSessionWebBridge> Bridge;

	/** 最近一次全量快照；页面重载后用于重放。 */
	TArray<FPetSessionInfo> Sessions;

	/** 页面 OnLoadCompleted 是否已经触发。 */
	bool bPageLoaded = false;
};