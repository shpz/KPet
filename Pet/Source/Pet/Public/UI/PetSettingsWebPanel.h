#pragma once

#include "CoreMinimal.h"
#include "Templates/UniquePtr.h"
#include "UObject/StrongObjectPtr.h"

class SWebBrowser;
class SWidget;
class UPetSettingsWebBridge;
struct FPetSettingsSnapshot;
enum class EWebBrowserConsoleLogSeverity;

/**
 * WebUI 设置面板。
 *
 * 用 SWebBrowser 加载 Content/UI/Web/settings.html，把设置快照镜像为
 * C++ -> JS 调用（window.KimiPetSettings.applySettings），并持有
 * UPetSettingsWebBridge 供 JS -> C++ 回调。全部方法必须在游戏线程调用。
 *
 * 与 FPetSessionWebPanel 对称：面板只负责 Web 内容与数据收发，不创建 SWindow；
 * 窗口由 FPetSessionWindowHost 承载（设置面板同样仅此一条路径）。
 */
class FPetSettingsWebPanel
{
public:
	FPetSettingsWebPanel();
	~FPetSettingsWebPanel();

	/**
	 * 创建 SWebBrowser 并加载页面。HTML 读取失败时改用内嵌中文兜底页，不返回失败；
	 * 但 WebBrowser 模块不可用（CEF 加载失败）时返回 false，设置面板即不可用。
	 * 页面本身的加载结果由 OnLoadCompleted / OnLoadError 回调体现。
	 */
	bool Create();

	/** 返回 SWebBrowser 控件，交给 FPetSessionWindowHost 放入 SWindow。 */
	TSharedRef<SWidget> GetContentWidget() const;

	/** 供 Pawn 绑定桥的委托。裸指针生命周期随本面板，由 TStrongObjectPtr 保证。 */
	UPetSettingsWebBridge* GetBridge() const { return Bridge.Get(); }

	/**
	 * 全量设置快照；页面未加载完成前只缓存，加载完成后同时下发，保证打开时状态最新。
	 */
	void ApplySnapshot(const FPetSettingsSnapshot& Snapshot);

	/** 面板显隐通知：隐藏（压栈）期间快照只入缓存，恢复可见时按缓存重放。 */
	void SetPanelVisible(bool bVisible);

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

	/** SWebBrowser 控件本体。 */
	TSharedPtr<SWebBrowser> Browser;

	/** JS 桥；TStrongObjectPtr 防止桥被 GC，绑定期间必须存活。 */
	TStrongObjectPtr<UPetSettingsWebBridge> Bridge;

	/** 最近一次全量快照；页面重载或打开前用于重放。 */
	TSharedPtr<FPetSettingsSnapshot> CachedSnapshot;

	/** 页面 OnLoadCompleted 是否已经触发。 */
	bool bPageLoaded = false;

	/** 面板是否可见（非隐藏 / 压栈）。初始为隐藏，控制 CEF JS 下发闸门。 */
	bool bPanelVisible = false;
};
