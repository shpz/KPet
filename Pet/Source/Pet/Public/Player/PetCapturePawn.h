#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "UObject/SoftObjectPtr.h"
#include "PetCapturePawn.generated.h"

class USceneCaptureComponent2D;
class UTextureRenderTarget2D;
class FRHIGPUTextureReadback;
class PetLayeredWindow;
class FPetControlClient;
class FPetSessionWindowHost;
class UPetSessionPanelWidget;

/**
 * 方案一渲染管线 Pawn：
 * 骨骼网格体 + 关卡灯光 → 场景捕获组件输出到 320x320 BGRA8 RT（背景应全透明）
 * → FRHIGPUTextureReadback 异步回读（取上一帧，延迟 1 帧）
 * → 预乘转换 → UpdateLayeredWindow 上屏到自建分层窗口。
 * 默认 UE 游戏窗口由 FPetModule 的纯 Slate 启动守卫隐藏，编辑器 PIE 不受影响。
 */
UCLASS()
class PET_API APetCapturePawn : public APawn
{
	GENERATED_BODY()

public:
	APetCapturePawn();
	virtual ~APetCapturePawn() override;

	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void Tick(float DeltaTime) override;

private:
	void OnFrameReady(TSharedRef<TArray<uint8>> Pixels);
	void AdjustCameraRotation(float DeltaX, float DeltaY);
	void AdjustCameraZoom(float WheelDelta);
	void ApplyCameraTransform();
	void InitializeSessionPanel();
	void ShutdownSessionPanel();
	void UpdateSessionPanelAnchor();
	void ReplaySessionPanelPresentation();
	void HandleSessionSelected(const FString& SessionId);

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "组件", meta = (AllowPrivateAccess = "true"))
	USceneComponent* RootComp = nullptr;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "组件", meta = (AllowPrivateAccess = "true"))
	USceneCaptureComponent2D* Capture = nullptr;

	UPROPERTY()
	UTextureRenderTarget2D* RenderTarget = nullptr;

	/** 会话面板的 UMG Blueprint 类；由 BP_PetCapturePawn 配置软引用并参与 Cook。 */
	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "会话面板", meta = (AllowPrivateAccess = "true"))
	TSoftClassPtr<UPetSessionPanelWidget> SessionPanelWidgetClass;

	/** 由 Pawn 强引用持有，避免 SWindow 中的 SObjectWidget 指向已回收对象。 */
	UPROPERTY(Transient)
	TObjectPtr<UPetSessionPanelWidget> SessionPanelWidget = nullptr;

	/** 摄像机相对初始方向的最大水平旋转角度。 */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "摄像机调整", meta = (AllowPrivateAccess = "true", ClampMin = "0.0", ClampMax = "90.0", UIMin = "0.0", UIMax = "60.0"))
	float CameraYawLimit = 30.0f;

	/** 摄像机相对初始方向的最大垂直旋转角度。 */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "摄像机调整", meta = (AllowPrivateAccess = "true", ClampMin = "0.0", ClampMax = "60.0", UIMin = "0.0", UIMax = "45.0"))
	float CameraPitchLimit = 18.0f;

	/** 鼠标每移动一个像素对应的旋转角度。 */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "摄像机调整", meta = (AllowPrivateAccess = "true", ClampMin = "0.01", ClampMax = "1.0"))
	float CameraRotateSensitivity = 0.16f;

	/** 摄像机允许靠近 Pawn 的最近距离。 */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "摄像机调整", meta = (AllowPrivateAccess = "true", ClampMin = "50.0"))
	float CameraMinDistance = 260.0f;

	/** 摄像机允许远离 Pawn 的最远距离。 */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "摄像机调整", meta = (AllowPrivateAccess = "true", ClampMin = "50.0"))
	float CameraMaxDistance = 480.0f;

	/** 每格滚轮改变的摄像机距离。 */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "摄像机调整", meta = (AllowPrivateAccess = "true", ClampMin = "1.0"))
	float CameraZoomStep = 24.0f;

	/** 分层窗口左上角在 Windows 虚拟桌面中的屏幕像素坐标，供动画蓝图计算使用。 */
	UPROPERTY(VisibleInstanceOnly, BlueprintReadOnly, Transient, Category = "窗口", meta = (AllowPrivateAccess = "true"))
	FIntPoint WindowScreenPosition = FIntPoint::ZeroValue;

	FRHIGPUTextureReadback* Readback = nullptr;      // 仅渲染线程访问
	std::atomic<bool> bCopyInFlight{ false };        // 仅渲染线程写，游戏线程不依赖其值做决策

	PetLayeredWindow* PetWindow = nullptr; // new/delete 手动管理，避免前置声明类型被 UHT 生成代码实例化
	int32 PresentedFrames = 0;
	bool bPresentedValidFrame = false; // 首个有效 capture 帧之前不 Present（避免零缓冲被上屏成黑方块）

	FPetControlClient* ControlClient = nullptr; // new/delete 手动管理（同 PetWindow）
	FPetSessionWindowHost* SessionWindowHost = nullptr; // 跨平台 Slate 窗口宿主，生命周期由 Pawn 管理
	bool bSessionPanelTogglePending = false; // 原生窗口回调只置位，由游戏线程 Tick 安全切换 Slate 窗口
	bool bSessionPanelPresentationPending = false; // 显示后下一帧重播 UMG 动画，确保条目已进入可见列表
	FVector InitialCameraDirection = FVector(-1.0f, 0.0f, 0.0f);
	float CameraYaw = 0.0f;
	float CameraPitch = 0.0f;
	float CameraDistance = 350.0f;

	static constexpr int32 RTSize = 320;
};
