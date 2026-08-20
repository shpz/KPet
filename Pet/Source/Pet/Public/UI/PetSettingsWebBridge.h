#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"

#include "PetSettingsWebBridge.generated.h"

/** JS 侧修改打开会话方式（open_target='cli'|'web'）时触发。 */
DECLARE_MULTICAST_DELEGATE_OneParam(FPetSettingsWebBridgeOpenTargetChanged, const FString& /* Target */);

/** JS 侧切换面板主题（themeId）时触发。 */
DECLARE_MULTICAST_DELEGATE_OneParam(FPetSettingsWebBridgeThemeChanged, const FString& /* ThemeId */);

/** JS 侧切换 FPS 显示开关时触发。 */
DECLARE_MULTICAST_DELEGATE_OneParam(FPetSettingsWebBridgeFpsMonitorChanged, bool /* bEnabled */);

/** JS 侧点击设置面板关闭按钮时触发；由 FPetSessionWindowHost::Close 绑定。 */
DECLARE_MULTICAST_DELEGATE(FPetSettingsWebBridgeCloseSettings);

/** JS 侧每秒上报 WebUI 帧率时触发。 */
DECLARE_MULTICAST_DELEGATE_OneParam(FPetSettingsWebBridgeFpsReported, int32 /* Fps */);

/**
 * 暴露给设置 Web 面板 JS 的 UObject 桥。
 *
 * 通过 SWebBrowser::BindUObject(TEXT("petsettings"), this) 挂到页面 JS 的
 * window.ue.petsettings 下。五个 UFUNCTION 由 JS 直接调用，内部只转发原生多播
 * 委托，不持有窗口、通信或 Pawn 引用，保证数据流单向。
 *
 * JS 侧调用形式（与 UPetSessionWebBridge 同一约定，见其头文件注释）：
 *  - 对象挂在 window.ue 下，绑定的对象名、函数名、属性名在 JS 侧一律小写
 *    （bJSBindingsToLoweringEnabled 默认开启，UE_5.8 为 true）；
 *  - 因此本类的 UFUNCTION 名 SetOpenTarget / SetTheme / SetFpsMonitor /
 *    CloseSettings / ReportFps 在 JS 侧调用为 window.ue.petsettings 的
 *    setopentarget(target) / settheme(themeId) / setfpsmonitor(bool) /
 *    closesettings() / reportfps(n)；
 *  - 均为 void 无返回，JS 侧直接调用即可（settings.html 的 callBridge 按
 *    大小写不敏感查找，兼容两种暴露形式）。
 */
UCLASS()
class PET_API UPetSettingsWebBridge : public UObject
{
	GENERATED_BODY()

public:
	/** 转发 JS setopentarget 调用的打开目标修改。 */
	UFUNCTION()
	void SetOpenTarget(const FString& Target);

	/** 转发 JS settheme 调用的主题切换。 */
	UFUNCTION()
	void SetTheme(const FString& ThemeId);

	/** 转发 JS setfpsmonitor 调用的 FPS 显示开关。 */
	UFUNCTION()
	void SetFpsMonitor(bool bEnabled);

	/** 转发 JS closesettings 调用的关闭请求。 */
	UFUNCTION()
	void CloseSettings();

	/** 转发 JS reportfps 调用的 WebUI 帧率上报。 */
	UFUNCTION()
	void ReportFps(int32 Fps);

	/** 打开目标修改原生委托。 */
	FPetSettingsWebBridgeOpenTargetChanged OnSetOpenTarget;

	/** 主题切换原生委托。 */
	FPetSettingsWebBridgeThemeChanged OnSetTheme;

	/** FPS 显示开关原生委托。 */
	FPetSettingsWebBridgeFpsMonitorChanged OnSetFpsMonitor;

	/** 关闭请求原生委托。 */
	FPetSettingsWebBridgeCloseSettings OnCloseSettings;

	/** WebUI 帧率上报原生委托。 */
	FPetSettingsWebBridgeFpsReported OnReportFps;
};
