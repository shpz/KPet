#include "Animation/KPetAnimInstance.h"

#include "Blueprint/WidgetLayoutLibrary.h"
#include "Components/SkeletalMeshComponent.h"
#include "FunctionLibrary/PetHelperLibrary.h"
#include "Player/PetCapturePawn.h"
#include "Player/PetCharacterMotionComponent.h"

void UKPetAnimInstance::NativeInitializeAnimation()
{
	Super::NativeInitializeAnimation();
	PetPawn = Cast<APetCapturePawn>(TryGetPawnOwner());
	BlinkAlpha = 0.0f;
	BlinkElapsed = 0.0f;
	bBlinking = false;
	ScheduleNextBlink();
}

void UKPetAnimInstance::NativeUpdateAnimation(float DeltaSeconds)
{
	Super::NativeUpdateAnimation(DeltaSeconds);

	if (!IsValid(PetPawn))
	{
		PetPawn = Cast<APetCapturePawn>(TryGetPawnOwner());
	}

	if (const UPetCharacterMotionComponent* Motion = IsValid(PetPawn)
		? PetPawn->GetPetMotionComponent()
		: nullptr)
	{
		bWorkPresentationActive = Motion->IsWorkPresentationActive();
	}
	else
	{
		bWorkPresentationActive = false;
	}
	UpdateBlink(FMath::Max(DeltaSeconds, 0.0f));
	UpdateEyeLook(FMath::Max(DeltaSeconds, 0.0f));
}

void UKPetAnimInstance::ScheduleNextBlink()
{
	const float Minimum = FMath::Max(FMath::Min(BlinkIntervalMin, BlinkIntervalMax), 0.0f);
	const float Maximum = FMath::Max(FMath::Max(BlinkIntervalMin, BlinkIntervalMax), Minimum);
	BlinkCountdown = FMath::FRandRange(Minimum, Maximum);
}

void UKPetAnimInstance::UpdateBlink(float DeltaSeconds)
{
	if (bBlinking)
	{
		if (BlinkDuration <= UE_KINDA_SMALL_NUMBER)
		{
			BlinkAlpha = 0.0f;
			BlinkElapsed = 0.0f;
			bBlinking = false;
			ScheduleNextBlink();
			return;
		}

		BlinkElapsed += DeltaSeconds;
		const float Progress = FMath::Clamp(BlinkElapsed / BlinkDuration, 0.0f, 1.0f);
		BlinkAlpha = FMath::Sin(Progress * UE_PI);
		if (Progress >= 1.0f)
		{
			BlinkAlpha = 0.0f;
			BlinkElapsed = 0.0f;
			bBlinking = false;
			ScheduleNextBlink();
		}
		return;
	}

	BlinkCountdown -= DeltaSeconds;
	if (BlinkCountdown <= 0.0f)
	{
		BlinkElapsed = 0.0f;
		bBlinking = true;
		BlinkAlpha = 0.0f;
	}
}

void UKPetAnimInstance::UpdateEyeLook(float DeltaSeconds)
{
	FVector2D Target = FVector2D::ZeroVector;
	USkeletalMeshComponent* Mesh = GetSkelMeshComponent();
	if (IsValid(PetPawn) && PetPawn->GetCurrentPetState() == EPetWorkState::Idle &&
		IsValid(Mesh) && Mesh->DoesSocketExist(EyeCenterSocketName))
	{
		FVector2D EyePixel;
		if (UPetHelperLibrary::ProjectWorldToPetCapture(
			PetPawn->GetCaptureComponent(),
			Mesh->GetSocketLocation(EyeCenterSocketName),
			EyePixel))
		{
			const FIntPoint WindowPosition = PetPawn->GetWindowScreenPosition();
			const FVector2D EyeScreenPosition(
				static_cast<double>(WindowPosition.X) + EyePixel.X,
				static_cast<double>(WindowPosition.Y) + EyePixel.Y);
			const FVector2D MousePosition = UWidgetLayoutLibrary::GetMousePositionOnPlatform();
			const float Range = FMath::Max(EyeLookRangePixels, 1.0f);
			Target = FVector2D(
				(MousePosition.X - EyeScreenPosition.X) / Range,
				-(MousePosition.Y - EyeScreenPosition.Y) / Range).GetClampedToMaxSize(1.0f);

			const float Magnitude = Target.Size();
			const float DeadZone = FMath::Clamp(EyeLookDeadZone, 0.0f, 0.99f);
			if (Magnitude <= DeadZone)
			{
				Target = FVector2D::ZeroVector;
			}
			else if (Magnitude > UE_KINDA_SMALL_NUMBER)
			{
				const float RemappedMagnitude = (Magnitude - DeadZone) / (1.0f - DeadZone);
				Target = Target.GetSafeNormal() * FMath::Clamp(RemappedMagnitude, 0.0f, 1.0f);
			}
		}
	}

	if (EyeLookInterpSpeed <= 0.0f)
	{
		EyeLookX = Target.X;
		EyeLookY = Target.Y;
		return;
	}

	EyeLookX = FMath::FInterpTo(EyeLookX, Target.X, DeltaSeconds, EyeLookInterpSpeed);
	EyeLookY = FMath::FInterpTo(EyeLookY, Target.Y, DeltaSeconds, EyeLookInterpSpeed);
}
