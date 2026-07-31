#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "SpikeCaptureActor.generated.h"

class USceneCaptureComponent2D;
class UStaticMeshComponent;
class UPointLightComponent;
class UTextureRenderTarget2D;
class FRHIGPUTextureReadback;
class FLayeredPetWindow;

/**
 * 方案一验证 Actor：
 * 球体 + 点光源 → 场景捕获组件输出到 320x320 BGRA8 RT（背景应全透明）
 * → FRHIGPUTextureReadback 异步回读（取上一帧，延迟 1 帧）
 * → 预乘转换 → UpdateLayeredWindow 上屏到自建分层窗口。
 * 同时隐藏 UE 游戏窗口，验证窗口隐藏后场景捕获是否持续更新。
 */
UCLASS()
class ASpikeCaptureActor : public AActor
{
	GENERATED_BODY()

public:
	ASpikeCaptureActor();
	virtual ~ASpikeCaptureActor() override;

	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void Tick(float DeltaTime) override;

private:
	void OnFrameReady(TSharedRef<TArray<uint8>> Pixels);
	void HideGameWindow();

	UPROPERTY()
	USceneComponent* RootComp = nullptr;

	UPROPERTY()
	UStaticMeshComponent* Sphere = nullptr;

	UPROPERTY()
	UPointLightComponent* Light = nullptr;

	UPROPERTY()
	USceneCaptureComponent2D* Capture = nullptr;

	UPROPERTY()
	UTextureRenderTarget2D* RenderTarget = nullptr;

	FRHIGPUTextureReadback* Readback = nullptr;      // 仅渲染线程访问
	std::atomic<bool> bCopyInFlight{ false };        // 仅渲染线程写，游戏线程不依赖其值做决策

	FLayeredPetWindow* PetWindow = nullptr; // new/delete 手动管理，避免前置声明类型被 UHT 生成代码实例化
	int32 PresentedFrames = 0;

	static constexpr int32 RTSize = 320;
};
