#include "Game/PetGameMode.h"

#include "Player/PetPlayerController.h"

APetGameMode::APetGameMode()
{
	PlayerControllerClass = APetPlayerController::StaticClass();
}
