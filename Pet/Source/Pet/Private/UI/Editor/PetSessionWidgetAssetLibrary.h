#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"

#include "PetSessionWidgetAssetLibrary.generated.h"

/**
 * 仅供编辑器资产生成脚本使用的窄接口。
 *
 * Python 反射不能写入 UWidgetBlueprint 的非 Edit 动画属性，因此由这里使用正式
 * C++ API 创建 WidgetAnimation、MovieScene、控件绑定和属性轨道。非编辑器目标中
 * 保留同一反射签名，但函数会安全返回 false，且不会链接任何编辑器模块。
 */
UCLASS()
class PET_API UPetSessionWidgetAssetLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/** 返回 Widget Blueprint 自有的 WidgetTree；Python 无权直接读取 protected 属性。 */
	UFUNCTION(BlueprintCallable, Category = "KimiPet|资产生成")
	static UObject* GetWidgetTree(UObject* WidgetBlueprintObject);

	/** 设置 WidgetTree 根控件；Python 无权直接写入非 Edit 的 RootWidget 属性。 */
	UFUNCTION(BlueprintCallable, Category = "KimiPet|资产生成")
	static bool SetRootWidget(UObject* WidgetBlueprintObject, UObject* RootWidgetObject);

	/** 将 Panel 生成类写入 BP_PetCapturePawn CDO 的软类属性。 */
	UFUNCTION(BlueprintCallable, Category = "KimiPet|资产生成")
	static bool ConfigurePawnSessionPanelClass(UObject* PawnBlueprintObject, UObject* PanelBlueprintObject);

	/** 根据面板或行 Blueprint 的控件名称写入项目约定的标准动画。 */
	UFUNCTION(BlueprintCallable, Category = "KimiPet|资产生成")
	static bool AddStandardAnimations(UObject* WidgetBlueprintObject);

	/** 校验动画对象、MovieScene、控件绑定和属性轨道是否完整。 */
	UFUNCTION(BlueprintCallable, Category = "KimiPet|资产生成")
	static bool ValidateStandardAnimations(UObject* WidgetBlueprintObject);
};
