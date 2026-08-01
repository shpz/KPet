#include "PetGameMode.h"
#include "PetCaptureActor.h"
#include "Engine/World.h"

void APetGameMode::BeginPlay()
{
	Super::BeginPlay();

	if (UWorld* World = GetWorld())
	{
		World->SpawnActor<APetCaptureActor>(APetCaptureActor::StaticClass(), FVector::ZeroVector, FRotator::ZeroRotator);
	}
}
