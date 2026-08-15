#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "Player/PetWorkState.h"
#include "PetCameraManagerComponent.generated.h"

class USceneCaptureComponent2D;

/** 管理状态基准视角、玩家旋转偏移和缩放。 */
UCLASS(ClassGroup = (Pet), meta = (BlueprintSpawnableComponent))
class PET_API UPetCameraManagerComponent : public UActorComponent
{
	GENERATED_BODY()

public:
	UPetCameraManagerComponent();

	virtual void TickComponent(
		float DeltaTime,
		ELevelTick TickType,
		FActorComponentTickFunction* ThisTickFunction) override;

	/** 在蓝图默认值已经应用后记录捕获组件的初始方向和距离。 */
	void Initialize(USceneCaptureComponent2D* InCapture);
	void SetPetState(EPetWorkState NewState);
	void AddRotationInput(float DeltaX, float DeltaY);
	void AddZoomInput(float WheelDelta);

	UFUNCTION(BlueprintPure, Category = "摄像机")
	float GetCurrentStateYaw() const { return CurrentStateYaw; }

private:
	void ApplyCameraTransform();
	void BeginStateTransition(float NewTargetYaw);

	UPROPERTY(Transient)
	TObjectPtr<USceneCaptureComponent2D> Capture = nullptr;

	/** Working 相对 Idle 基准视角的有符号水平角度；正负方向由蓝图最终调节。 */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "摄像机|状态", meta = (AllowPrivateAccess = "true", ClampMin = "-180.0", ClampMax = "180.0"))
	float WorkingYawOffset = 45.0f;

	/** 完整 45 度状态切换的时长；中途反向按剩余角度同比缩短。 */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "摄像机|状态", meta = (AllowPrivateAccess = "true", ClampMin = "0.0"))
	float StateTransitionDuration = 0.35f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "摄像机|玩家输入", meta = (AllowPrivateAccess = "true", ClampMin = "0.0", ClampMax = "90.0", UIMin = "0.0", UIMax = "60.0"))
	float CameraYawLimit = 30.0f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "摄像机|玩家输入", meta = (AllowPrivateAccess = "true", ClampMin = "0.0", ClampMax = "60.0", UIMin = "0.0", UIMax = "45.0"))
	float CameraPitchLimit = 18.0f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "摄像机|玩家输入", meta = (AllowPrivateAccess = "true", ClampMin = "0.01", ClampMax = "1.0"))
	float CameraRotateSensitivity = 0.16f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "摄像机|玩家输入", meta = (AllowPrivateAccess = "true", ClampMin = "50.0"))
	float CameraMinDistance = 260.0f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "摄像机|玩家输入", meta = (AllowPrivateAccess = "true", ClampMin = "50.0"))
	float CameraMaxDistance = 480.0f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "摄像机|玩家输入", meta = (AllowPrivateAccess = "true", ClampMin = "1.0"))
	float CameraZoomStep = 24.0f;

	FVector InitialCameraDirection = FVector(-1.0f, 0.0f, 0.0f);
	float CameraDistance = 350.0f;
	float PlayerYawOffset = 0.0f;
	float PlayerPitchOffset = 0.0f;
	float CurrentStateYaw = 0.0f;
	float TransitionStartYaw = 0.0f;
	float TransitionTargetYaw = 0.0f;
	float TransitionElapsed = 0.0f;
	float ActiveTransitionDuration = 0.0f;
	bool bInitialized = false;
};
