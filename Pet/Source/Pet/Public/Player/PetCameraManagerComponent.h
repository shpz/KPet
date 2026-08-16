#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "Player/PetWorkState.h"
#include "PetCameraManagerComponent.generated.h"

class USceneCaptureComponent2D;
class UPetSceneSlotComponent;

/** 管理状态基准位置、玩家旋转偏移和缩放。 */
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

	/** 在蓝图默认值已经应用后记录 Idle 默认位置，并读取 Working 摄像机插槽。 */
	void Initialize(
		USceneCaptureComponent2D* InCapture,
		const UPetSceneSlotComponent* InSceneSlots = nullptr);
	void SetPetState(EPetWorkState NewState);
	void AddRotationInput(float DeltaX, float DeltaY);
	void AddZoomInput(float WheelDelta);

	UFUNCTION(BlueprintPure, Category = "摄像机")
	float GetCurrentStateYaw() const { return CurrentStateYaw; }

	UFUNCTION(BlueprintPure, Category = "摄像机")
	FVector GetCurrentStateLocation() const { return CurrentStateLocation; }

private:
	void ApplyCameraTransform();
	void BeginStateTransition(const FVector& NewTargetLocation);

	UPROPERTY(Transient)
	TObjectPtr<USceneCaptureComponent2D> Capture = nullptr;

	/** 兼容旧蓝图；未配置 Working 摄像机插槽时生成后备位置。 */
	UPROPERTY()
	float WorkingYawOffset = 45.0f;

	/** 完整状态切换的时长；中途反向按剩余距离同比缩短。 */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "摄像机|状态", meta = (AllowPrivateAccess = "true", ClampMin = "0.0"))
	float StateTransitionDuration = 0.8f;

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

	FVector DefaultCameraRelativeLocation = FVector(-350.0f, 0.0f, 0.0f);
	FVector WorkingCameraRelativeLocation = FVector(-350.0f, 0.0f, 0.0f);
	FVector CurrentStateLocation = FVector(-350.0f, 0.0f, 0.0f);
	FVector TransitionStartLocation = FVector(-350.0f, 0.0f, 0.0f);
	FVector TransitionTargetLocation = FVector(-350.0f, 0.0f, 0.0f);
	float PlayerYawOffset = 0.0f;
	float PlayerPitchOffset = 0.0f;
	float PlayerDistanceOffset = 0.0f;
	float CurrentStateYaw = 0.0f;
	float TransitionElapsed = 0.0f;
	float ActiveTransitionDuration = 0.0f;
	bool bInitialized = false;
};
