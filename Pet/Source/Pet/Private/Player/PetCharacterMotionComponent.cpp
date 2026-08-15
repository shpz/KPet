#include "Player/PetCharacterMotionComponent.h"

#include "Components/SkeletalMeshComponent.h"

UPetCharacterMotionComponent::UPetCharacterMotionComponent()
{
	PrimaryComponentTick.bCanEverTick = true;
	PrimaryComponentTick.TickGroup = TG_PrePhysics;
}

void UPetCharacterMotionComponent::Initialize(
	USkeletalMeshComponent* InPetMesh,
	USkeletalMeshComponent* InComputerMesh)
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

	WorkingWorldLocation = ComputerMesh->GetComponentLocation();
	HiddenWorldLocation = WorkingWorldLocation + FVector(ComputerTravelDistance, 0.0f, 0.0f);

	// 必须先放到画外位置，再改变可见性，避免短暂显示蓝图中的旧位置。
	ComputerMesh->SetWorldLocation(HiddenWorldLocation, false, nullptr, ETeleportType::TeleportPhysics);
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

		bWorkPresentationActive = false;
		if (PresentationPhase == EPetPresentationPhase::HiddenStable)
		{
			ComputerMesh->SetWorldLocation(HiddenWorldLocation, false, nullptr, ETeleportType::TeleportPhysics);
		}
		ComputerMesh->SetVisibility(true, true);
		PresentationPhase = EPetPresentationPhase::Entering;
		return;
	}

	bWorkPresentationActive = false;
	if (PresentationPhase == EPetPresentationPhase::HiddenStable ||
		PresentationPhase == EPetPresentationPhase::Exiting)
	{
		return;
	}
	PresentationPhase = EPetPresentationPhase::Exiting;
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

	const FVector CurrentLocation = ComputerMesh->GetComponentLocation();
	const FVector& TargetLocation = bEntering ? WorkingWorldLocation : HiddenWorldLocation;
	if (ComputerMoveSpeed <= UE_KINDA_SMALL_NUMBER)
	{
		ComputerMesh->SetWorldLocation(TargetLocation, false, nullptr, ETeleportType::None);
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

	const float MaxStep = ComputerMoveSpeed * DeltaTime;
	const float RemainingX = TargetLocation.X - CurrentLocation.X;
	const float DeltaX = FMath::Clamp(RemainingX, -MaxStep, MaxStep);

	FVector NewLocation = CurrentLocation;
	NewLocation.X += DeltaX;
	ComputerMesh->SetWorldLocation(NewLocation, false, nullptr, ETeleportType::None);

	const float ReferenceSpeed = BodyLeanReferenceSpeed > UE_KINDA_SMALL_NUMBER
		? BodyLeanReferenceSpeed
		: FMath::Max(ComputerMoveSpeed, UE_KINDA_SMALL_NUMBER);
	const float DirectionMultiplier = bInvertBodyLean ? -1.0f : 1.0f;
	BodyLean = FMath::Clamp((DeltaX / DeltaTime) / ReferenceSpeed, -1.0f, 1.0f) * DirectionMultiplier;

	if (FMath::IsNearlyEqual(NewLocation.X, TargetLocation.X, UE_KINDA_SMALL_NUMBER))
	{
		ComputerMesh->SetWorldLocation(TargetLocation, false, nullptr, ETeleportType::None);
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
}

void UPetCharacterMotionComponent::CompleteExiting()
{
	BodyLean = 0.0f;
	bWorkPresentationActive = false;
	PresentationPhase = EPetPresentationPhase::HiddenStable;
	ComputerMesh->SetVisibility(false, true);
}
