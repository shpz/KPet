#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "PetGameMode.generated.h"

UCLASS()
class APetGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	virtual void BeginPlay() override;
};
