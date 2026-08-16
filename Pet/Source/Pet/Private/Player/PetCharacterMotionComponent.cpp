#include "Player/PetCharacterMotionComponent.h"

#include "Pet.h"
#include "Components/SkeletalMeshComponent.h"
#include "Player/PetSceneSlotComponent.h"

UPetCharacterMotionComponent::UPetCharacterMotionComponent()
{
	PrimaryComponentTick.bCanEverTick = true;
	PrimaryComponentTick.TickGroup = TG_PrePhysics;
}

void UPetCharacterMotionComponent::Initialize(
	USkeletalMeshComponent* InPetMesh,
	USkeletalMeshComponent* InComputerMesh,
	const UPetSceneSlotComponent* InSceneSlots)
{
	PetMesh = InPetMesh;
	ComputerMesh = InComputerMesh;
	BodyLean = 0.0f;
	bWorkPresentationActive = false;
	PresentationPhase = EPetPresentationPhase::HiddenStable;
	bInitialized = ComputerMesh != nullptr;

	if (!ComputerMesh)
	{
		return;
	}

	WorkingRelativeLocation = ComputerMesh->GetRelativeLocation();
	ComputerOffscreenRelativeLocation = ComputerOffscreenLocation;
	if (!InSceneSlots || !InSceneSlots->TryGetSlotLocationRelativeTo(
		EPetSceneSlot::ComputerOffscreen,
		ComputerMesh,
		ComputerOffscreenRelativeLocation))
	{
		UE_LOG(
			LogPet,
			Warning,
			TEXT("未配置小电脑场外位置插槽，使用旧版后备位置 %s"),
			*ComputerOffscreenLocation.ToString());
	}

	// 必须先放到画外位置，再改变可见性，避免短暂显示蓝图中的旧位置。
	ComputerMesh->SetRelativeLocation(ComputerOffscreenRelativeLocation, false, nullptr, ETeleportType::TeleportPhysics);
	ComputerMesh->SetVisibility(false, true);
}

void UPetCharacterMotionComponent::SetPetState(EPetWorkState NewState)
{
	if (!bInitialized || !ComputerMesh)
	{
		return;
	}

	if (NewState == EPetWorkState::Working)
	{
		if (PresentationPhase == EPetPresentationPhase::WorkingStable ||
			PresentationPhase == EPetPresentationPhase::Entering)
		{
			return;
		}

		BodyLean = 0.0f;
		if (PresentationPhase == EPetPresentationPhase::HiddenStable)
		{
			bWorkPresentationActive = false;
			ComputerMesh->SetRelativeLocation(ComputerOffscreenRelativeLocation, false, nullptr, ETeleportType::TeleportPhysics);
		}
		ComputerMesh->SetVisibility(true, true);
		PresentationPhase = EPetPresentationPhase::Entering;
		UE_LOG(LogPet, Verbose, TEXT("小电脑过渡开始: Entering"));
		return;
	}

	if (PresentationPhase == EPetPresentationPhase::HiddenStable ||
		PresentationPhase == EPetPresentationPhase::Exiting)
	{
		return;
	}
	// 退出一开始就关闭 Working 姿态：主角色按 ABP 混合时间平滑切回 Idle，
	// 小电脑滑出期间不应继续播放 Working（敲键盘）动画。
	bWorkPresentationActive = false;
	BodyLean = 0.0f;
	PresentationPhase = EPetPresentationPhase::Exiting;
	UE_LOG(LogPet, Verbose, TEXT("小电脑过渡开始: Exiting"));
}

void UPetCharacterMotionComponent::TickComponent(
	float DeltaTime,
	ELevelTick TickType,
	FActorComponentTickFunction* ThisTickFunction)
{
	Super::TickComponent(DeltaTime, TickType, ThisTickFunction);
	if (!bInitialized || !ComputerMesh)
	{
		return;
	}

	if (PresentationPhase == EPetPresentationPhase::Entering)
	{
		UpdateMovingPhase(DeltaTime, true);
	}
	else if (PresentationPhase == EPetPresentationPhase::Exiting)
	{
		UpdateMovingPhase(DeltaTime, false);
	}
}

void UPetCharacterMotionComponent::UpdateMovingPhase(float DeltaTime, bool bEntering)
{
	if (DeltaTime <= 0.0f)
	{
		BodyLean = 0.0f;
		return;
	}

	const FVector CurrentLocation = ComputerMesh->GetRelativeLocation();
	const FVector& TargetLocation = bEntering ? WorkingRelativeLocation : ComputerOffscreenRelativeLocation;
	if (ComputerMoveSpeed <= UE_KINDA_SMALL_NUMBER)
	{
		ComputerMesh->SetRelativeLocation(TargetLocation, false, nullptr, ETeleportType::None);
		if (bEntering)
		{
			CompleteEntering();
		}
		else
		{
			CompleteExiting();
		}
		return;
	}

	const FVector NewLocation = FMath::VInterpConstantTo(
		CurrentLocation,
		TargetLocation,
		DeltaTime,
		ComputerMoveSpeed);
	ComputerMesh->SetRelativeLocation(NewLocation, false, nullptr, ETeleportType::None);

	const float ReferenceSpeed = BodyLeanReferenceSpeed > UE_KINDA_SMALL_NUMBER
		? BodyLeanReferenceSpeed
		: FMath::Max(ComputerMoveSpeed, UE_KINDA_SMALL_NUMBER);
	const FVector OutwardDirection = (ComputerOffscreenRelativeLocation - WorkingRelativeLocation).GetSafeNormal();
	const float MovementAlongPath = FVector::DotProduct(NewLocation - CurrentLocation, OutwardDirection);
	// Control Rig 已经用弹簧跟随 BodyLean。这里必须立即提交实际速度目标，才能在起步时
	// 形成与移动方向相反的惯性滞后；再次套正弦缓入会滤掉首帧冲量，使 Q 弹不可见。
	BodyLean = FMath::Clamp((MovementAlongPath / DeltaTime) / ReferenceSpeed, -1.0f, 1.0f) * -1;

	if (NewLocation.Equals(TargetLocation, UE_KINDA_SMALL_NUMBER))
	{
		ComputerMesh->SetRelativeLocation(TargetLocation, false, nullptr, ETeleportType::None);
		if (bEntering)
		{
			CompleteEntering();
		}
		else
		{
			CompleteExiting();
		}
	}
}

void UPetCharacterMotionComponent::CompleteEntering()
{
	BodyLean = 0.0f;
	PresentationPhase = EPetPresentationPhase::WorkingStable;
	bWorkPresentationActive = true;
	UE_LOG(LogPet, Verbose, TEXT("小电脑过渡完成: WorkingStable"));
}

void UPetCharacterMotionComponent::CompleteExiting()
{
	BodyLean = 0.0f;
	PresentationPhase = EPetPresentationPhase::HiddenStable;
	ComputerMesh->SetVisibility(false, true);
	UE_LOG(LogPet, Verbose, TEXT("小电脑过渡完成: HiddenStable"));
}
