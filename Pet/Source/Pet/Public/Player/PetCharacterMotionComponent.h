#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "Player/PetWorkState.h"
#include "PetCharacterMotionComponent.generated.h"

class USkeletalMeshComponent;

/** 小电脑相对业务状态的内部呈现阶段。 */
UENUM(BlueprintType)
enum class EPetPresentationPhase : uint8
{
	HiddenStable UMETA(DisplayName = "Hidden Stable"),
	Entering UMETA(DisplayName = "Entering"),
	WorkingStable UMETA(DisplayName = "Working Stable"),
	Exiting UMETA(DisplayName = "Exiting")
};

/** 管理小电脑相对位置、可见性、呈现门控和 BodyLean。 */
UCLASS(ClassGroup = (Pet), meta = (BlueprintSpawnableComponent))
class PET_API UPetCharacterMotionComponent : public UActorComponent
{
	GENERATED_BODY()

public:
	UPetCharacterMotionComponent();

	virtual void TickComponent(
		float DeltaTime,
		ELevelTick TickType,
		FActorComponentTickFunction* ThisTickFunction) override;

	/** 在蓝图组件变换已经应用后记录 Working 默认相对位置。 */
	void Initialize(USkeletalMeshComponent* InPetMesh, USkeletalMeshComponent* InComputerMesh);
	void SetPetState(EPetWorkState NewState);

	UFUNCTION(BlueprintPure, Category = "角色运动")
	float GetBodyLean() const { return BodyLean; }

	UFUNCTION(BlueprintPure, Category = "角色运动")
	bool IsWorkPresentationActive() const { return bWorkPresentationActive; }

	UFUNCTION(BlueprintPure, Category = "角色运动")
	EPetPresentationPhase GetPresentationPhase() const { return PresentationPhase; }

private:
	void UpdateMovingPhase(float DeltaTime, bool bEntering);
	void CompleteEntering();
	void CompleteExiting();

	UPROPERTY(Transient)
	TObjectPtr<USkeletalMeshComponent> PetMesh = nullptr;

	UPROPERTY(Transient)
	TObjectPtr<USkeletalMeshComponent> ComputerMesh = nullptr;

	/** 小电脑相对于父组件的场外位置；Idle 稳定时位于此处。 */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "角色运动|小电脑", meta = (AllowPrivateAccess = "true", DisplayName = "场外位置"))
	FVector ComputerOffscreenLocation = FVector(160.0f, 80.0f, 0.0f);

	/** 小电脑进出场的恒定移动速度。 */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "角色运动|小电脑", meta = (AllowPrivateAccess = "true", ClampMin = "0.0"))
	float ComputerMoveSpeed = 240.0f;

	/** BodyLean 达到绝对值 1 时对应的路径移动速度；零值表示使用移动速度。 */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "角色运动|BodyLean", meta = (AllowPrivateAccess = "true", ClampMin = "0.0"))
	float BodyLeanReferenceSpeed = 0.0f;

	/** 与当前 Control Rig 方向相反时启用。 */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "角色运动|BodyLean", meta = (AllowPrivateAccess = "true"))
	bool bInvertBodyLean = false;

	UPROPERTY(VisibleInstanceOnly, BlueprintReadOnly, Transient, Category = "角色运动|BodyLean", meta = (AllowPrivateAccess = "true"))
	float BodyLean = 0.0f;

	UPROPERTY(VisibleInstanceOnly, BlueprintReadOnly, Transient, Category = "角色运动", meta = (AllowPrivateAccess = "true"))
	bool bWorkPresentationActive = false;

	UPROPERTY(VisibleInstanceOnly, BlueprintReadOnly, Transient, Category = "角色运动", meta = (AllowPrivateAccess = "true"))
	EPetPresentationPhase PresentationPhase = EPetPresentationPhase::HiddenStable;

	FVector WorkingRelativeLocation = FVector::ZeroVector;
	bool bInitialized = false;
};
