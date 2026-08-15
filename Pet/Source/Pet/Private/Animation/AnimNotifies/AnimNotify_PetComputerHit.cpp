#include "Animation/AnimNotifies/AnimNotify_PetComputerHit.h"

#include "Components/SkeletalMeshComponent.h"
#include "Player/PetCapturePawn.h"

void UAnimNotify_PetComputerHit::Notify(
	USkeletalMeshComponent* MeshComp,
	UAnimSequenceBase* Animation,
	const FAnimNotifyEventReference& EventReference)
{
	Super::Notify(MeshComp, Animation, EventReference);
	if (APetCapturePawn* PetPawn = MeshComp ? Cast<APetCapturePawn>(MeshComp->GetOwner()) : nullptr)
	{
		PetPawn->HandleComputerHitNotify();
	}
}

FString UAnimNotify_PetComputerHit::GetNotifyName_Implementation() const
{
	return TEXT("小电脑敲击");
}
