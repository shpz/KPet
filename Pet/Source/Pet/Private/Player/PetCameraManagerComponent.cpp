#include "Player/PetCameraManagerComponent.h"

#include "Pet.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Player/PetSceneSlotComponent.h"

UPetCameraManagerComponent::UPetCameraManagerComponent()
{
	PrimaryComponentTick.bCanEverTick = true;
	PrimaryComponentTick.TickGroup = TG_PrePhysics;
}

void UPetCameraManagerComponent::Initialize(
	USceneCaptureComponent2D* InCapture,
	const UPetSceneSlotComponent* InSceneSlots)
{
	Capture = InCapture;
	if (!Capture)
	{
		bInitialized = false;
		return;
	}

	DefaultCameraRelativeLocation = Capture->GetRelativeLocation();
	WorkingCameraRelativeLocation = FRotator(0.0f, WorkingYawOffset, 0.0f)
		.RotateVector(DefaultCameraRelativeLocation);
	if (!InSceneSlots || !InSceneSlots->TryGetSlotLocationRelativeTo(
		EPetSceneSlot::WorkingCamera,
		Capture,
		WorkingCameraRelativeLocation))
	{
		UE_LOG(
			LogPet,
			Warning,
			TEXT("未配置 Working 摄像机位置插槽，使用旧版 %.2f 度后备位置"),
			WorkingYawOffset);
	}

	CurrentStateLocation = DefaultCameraRelativeLocation;
	TransitionStartLocation = DefaultCameraRelativeLocation;
	TransitionTargetLocation = DefaultCameraRelativeLocation;
	PlayerYawOffset = 0.0f;
	PlayerPitchOffset = 0.0f;
	PlayerDistanceOffset = 0.0f;
	CurrentStateYaw = 0.0f;
	TransitionElapsed = 0.0f;
	ActiveTransitionDuration = 0.0f;
	bInitialized = true;
	ApplyCameraTransform();
}

void UPetCameraManagerComponent::SetPetState(EPetWorkState NewState)
{
	BeginStateTransition(NewState == EPetWorkState::Working
		? WorkingCameraRelativeLocation
		: DefaultCameraRelativeLocation);
}

void UPetCameraManagerComponent::BeginStateTransition(const FVector& NewTargetLocation)
{
	if (!bInitialized)
	{
		return;
	}

	if (CurrentStateLocation.Equals(NewTargetLocation, UE_KINDA_SMALL_NUMBER))
	{
		CurrentStateLocation = NewTargetLocation;
		TransitionStartLocation = NewTargetLocation;
		TransitionTargetLocation = NewTargetLocation;
		TransitionElapsed = 0.0f;
		ActiveTransitionDuration = 0.0f;
		ApplyCameraTransform();
		return;
	}

	TransitionStartLocation = CurrentStateLocation;
	TransitionTargetLocation = NewTargetLocation;
	TransitionElapsed = 0.0f;

	const float FullDistance = FMath::Max(
		FVector::Distance(DefaultCameraRelativeLocation, WorkingCameraRelativeLocation),
		UE_KINDA_SMALL_NUMBER);
	const float DistanceRatio = FMath::Clamp(
		FVector::Distance(TransitionStartLocation, TransitionTargetLocation) / FullDistance,
		0.0f,
		1.0f);
	ActiveTransitionDuration = StateTransitionDuration * DistanceRatio;
	if (ActiveTransitionDuration <= UE_KINDA_SMALL_NUMBER)
	{
		CurrentStateLocation = TransitionTargetLocation;
		ActiveTransitionDuration = 0.0f;
		ApplyCameraTransform();
		return;
	}

	UE_LOG(
		LogPet,
		Verbose,
		TEXT("摄像机状态过渡开始: %s -> %s, duration=%.3fs"),
		*TransitionStartLocation.ToString(),
		*TransitionTargetLocation.ToString(),
		ActiveTransitionDuration);
}

void UPetCameraManagerComponent::TickComponent(
	float DeltaTime,
	ELevelTick TickType,
	FActorComponentTickFunction* ThisTickFunction)
{
	Super::TickComponent(DeltaTime, TickType, ThisTickFunction);
	if (!bInitialized || ActiveTransitionDuration <= 0.0f)
	{
		return;
	}

	TransitionElapsed += FMath::Max(DeltaTime, 0.0f);
	const float Alpha = FMath::Clamp(TransitionElapsed / ActiveTransitionDuration, 0.0f, 1.0f);
	const float EasedAlpha = FMath::InterpEaseInOut(0.0f, 1.0f, Alpha, 2.0f);
	CurrentStateLocation = FMath::Lerp(TransitionStartLocation, TransitionTargetLocation, EasedAlpha);
	if (Alpha >= 1.0f)
	{
		CurrentStateLocation = TransitionTargetLocation;
		ActiveTransitionDuration = 0.0f;
		UE_LOG(LogPet, Verbose, TEXT("摄像机状态过渡完成: %s"), *CurrentStateLocation.ToString());
	}
	ApplyCameraTransform();
}

void UPetCameraManagerComponent::AddRotationInput(float DeltaX, float DeltaY)
{
	PlayerYawOffset = FMath::Clamp(
		PlayerYawOffset + DeltaX * CameraRotateSensitivity,
		-CameraYawLimit,
		CameraYawLimit);
	PlayerPitchOffset = FMath::Clamp(
		PlayerPitchOffset - DeltaY * CameraRotateSensitivity,
		-CameraPitchLimit,
		CameraPitchLimit);
	ApplyCameraTransform();
}

void UPetCameraManagerComponent::AddZoomInput(float WheelDelta)
{
	if (!bInitialized)
	{
		return;
	}

	const float MinDistance = FMath::Min(CameraMinDistance, CameraMaxDistance);
	const float MaxDistance = FMath::Max(CameraMinDistance, CameraMaxDistance);
	const float BaseDistance = CurrentStateLocation.Size();
	const float CurrentDistance = FMath::Max(BaseDistance + PlayerDistanceOffset, 0.0f);
	const float NewDistance = FMath::Clamp(
		CurrentDistance - WheelDelta * CameraZoomStep,
		MinDistance,
		MaxDistance);
	PlayerDistanceOffset = NewDistance - BaseDistance;
	ApplyCameraTransform();
}

void UPetCameraManagerComponent::ApplyCameraTransform()
{
	if (!bInitialized || !Capture)
	{
		return;
	}

	const FVector DefaultDirection = DefaultCameraRelativeLocation.GetSafeNormal(
		UE_SMALL_NUMBER,
		FVector(-1.0f, 0.0f, 0.0f));
	const FVector StateDirection = CurrentStateLocation.GetSafeNormal(UE_SMALL_NUMBER, DefaultDirection);
	const float StateDistance = CurrentStateLocation.Size();
	const float EffectiveDistance = FMath::Max(StateDistance + PlayerDistanceOffset, 0.0f);
	const FRotator OrbitRotation(PlayerPitchOffset, PlayerYawOffset, 0.0f);
	const FVector Offset = OrbitRotation.RotateVector(StateDirection * EffectiveDistance);
	CurrentStateYaw = FRotator::NormalizeAxis(
		StateDirection.Rotation().Yaw - DefaultDirection.Rotation().Yaw);
	Capture->SetRelativeLocation(Offset);
	Capture->SetRelativeRotation((-Offset).Rotation());
}
