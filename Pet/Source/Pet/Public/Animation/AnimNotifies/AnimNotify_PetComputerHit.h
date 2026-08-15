#pragma once

#include "CoreMinimal.h"
#include "Animation/AnimNotifies/AnimNotify.h"
#include "AnimNotify_PetComputerHit.generated.h"

/** 主角色手部接触小电脑时触发一次敲击反应。 */
UCLASS(meta = (DisplayName = "触发小电脑敲击"))
class PET_API UAnimNotify_PetComputerHit : public UAnimNotify
{
	GENERATED_BODY()

public:
	virtual void Notify(
		USkeletalMeshComponent* MeshComp,
		UAnimSequenceBase* Animation,
		const FAnimNotifyEventReference& EventReference) override;

	virtual FString GetNotifyName_Implementation() const override;
};
