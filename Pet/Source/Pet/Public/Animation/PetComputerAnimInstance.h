#pragma once

#include "CoreMinimal.h"
#include "Animation/AnimInstance.h"
#include "PetComputerAnimInstance.generated.h"

class APetCapturePawn;
class UAnimMontage;
class UAnimSequenceBase;

/** 小电脑动画参数与单次敲击播放入口。 */
UCLASS(Blueprintable)
class PET_API UPetComputerAnimInstance : public UAnimInstance
{
	GENERATED_BODY()

public:
	virtual void NativeInitializeAnimation() override;
	virtual void NativeUpdateAnimation(float DeltaSeconds) override;

	/** 每次有效调用都会从第零帧重新播放。 */
	bool PlayHitReaction();

	/** 以零混合时间停止当前敲击动画。 */
	void StopHitReaction();

protected:
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Transient, Category = "动画参数")
	float BodyLean = 0.0f;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Transient, Category = "动画参数")
	bool bWorkPresentationActive = false;

	/** 由动画蓝图类默认值配置，资产在其他会话制作。 */
	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "敲击反应")
	TObjectPtr<UAnimSequenceBase> HitReactionSequence = nullptr;

	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "敲击反应", meta = (ClampMin = "0.01"))
	float HitReactionPlayRate = 1.0f;

	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "敲击反应")
	FName HitReactionSlotName = TEXT("ComputerHit");

private:
	UPROPERTY(Transient)
	TObjectPtr<APetCapturePawn> PetPawn = nullptr;

	UPROPERTY(Transient)
	TObjectPtr<UAnimMontage> ActiveHitMontage = nullptr;

	bool bWarnedMissingHitSequence = false;
};
