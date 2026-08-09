#pragma once

#include "CoreMinimal.h"
#include "Blueprint/UserWidget.h"
#include "PetMainWidget.generated.h"

/**
 * 宠物主 UI 的 C++ 基类。
 *
 * 可见 UI 应通过场景中的 WidgetComponent 使用该类的蓝图子类，确保内容进入场景捕获。
 */
UCLASS(Abstract, Blueprintable)
class PET_API UPetMainWidget : public UUserWidget
{
	GENERATED_BODY()
};
