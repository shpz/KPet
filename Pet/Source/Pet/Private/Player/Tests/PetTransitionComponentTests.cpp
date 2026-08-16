#include "Player/PetCameraManagerComponent.h"
#include "Player/PetCharacterMotionComponent.h"

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
	USceneCaptureComponent2D* Capture = NewObject<USceneCaptureComponent2D>(World);
	UPetCameraManagerComponent* Camera = NewObject<UPetCameraManagerComponent>(World);
	Capture->RegisterComponentWithWorld(World);
	Camera->RegisterComponentWithWorld(World);
	Capture->SetRelativeLocation(FVector(-350.0f, 0.0f, 45.0f));
	Camera->Initialize(Capture);

	TestTrue(TEXT("初始化为 Idle 视角"), FMath::IsNearlyZero(Camera->GetCurrentStateYaw()));
	Camera->SetPetState(EPetWorkState::Working);
	TestTrue(TEXT("Working 第一帧不允许硬切到目标视角"), FMath::IsNearlyZero(Camera->GetCurrentStateYaw()));

	Camera->TickComponent(0.2f, LEVELTICK_All, nullptr);
	const float EnteringYaw = Camera->GetCurrentStateYaw();
	TestTrue(TEXT("进入 Working 的中间帧必须位于两个视角之间"), EnteringYaw > 0.0f && EnteringYaw < 45.0f);
	Camera->TickComponent(0.6f, LEVELTICK_All, nullptr);
	TestTrue(TEXT("Working 视角最终到达 45 度"), FMath::IsNearlyEqual(Camera->GetCurrentStateYaw(), 45.0f, 0.01f));

	Camera->SetPetState(EPetWorkState::Idle);
	TestTrue(TEXT("Idle 第一帧保留 Working 视角"), FMath::IsNearlyEqual(Camera->GetCurrentStateYaw(), 45.0f, 0.01f));
	Camera->TickComponent(0.2f, LEVELTICK_All, nullptr);
	const float ExitingYaw = Camera->GetCurrentStateYaw();
	TestTrue(TEXT("返回 Idle 的中间帧必须位于两个视角之间"), ExitingYaw > 0.0f && ExitingYaw < 45.0f);
	Camera->TickComponent(0.6f, LEVELTICK_All, nullptr);
	TestTrue(TEXT("Idle 视角最终回到零度"), FMath::IsNearlyZero(Camera->GetCurrentStateYaw(), 0.01f));

	Camera->UnregisterComponent();
	Capture->UnregisterComponent();
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
	USceneComponent* ComputerParent = NewObject<USceneComponent>(World);
	USkeletalMeshComponent* ComputerMesh = NewObject<USkeletalMeshComponent>(World);
	UPetCharacterMotionComponent* Motion = NewObject<UPetCharacterMotionComponent>(World);
	ComputerMesh->SetupAttachment(ComputerParent);
	PetMesh->RegisterComponentWithWorld(World);
	ComputerParent->RegisterComponentWithWorld(World);
	ComputerParent->SetWorldRotation(FRotator(0.0f, 90.0f, 0.0f));
	ComputerMesh->RegisterComponentWithWorld(World);
	Motion->RegisterComponentWithWorld(World);
	const FVector WorkingRelativeLocation(0.0f, 40.0f, 20.0f);
	const FVector OffscreenRelativeLocation(160.0f, 80.0f, 0.0f);
	ComputerMesh->SetRelativeLocation(WorkingRelativeLocation);
	Motion->Initialize(PetMesh, ComputerMesh);

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

	Motion->TickComponent(0.2f, LEVELTICK_All, nullptr);
	const FVector EnteringRelativeLocation = ComputerMesh->GetRelativeLocation();
	TestEqual(TEXT("进入中途仍处于 Entering"), Motion->GetPresentationPhase(), EPetPresentationPhase::Entering);
	TestTrue(TEXT("进入中途位置不能是任一端点"),
		EnteringRelativeLocation.X > WorkingRelativeLocation.X &&
		EnteringRelativeLocation.X < HiddenRelativeLocation.X);
	TestTrue(TEXT("进入路径会插值完整相对向量"),
		EnteringRelativeLocation.Y > WorkingRelativeLocation.Y &&
		EnteringRelativeLocation.Y < HiddenRelativeLocation.Y &&
		EnteringRelativeLocation.Z > HiddenRelativeLocation.Z &&
		EnteringRelativeLocation.Z < WorkingRelativeLocation.Z);
	TestTrue(TEXT("进入中途必须产生过渡控制参数"), !FMath::IsNearlyZero(Motion->GetBodyLean()));

	Motion->TickComponent(0.5f, LEVELTICK_All, nullptr);
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
	TestTrue(TEXT("退出期间保留 Working 姿态，避免硬切"), Motion->IsWorkPresentationActive());
	TestTrue(TEXT("退出第一帧小电脑仍可见"), ComputerMesh->IsVisible());

	Motion->TickComponent(0.2f, LEVELTICK_All, nullptr);
	const FVector ExitingRelativeLocation = ComputerMesh->GetRelativeLocation();
	TestEqual(TEXT("退出中途仍处于 Exiting"), Motion->GetPresentationPhase(), EPetPresentationPhase::Exiting);
	TestTrue(TEXT("退出中途位置不能是任一端点"),
		ExitingRelativeLocation.X > WorkingRelativeLocation.X &&
		ExitingRelativeLocation.X < HiddenRelativeLocation.X);
	TestTrue(TEXT("退出路径会插值完整相对向量"),
		ExitingRelativeLocation.Y > WorkingRelativeLocation.Y &&
		ExitingRelativeLocation.Y < HiddenRelativeLocation.Y &&
		ExitingRelativeLocation.Z > HiddenRelativeLocation.Z &&
		ExitingRelativeLocation.Z < WorkingRelativeLocation.Z);
	TestTrue(TEXT("退出中途仍保留 Working 姿态"), Motion->IsWorkPresentationActive());
	TestTrue(TEXT("退出中途必须产生过渡控制参数"), !FMath::IsNearlyZero(Motion->GetBodyLean()));

	Motion->TickComponent(0.5f, LEVELTICK_All, nullptr);
	TestEqual(TEXT("退出完成后为 HiddenStable"), Motion->GetPresentationPhase(), EPetPresentationPhase::HiddenStable);
	TestFalse(TEXT("退出完成后才关闭 Working 姿态"), Motion->IsWorkPresentationActive());
	TestFalse(TEXT("退出完成后才隐藏小电脑"), ComputerMesh->IsVisible());
	TestTrue(TEXT("退出完成后回到配置的父组件相对场外位置"),
		ComputerMesh->GetRelativeLocation().Equals(OffscreenRelativeLocation, 0.01f));

	Motion->UnregisterComponent();
	ComputerMesh->UnregisterComponent();
	ComputerParent->UnregisterComponent();
	PetMesh->UnregisterComponent();
	World->DestroyWorld(false);

	return true;
}

#endif
