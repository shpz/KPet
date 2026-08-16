#include "Player/PetCameraManagerComponent.h"
#include "Player/PetCharacterMotionComponent.h"
#include "Player/PetSceneSlotComponent.h"

#include "Components/SceneCaptureComponent2D.h"
#include "Components/SceneComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Engine/World.h"
#include "Misc/AutomationTest.h"

#if WITH_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetCameraStateTransitionTest,
	"Pet.Player.Transition.CameraRoundTrip",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetCameraStateTransitionTest::RunTest(const FString& Parameters)
{
	UWorld* World = UWorld::CreateWorld(EWorldType::Game, false);
	USceneComponent* SceneRoot = NewObject<USceneComponent>(World);
	USceneCaptureComponent2D* Capture = NewObject<USceneCaptureComponent2D>(World);
	USceneComponent* DefaultCameraSlot = NewObject<USceneComponent>(World);
	USceneComponent* WorkingCameraSlot = NewObject<USceneComponent>(World);
	UPetSceneSlotComponent* SceneSlots = NewObject<UPetSceneSlotComponent>(World);
	UPetCameraManagerComponent* Camera = NewObject<UPetCameraManagerComponent>(World);
	Capture->SetupAttachment(SceneRoot);
	DefaultCameraSlot->SetupAttachment(SceneRoot);
	WorkingCameraSlot->SetupAttachment(SceneRoot);
	SceneRoot->RegisterComponentWithWorld(World);
	SceneRoot->SetWorldLocationAndRotation(
		FVector(120.0f, -45.0f, 30.0f),
		FRotator(0.0f, 70.0f, 0.0f));
	Capture->RegisterComponentWithWorld(World);
	DefaultCameraSlot->RegisterComponentWithWorld(World);
	WorkingCameraSlot->RegisterComponentWithWorld(World);
	SceneSlots->RegisterComponentWithWorld(World);
	Camera->RegisterComponentWithWorld(World);

	const FVector IdleCameraLocation(-350.0f, -20.0f, 45.0f);
	const FVector WorkingCameraLocation(-260.0f, 150.0f, 70.0f);
	Capture->SetRelativeLocation(FVector(-100.0f, 20.0f, 10.0f));
	DefaultCameraSlot->SetRelativeLocation(IdleCameraLocation);
	WorkingCameraSlot->SetRelativeLocation(WorkingCameraLocation);
	TestNull(TEXT("未配置的插槽不会错误解析为根组件"),
		SceneSlots->GetSlotComponent(EPetSceneSlot::WorkingCamera));
	SceneSlots->SetSlotComponent(EPetSceneSlot::DefaultCamera, DefaultCameraSlot);
	SceneSlots->SetSlotComponent(EPetSceneSlot::WorkingCamera, WorkingCameraSlot);
	SceneSlots->Initialize(SceneRoot);
	Camera->Initialize(Capture, SceneSlots);
	DefaultCameraSlot->SetRelativeLocation(FVector(-900.0f, -900.0f, -900.0f));
	WorkingCameraSlot->SetRelativeLocation(FVector(900.0f, 900.0f, 900.0f));

	TestTrue(TEXT("初始化保存默认摄像机插槽位置"),
		Camera->GetCurrentStateLocation().Equals(IdleCameraLocation, 0.01f));
	TestTrue(TEXT("初始化把 Capture 设置到默认摄像机插槽位置"),
		Capture->GetRelativeLocation().Equals(IdleCameraLocation, 0.01f));
	Camera->SetPetState(EPetWorkState::Working);
	TestTrue(TEXT("Working 第一帧不允许硬切到目标位置"),
		Capture->GetRelativeLocation().Equals(IdleCameraLocation, 0.01f));

	Camera->TickComponent(0.4f, LEVELTICK_All, nullptr);
	const FVector EnteringLocation = Camera->GetCurrentStateLocation();
	TestTrue(TEXT("进入 Working 的中间帧必须位于两个位置之间"),
		!EnteringLocation.Equals(IdleCameraLocation, 0.01f) &&
		!EnteringLocation.Equals(WorkingCameraLocation, 0.01f));
	const float EnteringExpectedDistance =
		(IdleCameraLocation.Size() + WorkingCameraLocation.Size()) * 0.5f;
	TestTrue(TEXT("球壳插值中点的半径等于两端半径的中值"),
		FMath::IsNearlyEqual(EnteringLocation.Size(), EnteringExpectedDistance, 0.01f));
	TestTrue(TEXT("球壳插值中点不会沿弦靠近角色"),
		EnteringLocation.Size() > FMath::Lerp(IdleCameraLocation, WorkingCameraLocation, 0.5f).Size());
	Camera->TickComponent(0.4f, LEVELTICK_All, nullptr);
	TestTrue(TEXT("Working 摄像机最终到达初始化时缓存的插槽位置"),
		Capture->GetRelativeLocation().Equals(WorkingCameraLocation, 0.01f));

	Camera->SetPetState(EPetWorkState::Idle);
	TestTrue(TEXT("Idle 第一帧保留 Working 摄像机位置"),
		Capture->GetRelativeLocation().Equals(WorkingCameraLocation, 0.01f));
	Camera->TickComponent(0.4f, LEVELTICK_All, nullptr);
	const FVector ExitingLocation = Camera->GetCurrentStateLocation();
	TestTrue(TEXT("返回 Idle 的中间帧必须位于两个位置之间"),
		!ExitingLocation.Equals(IdleCameraLocation, 0.01f) &&
		!ExitingLocation.Equals(WorkingCameraLocation, 0.01f));
	TestTrue(TEXT("返回 Idle 时球壳插值中点同样保持安全半径"),
		FMath::IsNearlyEqual(ExitingLocation.Size(), EnteringExpectedDistance, 0.01f));
	Camera->TickComponent(0.4f, LEVELTICK_All, nullptr);
	TestTrue(TEXT("Idle 摄像机最终回到蓝图默认位置"),
		Capture->GetRelativeLocation().Equals(IdleCameraLocation, 0.01f));

	Camera->UnregisterComponent();
	SceneSlots->UnregisterComponent();
	WorkingCameraSlot->UnregisterComponent();
	DefaultCameraSlot->UnregisterComponent();
	Capture->UnregisterComponent();
	SceneRoot->UnregisterComponent();
	World->DestroyWorld(false);

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetComputerStateTransitionTest,
	"Pet.Player.Transition.ComputerRoundTrip",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetComputerStateTransitionTest::RunTest(const FString& Parameters)
{
	UWorld* World = UWorld::CreateWorld(EWorldType::Game, false);
	USkeletalMeshComponent* PetMesh = NewObject<USkeletalMeshComponent>(World);
	USceneComponent* SceneRoot = NewObject<USceneComponent>(World);
	USceneComponent* ComputerParent = NewObject<USceneComponent>(World);
	USceneComponent* SlotParent = NewObject<USceneComponent>(World);
	USkeletalMeshComponent* ComputerMesh = NewObject<USkeletalMeshComponent>(World);
	USceneComponent* ComputerOffscreenSlot = NewObject<USceneComponent>(World);
	UPetSceneSlotComponent* SceneSlots = NewObject<UPetSceneSlotComponent>(World);
	UPetCharacterMotionComponent* Motion = NewObject<UPetCharacterMotionComponent>(World);
	ComputerParent->SetupAttachment(SceneRoot);
	SlotParent->SetupAttachment(SceneRoot);
	ComputerMesh->SetupAttachment(ComputerParent);
	ComputerOffscreenSlot->SetupAttachment(SlotParent);
	PetMesh->RegisterComponentWithWorld(World);
	SceneRoot->RegisterComponentWithWorld(World);
	SceneRoot->SetWorldLocationAndRotation(
		FVector(80.0f, 35.0f, 15.0f),
		FRotator(0.0f, 20.0f, 0.0f));
	ComputerParent->RegisterComponentWithWorld(World);
	ComputerParent->SetRelativeLocationAndRotation(
		FVector(10.0f, -5.0f, 0.0f),
		FRotator(0.0f, 70.0f, 0.0f));
	SlotParent->RegisterComponentWithWorld(World);
	SlotParent->SetRelativeLocationAndRotation(
		FVector(-20.0f, 15.0f, 5.0f),
		FRotator(0.0f, -35.0f, 0.0f));
	ComputerMesh->RegisterComponentWithWorld(World);
	ComputerOffscreenSlot->RegisterComponentWithWorld(World);
	SceneSlots->RegisterComponentWithWorld(World);
	Motion->RegisterComponentWithWorld(World);
	const FVector WorkingRelativeLocation(0.0f, 40.0f, 20.0f);
	ComputerMesh->SetRelativeLocation(WorkingRelativeLocation);
	ComputerOffscreenSlot->SetRelativeLocation(FVector(140.0f, -35.0f, 10.0f));
	const FVector OffscreenRelativeLocation = ComputerParent->GetComponentTransform()
		.InverseTransformPosition(ComputerOffscreenSlot->GetComponentLocation());
	SceneSlots->SetSlotComponent(EPetSceneSlot::ComputerOffscreen, ComputerOffscreenSlot);
	SceneSlots->Initialize(SceneRoot);
	ComputerOffscreenSlot->SetRelativeLocation(FVector(-800.0f, -800.0f, -800.0f));
	Motion->Initialize(PetMesh, ComputerMesh, SceneSlots);

	const auto IsStrictlyBetween = [](const FVector& Location, const FVector& Start, const FVector& End)
	{
		const float TotalDistance = FVector::Distance(Start, End);
		const float StartDistance = FVector::Distance(Start, Location);
		const float EndDistance = FVector::Distance(Location, End);
		return StartDistance > 0.01f && EndDistance > 0.01f &&
			FMath::IsNearlyEqual(StartDistance + EndDistance, TotalDistance, 0.1f);
	};

	TestEqual(TEXT("初始化阶段为隐藏稳定"), Motion->GetPresentationPhase(), EPetPresentationPhase::HiddenStable);
	TestFalse(TEXT("初始化时小电脑不可见"), ComputerMesh->IsVisible());
	TestFalse(TEXT("初始化时工作姿态未激活"), Motion->IsWorkPresentationActive());
	TestTrue(TEXT("初始化时小电脑位于配置的父组件相对场外位置"),
		ComputerMesh->GetRelativeLocation().Equals(OffscreenRelativeLocation, 0.01f));
	TestTrue(TEXT("场外位置会随父组件旋转转换到世界空间"),
		ComputerMesh->GetComponentLocation().Equals(
			ComputerParent->GetComponentTransform().TransformPosition(OffscreenRelativeLocation),
			0.01f));

	Motion->SetPetState(EPetWorkState::Working);
	TestEqual(TEXT("Working 第一帧进入 Entering"), Motion->GetPresentationPhase(), EPetPresentationPhase::Entering);
	TestTrue(TEXT("进入动画开始时小电脑已经可见"), ComputerMesh->IsVisible());
	TestFalse(TEXT("电脑到位前不切 Working 姿态"), Motion->IsWorkPresentationActive());
	const FVector HiddenRelativeLocation = ComputerMesh->GetRelativeLocation();

	Motion->TickComponent(1.0f / 60.0f, LEVELTICK_All, nullptr);
	TestTrue(TEXT("进入首个运动帧立即给出足量反方向惯性目标"),
		Motion->GetBodyLean() > 0.99f);

	Motion->TickComponent(0.2f, LEVELTICK_All, nullptr);
	const FVector EnteringRelativeLocation = ComputerMesh->GetRelativeLocation();
	TestEqual(TEXT("进入中途仍处于 Entering"), Motion->GetPresentationPhase(), EPetPresentationPhase::Entering);
	TestTrue(TEXT("进入路径在跨父级转换后的两个相对端点之间"),
		IsStrictlyBetween(EnteringRelativeLocation, HiddenRelativeLocation, WorkingRelativeLocation));
	TestTrue(TEXT("进入中途必须产生过渡控制参数"), !FMath::IsNearlyZero(Motion->GetBodyLean()));

	Motion->TickComponent(2.0f, LEVELTICK_All, nullptr);
	TestEqual(TEXT("进入完成后为 WorkingStable"), Motion->GetPresentationPhase(), EPetPresentationPhase::WorkingStable);
	TestTrue(TEXT("电脑到位后激活 Working 姿态"), Motion->IsWorkPresentationActive());
	TestTrue(TEXT("电脑到达蓝图默认相对位置"),
		ComputerMesh->GetRelativeLocation().Equals(WorkingRelativeLocation, 0.01f));

	const FVector StablePetLocation = PetMesh->GetRelativeLocation();
	const FRotator StableComputerRotation = ComputerMesh->GetRelativeRotation();
	const FVector StableComputerScale = ComputerMesh->GetRelativeScale3D();
	Motion->TickComponent(0.2f, LEVELTICK_All, nullptr);
	TestTrue(TEXT("稳定 Working 不注入 BodyLean 动画"), FMath::IsNearlyZero(Motion->GetBodyLean()));
	TestTrue(TEXT("稳定 Working 不修改主角色位置"), PetMesh->GetRelativeLocation().Equals(StablePetLocation));
	TestTrue(TEXT("稳定 Working 不修改小电脑旋转"), ComputerMesh->GetRelativeRotation().Equals(StableComputerRotation));
	TestTrue(TEXT("稳定 Working 不修改小电脑缩放"), ComputerMesh->GetRelativeScale3D().Equals(StableComputerScale));

	Motion->SetPetState(EPetWorkState::Idle);
	TestEqual(TEXT("Idle 第一帧进入 Exiting"), Motion->GetPresentationPhase(), EPetPresentationPhase::Exiting);
	TestFalse(TEXT("退出开始即关闭 Working 姿态"), Motion->IsWorkPresentationActive());
	TestTrue(TEXT("退出第一帧小电脑仍可见"), ComputerMesh->IsVisible());

	Motion->TickComponent(1.0f / 60.0f, LEVELTICK_All, nullptr);
	TestTrue(TEXT("退出首个运动帧立即给出与进入相反的惯性目标"),
		Motion->GetBodyLean() < -0.99f);

	Motion->TickComponent(0.2f, LEVELTICK_All, nullptr);
	const FVector ExitingRelativeLocation = ComputerMesh->GetRelativeLocation();
	TestEqual(TEXT("退出中途仍处于 Exiting"), Motion->GetPresentationPhase(), EPetPresentationPhase::Exiting);
	TestTrue(TEXT("退出路径在跨父级转换后的两个相对端点之间"),
		IsStrictlyBetween(ExitingRelativeLocation, WorkingRelativeLocation, HiddenRelativeLocation));
	TestFalse(TEXT("退出中途 Working 姿态保持关闭"), Motion->IsWorkPresentationActive());
	TestTrue(TEXT("退出中途必须产生过渡控制参数"), !FMath::IsNearlyZero(Motion->GetBodyLean()));

	Motion->TickComponent(2.0f, LEVELTICK_All, nullptr);
	TestEqual(TEXT("退出完成后为 HiddenStable"), Motion->GetPresentationPhase(), EPetPresentationPhase::HiddenStable);
	TestFalse(TEXT("退出完成后 Working 姿态保持关闭"), Motion->IsWorkPresentationActive());
	TestFalse(TEXT("退出完成后才隐藏小电脑"), ComputerMesh->IsVisible());
	TestTrue(TEXT("退出完成后回到配置的父组件相对场外位置"),
		ComputerMesh->GetRelativeLocation().Equals(OffscreenRelativeLocation, 0.01f));

	Motion->UnregisterComponent();
	SceneSlots->UnregisterComponent();
	ComputerOffscreenSlot->UnregisterComponent();
	ComputerMesh->UnregisterComponent();
	SlotParent->UnregisterComponent();
	ComputerParent->UnregisterComponent();
	SceneRoot->UnregisterComponent();
	PetMesh->UnregisterComponent();
	World->DestroyWorld(false);

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetCameraPitchAxisTest,
	"Pet.Player.Transition.PitchAxisConsistent",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetCameraPitchAxisTest::RunTest(const FString& Parameters)
{
	// 上拖（DeltaY 为负）时相机的纵向移动方向必须与摄像机所在方位无关：
	// 俯仰绕当前视线水平右轴旋转，对侧（Working）不会反向。
	const auto DragUpDeltaZ = [](const FVector& CameraLocation)
	{
		UWorld* World = UWorld::CreateWorld(EWorldType::Game, false);
		USceneComponent* SceneRoot = NewObject<USceneComponent>(World);
		USceneCaptureComponent2D* Capture = NewObject<USceneCaptureComponent2D>(World);
		UPetCameraManagerComponent* Camera = NewObject<UPetCameraManagerComponent>(World);
		Capture->SetupAttachment(SceneRoot);
		SceneRoot->RegisterComponentWithWorld(World);
		Capture->RegisterComponentWithWorld(World);
		Camera->RegisterComponentWithWorld(World);

		Capture->SetRelativeLocation(CameraLocation);
		Camera->Initialize(Capture);
		const float BeforeZ = Capture->GetRelativeLocation().Z;
		Camera->AddRotationInput(0.0f, -50.0f);
		const float DeltaZ = Capture->GetRelativeLocation().Z - BeforeZ;

		Camera->UnregisterComponent();
		Capture->UnregisterComponent();
		SceneRoot->UnregisterComponent();
		World->DestroyWorld(false);
		return DeltaZ;
	};

	TestTrue(TEXT("正面方位上拖保持既有手感"), DragUpDeltaZ(FVector(-350.0f, 0.0f, 45.0f)) < 0.0f);
	TestTrue(TEXT("对侧方位上拖方向不反向"), DragUpDeltaZ(FVector(350.0f, 0.0f, 45.0f)) < 0.0f);
	return true;
}

#endif
