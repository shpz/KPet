#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "PetCapturePawn.generated.h"

class USceneCaptureComponent2D;
class UPointLightComponent;
class UTextureRenderTarget2D;
class FRHIGPUTextureReadback;
class PetLayeredWindow;
class FPetControlClient;

/**
 * 方案一渲染管线 Pawn：
 * 骨骼网格体 + 点光源 → 场景捕获组件输出到 320x320 BGRA8 RT（背景应全透明）
 * → FRHIGPUTextureReadback 异步回读（取上一帧，延迟 1 帧）
 * → 预乘转换 → UpdateLayeredWindow 上屏到自建分层窗口。
 * 非编辑器运行时隐藏 UE 游戏窗口，编辑器 PIE 调试时保留编辑器窗口。
 */
UCLASS()
class APetCapturePawn : public APawn
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
	void HideGameWindow();

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "组件", meta = (AllowPrivateAccess = "true"))
	USceneComponent* RootComp = nullptr;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "组件", meta = (AllowPrivateAccess = "true"))
	UPointLightComponent* Light = nullptr;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "组件", meta = (AllowPrivateAccess = "true"))
	USceneCaptureComponent2D* Capture = nullptr;

	UPROPERTY()
	UTextureRenderTarget2D* RenderTarget = nullptr;

	/** 分层窗口左上角在 Windows 虚拟桌面中的屏幕像素坐标，供动画蓝图计算使用。 */
	UPROPERTY(VisibleInstanceOnly, BlueprintReadOnly, Transient, Category = "窗口", meta = (AllowPrivateAccess = "true"))
	FIntPoint WindowScreenPosition = FIntPoint::ZeroValue;

	FRHIGPUTextureReadback* Readback = nullptr;      // 仅渲染线程访问
	std::atomic<bool> bCopyInFlight{ false };        // 仅渲染线程写，游戏线程不依赖其值做决策

	PetLayeredWindow* PetWindow = nullptr; // new/delete 手动管理，避免前置声明类型被 UHT 生成代码实例化
	int32 PresentedFrames = 0;
	bool bPresentedValidFrame = false; // 首个有效 capture 帧之前不 Present（避免零缓冲被上屏成黑方块）

	FPetControlClient* ControlClient = nullptr; // new/delete 手动管理（同 PetWindow）

	static constexpr int32 RTSize = 320;
};
