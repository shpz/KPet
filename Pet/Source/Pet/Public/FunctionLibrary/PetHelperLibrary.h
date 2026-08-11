#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "PetHelperLibrary.generated.h"

class USceneCaptureComponent2D;

/** 桌宠通用蓝图辅助函数。 */
UCLASS()
class PET_API UPetHelperLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/**
	 * 将世界坐标投影到 SceneCaptureComponent2D 的 RenderTarget 像素坐标。
	 * 返回 false 表示捕获组件或 RenderTarget 无效，或世界坐标位于捕获相机后方。
	 */
	UFUNCTION(BlueprintPure, Category = "Pet|Capture")
	static bool ProjectWorldToPetCapture(
		USceneCaptureComponent2D* SceneCapture,
		FVector WorldLocation,
		FVector2D& PixelPosition);
};
