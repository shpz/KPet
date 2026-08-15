#pragma once

#include "CoreMinimal.h"
#include "Animation/AnimInstance.h"
#include "KPetAnimInstance.generated.h"

class APetCapturePawn;

/** 主角色动画参数的原生数据源。 */
UCLASS(Blueprintable)
class PET_API UKPetAnimInstance : public UAnimInstance
{
	GENERATED_BODY()

public:
	virtual void NativeInitializeAnimation() override;
	virtual void NativeUpdateAnimation(float DeltaSeconds) override;

protected:
	/** 眨眼闭合程度，零为睁眼，一为完全闭眼。 */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Transient, Category = "动画参数|眨眼")
	float BlinkAlpha = 0.0f;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Transient, Category = "动画参数|眼睛")
	float EyeLookX = 0.0f;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Transient, Category = "动画参数|眼睛")
	float EyeLookY = 0.0f;

	/** 小电脑到位后才为真，用于主角色切入 Working。 */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Transient, Category = "动画参数|状态")
	bool bWorkPresentationActive = false;

	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "动画参数|眨眼", meta = (ClampMin = "0.0"))
	float BlinkIntervalMin = 2.5f;

	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "动画参数|眨眼", meta = (ClampMin = "0.0"))
	float BlinkIntervalMax = 6.0f;

	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "动画参数|眨眼", meta = (ClampMin = "0.0"))
	float BlinkDuration = 0.18f;

	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "动画参数|眼睛")
	FName EyeCenterSocketName = TEXT("socket_eye_center");

	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "动画参数|眼睛", meta = (ClampMin = "1.0"))
	float EyeLookRangePixels = 320.0f;

	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "动画参数|眼睛", meta = (ClampMin = "0.0", ClampMax = "0.99"))
	float EyeLookDeadZone = 0.08f;

	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "动画参数|眼睛", meta = (ClampMin = "0.0"))
	float EyeLookInterpSpeed = 8.0f;

private:
	void UpdateBlink(float DeltaSeconds);
	void UpdateEyeLook(float DeltaSeconds);
	void ScheduleNextBlink();

	UPROPERTY(Transient)
	TObjectPtr<APetCapturePawn> PetPawn = nullptr;

	float BlinkCountdown = 0.0f;
	float BlinkElapsed = 0.0f;
	bool bBlinking = false;
};
