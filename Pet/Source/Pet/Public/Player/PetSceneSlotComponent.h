#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "Engine/EngineTypes.h"
#include "PetSceneSlotComponent.generated.h"

class USceneComponent;

/** 蓝图场景中可供原生逻辑读取的位置插槽。 */
UENUM(BlueprintType)
enum class EPetSceneSlot : uint8
{
	ComputerOffscreen UMETA(DisplayName = "小电脑场外位置"),
	WorkingCamera UMETA(DisplayName = "Working 摄像机位置")
};

/** 集中声明并缓存蓝图场景组件提供的位置插槽。 */
UCLASS(ClassGroup = (Pet), meta = (BlueprintSpawnableComponent))
class PET_API UPetSceneSlotComponent : public UActorComponent
{
	GENERATED_BODY()

public:
	UPetSceneSlotComponent();

	/** 在蓝图 Construction Script 完成后，把所有有效插槽快照到参考根组件空间。 */
	void Initialize(USceneComponent* InReferenceRoot);

	/** 返回插槽当前引用的蓝图场景组件；未配置或无效时返回空。 */
	UFUNCTION(BlueprintPure, Category = "场景插槽")
	USceneComponent* GetSlotComponent(EPetSceneSlot Slot) const;

	/**
	 * 返回初始化时缓存的插槽位置，坐标空间与 RelativeToComponent 的相对位置一致，
	 * 即相对于 RelativeToComponent 的父组件；RelativeToComponent 无父组件时返回世界位置。
	 */
	bool TryGetSlotLocationRelativeTo(
		EPetSceneSlot Slot,
		const USceneComponent* RelativeToComponent,
		FVector& OutLocation) const;

	/** 供原生构建和自动化测试设置插槽；蓝图资产使用详情面板中的组件选择器。 */
	void SetSlotComponent(EPetSceneSlot Slot, USceneComponent* InComponent);

private:
	const FComponentReference* GetSlotReference(EPetSceneSlot Slot) const;
	FComponentReference* GetSlotReference(EPetSceneSlot Slot);

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "场景插槽", meta = (AllowPrivateAccess = "true", UseComponentPicker, AllowedClasses = "/Script/Engine.SceneComponent", DisplayName = "小电脑场外位置"))
	FComponentReference ComputerOffscreenSlot;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "场景插槽", meta = (AllowPrivateAccess = "true", UseComponentPicker, AllowedClasses = "/Script/Engine.SceneComponent", DisplayName = "Working 摄像机位置"))
	FComponentReference WorkingCameraSlot;

	UPROPERTY(Transient)
	TObjectPtr<USceneComponent> ReferenceRoot = nullptr;

	FVector ComputerOffscreenRootLocation = FVector::ZeroVector;
	FVector WorkingCameraRootLocation = FVector::ZeroVector;
	bool bHasComputerOffscreenSlot = false;
	bool bHasWorkingCameraSlot = false;
	bool bInitialized = false;
};
