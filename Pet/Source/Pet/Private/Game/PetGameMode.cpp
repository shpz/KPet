#include "Game/PetGameMode.h"

#include "Player/PetPlayerController.h"
#include "UI/PetHUD.h"

APetGameMode::APetGameMode()
{
	PlayerControllerClass = APetPlayerController::StaticClass();
	HUDClass = APetHUD::StaticClass();
}
