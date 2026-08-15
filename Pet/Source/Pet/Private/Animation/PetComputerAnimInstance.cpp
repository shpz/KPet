#include "Animation/PetComputerAnimInstance.h"

#include "Pet.h"
#include "Animation/AnimMontage.h"
#include "Animation/AnimSequenceBase.h"
#include "Player/PetCapturePawn.h"
#include "Player/PetCharacterMotionComponent.h"

void UPetComputerAnimInstance::NativeInitializeAnimation()
{
	Super::NativeInitializeAnimation();
	PetPawn = Cast<APetCapturePawn>(TryGetPawnOwner());
	BodyLean = 0.0f;
	bWorkPresentationActive = false;
	ActiveHitMontage = nullptr;
	bWarnedMissingHitSequence = false;
}

void UPetComputerAnimInstance::NativeUpdateAnimation(float DeltaSeconds)
{
	Super::NativeUpdateAnimation(DeltaSeconds);

	if (!IsValid(PetPawn))
	{
		PetPawn = Cast<APetCapturePawn>(TryGetPawnOwner());
	}

	const UPetCharacterMotionComponent* Motion = IsValid(PetPawn)
		? PetPawn->GetPetMotionComponent()
		: nullptr;
	BodyLean = Motion ? Motion->GetBodyLean() : 0.0f;
	bWorkPresentationActive = Motion && Motion->IsWorkPresentationActive();

	if (!bWorkPresentationActive && ActiveHitMontage && Montage_IsPlaying(ActiveHitMontage))
	{
		StopHitReaction();
	}
}

bool UPetComputerAnimInstance::PlayHitReaction()
{
	if (!IsValid(PetPawn))
	{
		PetPawn = Cast<APetCapturePawn>(TryGetPawnOwner());
	}
	if (const UPetCharacterMotionComponent* Motion = IsValid(PetPawn)
		? PetPawn->GetPetMotionComponent()
		: nullptr)
	{
		BodyLean = Motion->GetBodyLean();
		bWorkPresentationActive = Motion->IsWorkPresentationActive();
	}
	else
	{
		bWorkPresentationActive = false;
	}

	if (!bWorkPresentationActive)
	{
		return false;
	}

	if (!HitReactionSequence)
	{
		if (!bWarnedMissingHitSequence)
		{
			UE_LOG(LogPet, Warning, TEXT("小电脑敲击动画尚未配置，忽略敲击通知"));
			bWarnedMissingHitSequence = true;
		}
		return false;
	}

	StopHitReaction();
	ActiveHitMontage = PlaySlotAnimationAsDynamicMontage(
		HitReactionSequence,
		HitReactionSlotName,
		0.0f,
		0.0f,
		FMath::Max(HitReactionPlayRate, UE_KINDA_SMALL_NUMBER),
		1,
		-1.0f,
		0.0f);
	if (!ActiveHitMontage)
	{
		UE_LOG(LogPet, Warning, TEXT("小电脑敲击动画播放失败，请检查骨架与 Slot 配置"));
		return false;
	}
	return true;
}

void UPetComputerAnimInstance::StopHitReaction()
{
	if (ActiveHitMontage && Montage_IsPlaying(ActiveHitMontage))
	{
		Montage_Stop(0.0f, ActiveHitMontage);
	}
	ActiveHitMontage = nullptr;
}
