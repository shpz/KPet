#include "Player/PetCameraManagerComponent.h"

#include "Pet.h"
#include "Components/SceneCaptureComponent2D.h"

UPetCameraManagerComponent::UPetCameraManagerComponent()
{
	PrimaryComponentTick.bCanEverTick = true;
	PrimaryComponentTick.TickGroup = TG_PrePhysics;
}

void UPetCameraManagerComponent::Initialize(USceneCaptureComponent2D* InCapture)
{
	Capture = InCapture;
	if (!Capture)
	{
		bInitialized = false;
		return;
	}

	const FVector InitialOffset = Capture->GetRelativeLocation();
	const float MinDistance = FMath::Min(CameraMinDistance, CameraMaxDistance);
	const float MaxDistance = FMath::Max(CameraMinDistance, CameraMaxDistance);
	CameraDistance = FMath::Clamp(InitialOffset.Size(), MinDistance, MaxDistance);
	InitialCameraDirection = InitialOffset.GetSafeNormal(UE_SMALL_NUMBER, FVector(-1.0f, 0.0f, 0.0f));
	CurrentStateYaw = 0.0f;
	TransitionStartYaw = 0.0f;
	TransitionTargetYaw = 0.0f;
	TransitionElapsed = 0.0f;
	ActiveTransitionDuration = 0.0f;
	bInitialized = true;
	ApplyCameraTransform();
}

void UPetCameraManagerComponent::SetPetState(EPetWorkState NewState)
{
	BeginStateTransition(NewState == EPetWorkState::Working ? WorkingYawOffset : 0.0f);
}

void UPetCameraManagerComponent::BeginStateTransition(float NewTargetYaw)
{
	if (!bInitialized || FMath::IsNearlyEqual(CurrentStateYaw, NewTargetYaw))
	{
		CurrentStateYaw = NewTargetYaw;
		TransitionStartYaw = NewTargetYaw;
		TransitionTargetYaw = NewTargetYaw;
		TransitionElapsed = 0.0f;
		ActiveTransitionDuration = 0.0f;
		ApplyCameraTransform();
		return;
	}

	TransitionStartYaw = CurrentStateYaw;
	TransitionTargetYaw = NewTargetYaw;
	TransitionElapsed = 0.0f;

	const float FullAngle = FMath::Max(FMath::Abs(WorkingYawOffset), UE_KINDA_SMALL_NUMBER);
	const float DistanceRatio = FMath::Clamp(FMath::Abs(TransitionTargetYaw - TransitionStartYaw) / FullAngle, 0.0f, 1.0f);
	ActiveTransitionDuration = StateTransitionDuration * DistanceRatio;
	if (ActiveTransitionDuration <= UE_KINDA_SMALL_NUMBER)
	{
		CurrentStateYaw = TransitionTargetYaw;
		ActiveTransitionDuration = 0.0f;
		ApplyCameraTransform();
		return;
	}

	UE_LOG(
		LogPet,
		Verbose,
		TEXT("摄像机状态过渡开始: yaw %.2f -> %.2f, duration=%.3fs"),
		TransitionStartYaw,
		TransitionTargetYaw,
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
	CurrentStateYaw = FMath::InterpEaseInOut(TransitionStartYaw, TransitionTargetYaw, Alpha, 2.0f);
	if (Alpha >= 1.0f)
	{
		CurrentStateYaw = TransitionTargetYaw;
		ActiveTransitionDuration = 0.0f;
		UE_LOG(LogPet, Verbose, TEXT("摄像机状态过渡完成: yaw=%.2f"), CurrentStateYaw);
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
	const float MinDistance = FMath::Min(CameraMinDistance, CameraMaxDistance);
	const float MaxDistance = FMath::Max(CameraMinDistance, CameraMaxDistance);
	CameraDistance = FMath::Clamp(CameraDistance - WheelDelta * CameraZoomStep, MinDistance, MaxDistance);
	ApplyCameraTransform();
}

void UPetCameraManagerComponent::ApplyCameraTransform()
{
	if (!bInitialized || !Capture)
	{
		return;
	}

	const FRotator OrbitRotation(PlayerPitchOffset, CurrentStateYaw + PlayerYawOffset, 0.0f);
	const FVector Offset = OrbitRotation.RotateVector(InitialCameraDirection * CameraDistance);
	Capture->SetRelativeLocation(Offset);
	Capture->SetRelativeRotation((-Offset).Rotation());
}
