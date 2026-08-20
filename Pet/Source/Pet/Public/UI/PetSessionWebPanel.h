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
 * WebUI 会话面板。
 *
 * 用 SWebBrowser 加载 Content/UI/Web/session-panel.html，把会话面板的
 * 数据 API 镜像为 C++ -> JS 调用（window.KimiPetPanel.*），并持有
 * UPetSessionWebBridge 供 JS -> C++ 回调。全部方法必须在游戏线程调用。
 *
 * 该面板只负责 Web 内容与数据收发，不创建 SWindow；窗口由
 * FPetSessionWindowHost 承载（UMG 路径已移除，会话面板仅此一条路径）。
 */
class FPetSessionWebPanel
{
public:
	FPetSessionWebPanel();
	~FPetSessionWebPanel();

	/**
	 * 创建 SWebBrowser 并加载页面。HTML 读取失败时改用内嵌中文兜底页，不返回失败；
	 * 但 WebBrowser 模块不可用（CEF 加载失败）时返回 false，会话面板即不可用
	 *（UMG 路径已移除，无回退）。页面本身的加载结果由 OnLoadCompleted / OnLoadError 回调体现。
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

	/** 切换主题（三主题之一），页面加载完成前缓存、完成后重放。 */
	void SetTheme(const FString& ThemeId);

	/** 启停 Web 页面 FPS 上报（config_snapshot / 设置回调下发）。 */
	void SetFpsMonitor(bool bEnabled);

	/**
	 * 面板显隐通知：隐藏（压栈）期间 JS 一律不下发、缓存照常更新。恢复可见时只标记
	 * 待重放，等待窗口宿主确认 CEF 表面已从隐藏态恢复后再提交。
	 */
	void SetPanelVisible(bool bVisible);

	/** 窗口宿主在 ShowWindow 后的 CEF 预热完成时调用；触发一次积压状态的全量重放。 */
	void NotifyWindowSurfaceReady();

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
	/** 页面就绪后向页面全量重放（快照 + 主题 + FPS 开关）；面板隐藏期间不发送。 */
	void PushFullStateToPage();
	/** 页面、窗口表面和可见状态均就绪时才执行一次待处理的全量重放。 */
	void TryPushPendingFullState();
	void ExecutePanelScript(const FString& Script) const;
	FPetSessionInfo* FindSession(const FString& SessionId);
	/** 页面加载完成且面板可见时才下发增量 JS；未就绪或隐藏（压栈）时只更新缓存。 */
	void PublishChangesOnlyWhenReady(const FString& Script);

	/** SWebBrowser 控件本体。 */
	TSharedPtr<SWebBrowser> Browser;

	/** JS 桥；TStrongObjectPtr 防止桥被 GC，绑定期间必须存活。 */
	TStrongObjectPtr<UPetSessionWebBridge> Bridge;

	/** 最近一次全量快照；页面重载后用于重放。 */
	TArray<FPetSessionInfo> Sessions;

	/** 页面 OnLoadCompleted 是否已经触发。 */
	bool bPageLoaded = false;

	/** 面板是否可见（非隐藏 / 压栈）。初始为隐藏，控制 CEF JS 下发闸门。 */
	bool bPanelVisible = false;

	/** 当前可见周期的 CEF 软件表面是否已完成宿主预热。 */
	bool bWindowSurfaceReady = false;

	/** 当前可见周期需要补发快照、主题、FPS 与整页刷新。 */
	bool bFullStateReplayPending = false;

	/** 最近一次主题；页面加载完成后重放（避免加载期间丢失设置）。 */
	FString LastTheme;

	/** 最近一次 FPS 上报开关；页面加载完成后重放。 */
	bool bFpsMonitorEnabled = false;
};
