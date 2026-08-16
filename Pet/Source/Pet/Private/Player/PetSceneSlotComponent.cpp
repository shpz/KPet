#include "Player/PetSceneSlotComponent.h"

#include "Components/SceneComponent.h"
#include "GameFramework/Actor.h"

namespace
{
bool IsComponentReferenceConfigured(const FComponentReference& Reference)
{
	return Reference.ComponentProperty != NAME_None ||
		!Reference.PathToComponent.IsEmpty() ||
		Reference.OverrideComponent.IsValid() ||
		Reference.OtherActor.IsValid();
}
}

UPetSceneSlotComponent::UPetSceneSlotComponent()
{
	PrimaryComponentTick.bCanEverTick = false;
}

void UPetSceneSlotComponent::Initialize(USceneComponent* InReferenceRoot)
{
	ReferenceRoot = InReferenceRoot;
	bHasComputerOffscreenSlot = false;
	bHasWorkingCameraSlot = false;
	bHasDefaultCameraSlot = false;
	bInitialized = ReferenceRoot != nullptr;
	if (!bInitialized)
	{
		return;
	}

	const FTransform& RootTransform = ReferenceRoot->GetComponentTransform();
	if (const USceneComponent* SlotComponent = GetSlotComponent(EPetSceneSlot::ComputerOffscreen))
	{
		ComputerOffscreenRootLocation = RootTransform.InverseTransformPosition(SlotComponent->GetComponentLocation());
		bHasComputerOffscreenSlot = true;
	}
	if (const USceneComponent* SlotComponent = GetSlotComponent(EPetSceneSlot::WorkingCamera))
	{
		WorkingCameraRootLocation = RootTransform.InverseTransformPosition(SlotComponent->GetComponentLocation());
		bHasWorkingCameraSlot = true;
	}
	if (const USceneComponent* SlotComponent = GetSlotComponent(EPetSceneSlot::DefaultCamera))
	{
		DefaultCameraRootLocation = RootTransform.InverseTransformPosition(SlotComponent->GetComponentLocation());
		bHasDefaultCameraSlot = true;
	}
}

USceneComponent* UPetSceneSlotComponent::GetSlotComponent(EPetSceneSlot Slot) const
{
	const FComponentReference* Reference = GetSlotReference(Slot);
	if (!Reference || !IsComponentReferenceConfigured(*Reference))
	{
		return nullptr;
	}

	USceneComponent* SlotComponent = Cast<USceneComponent>(Reference->GetComponent(GetOwner()));
	if (!IsValid(SlotComponent))
	{
		return nullptr;
	}

	const AActor* Owner = GetOwner();
	if (Owner && SlotComponent->GetOwner() != Owner)
	{
		return nullptr;
	}
	return SlotComponent;
}

bool UPetSceneSlotComponent::TryGetSlotLocationRelativeTo(
	EPetSceneSlot Slot,
	const USceneComponent* RelativeToComponent,
	FVector& OutLocation) const
{
	if (!bInitialized || !ReferenceRoot || !RelativeToComponent)
	{
		return false;
	}

	const FVector* RootLocation = nullptr;
	switch (Slot)
	{
	case EPetSceneSlot::ComputerOffscreen:
		if (bHasComputerOffscreenSlot)
		{
			RootLocation = &ComputerOffscreenRootLocation;
		}
		break;
	case EPetSceneSlot::WorkingCamera:
		if (bHasWorkingCameraSlot)
		{
			RootLocation = &WorkingCameraRootLocation;
		}
		break;
	case EPetSceneSlot::DefaultCamera:
		if (bHasDefaultCameraSlot)
		{
			RootLocation = &DefaultCameraRootLocation;
		}
		break;
	default:
		break;
	}

	if (!RootLocation)
	{
		return false;
	}

	const FVector WorldLocation = ReferenceRoot->GetComponentTransform().TransformPosition(*RootLocation);
	const USceneComponent* TargetParent = RelativeToComponent->GetAttachParent();
	OutLocation = TargetParent
		? TargetParent->GetComponentTransform().InverseTransformPosition(WorldLocation)
		: WorldLocation;
	return true;
}

void UPetSceneSlotComponent::SetSlotComponent(EPetSceneSlot Slot, USceneComponent* InComponent)
{
	FComponentReference* Reference = GetSlotReference(Slot);
	if (!Reference)
	{
		return;
	}

	*Reference = FComponentReference();
	Reference->OverrideComponent = InComponent;
	bInitialized = false;
}

const FComponentReference* UPetSceneSlotComponent::GetSlotReference(EPetSceneSlot Slot) const
{
	switch (Slot)
	{
	case EPetSceneSlot::ComputerOffscreen:
		return &ComputerOffscreenSlot;
	case EPetSceneSlot::WorkingCamera:
		return &WorkingCameraSlot;
	case EPetSceneSlot::DefaultCamera:
		return &DefaultCameraSlot;
	default:
		return nullptr;
	}
}

FComponentReference* UPetSceneSlotComponent::GetSlotReference(EPetSceneSlot Slot)
{
	return const_cast<FComponentReference*>(
		static_cast<const UPetSceneSlotComponent*>(this)->GetSlotReference(Slot));
}
