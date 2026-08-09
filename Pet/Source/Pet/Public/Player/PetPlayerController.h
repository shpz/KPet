#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"
#include "PetPlayerController.generated.h"

/**
 * 宠物渲染进程的玩家控制器基类。
 *
 * 当前鼠标交互由分层窗口处理，本类作为后续游戏流程和蓝图扩展的统一入口。
 */
UCLASS(Blueprintable)
class PET_API APetPlayerController : public APlayerController
{
	GENERATED_BODY()
};
