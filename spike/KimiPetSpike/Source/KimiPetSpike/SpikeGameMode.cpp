#include "SpikeGameMode.h"
#include "SpikeCaptureActor.h"
#include "Engine/World.h"

void ASpikeGameMode::BeginPlay()
{
	Super::BeginPlay();

	if (UWorld* World = GetWorld())
	{
		World->SpawnActor<ASpikeCaptureActor>(ASpikeCaptureActor::StaticClass(), FVector::ZeroVector, FRotator::ZeroRotator);
	}
}
