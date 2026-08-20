#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"

#include "PetSessionWebBridge.generated.h"

/**
 * JS 侧选择会话时触发；参数为 SessionId。
 *
 * 由 FPetSessionWebPanel 调用方（APetCapturePawn）绑定。
 */
DECLARE_MULTICAST_DELEGATE_OneParam(FPetSessionWebBridgeSelection, const FString& /* SessionId */);

/** JS 侧点击面板关闭按钮时触发；由 FPetSessionWindowHost::Close 绑定。 */
DECLARE_MULTICAST_DELEGATE(FPetSessionWebBridgeCloseRequest);

/** JS 侧每秒上报 WebUI 帧率时触发（会话面板与设置面板都上报，Pawn 取最近值）。 */
DECLARE_MULTICAST_DELEGATE_OneParam(FPetSessionWebBridgeFpsReported, int32 /* Fps */);

/**
 * 暴露给 Web 面板 JS 的 UObject 桥。
 *
 * 通过 SWebBrowser::BindUObject(TEXT("petbridge"), this) 挂到页面 JS 的
 * window.ue.petbridge 下。两个 UFUNCTION 由 JS 直接调用，内部只转发原生多播
 * 委托，不持有窗口、通信或 Pawn 引用，保证数据流单向。
 *
 * JS 侧调用形式（引擎 WebBrowser 模块的既有约定，见 SWebBrowser.h 的 BindUObject
 * 注释与 WebJSScripting::GetBindingName）：
 *  - 对象挂在 window.ue 下（CEF 路径由渲染进程处理 UE::SetValue 消息挂载）；
 *  - 绑定的对象名、函数名、属性名在 JS 侧一律小写（bJSBindingsToLoweringEnabled
 *    在 WebBrowserSingleton 中默认开启，UE_5.8 为 true）；
 *  - 因此本类的 UFUNCTION 名 SelectSession / ClosePanel / ReportFps 在 JS 侧调用为
 *    window.ue.petbridge.selectsession(sessionId) / window.ue.petbridge.closepanel() /
 *    window.ue.petbridge.reportfps(n)；
 *  - 有返回值的 UFUNCTION 在 JS 侧包装成引擎的 Future（Promise 式异步获取），
 *    本类所有函数均为 void，JS 侧直接调用即可，返回值由回调机制异步回送。
 */
UCLASS()
class PET_API UPetSessionWebBridge : public UObject
{
	GENERATED_BODY()

public:
	/** 转发 JS selectsession 调用的会话选择。 */
	UFUNCTION()
	void SelectSession(const FString& SessionId);

	/** 转发 JS closepanel 调用的关闭请求。 */
	UFUNCTION()
	void ClosePanel();

	/** 转发 JS reportfps 调用的 WebUI 帧率上报。 */
	UFUNCTION()
	void ReportFps(int32 Fps);

	/** 会话选择原生委托。 */
	FPetSessionWebBridgeSelection OnSelectSession;

	/** 关闭请求原生委托。 */
	FPetSessionWebBridgeCloseRequest OnCloseRequested;

	/** WebUI 帧率上报原生委托。 */
	FPetSessionWebBridgeFpsReported OnReportFps;
};