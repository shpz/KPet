#include "Player/PetCapturePawn.h"

#include "Pet.h"
#include "Animation/PetComputerAnimInstance.h"
#include "Communication/PetMessageChannelComponent.h"
#include "Platform/CameraCursorImageData.h"
#include "Platform/PetLayeredWindow.h"
#include "Player/PetCameraManagerComponent.h"
#include "Player/PetCharacterMotionComponent.h"
#include "Player/PetSceneSlotComponent.h"
#include "UI/PetSessionPanelWidget.h"
#include "UI/PetSessionWebBridge.h"
#include "UI/PetSessionWebPanel.h"
#include "UI/PetSessionWindowHost.h"

#include "Blueprint/UserWidget.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Components/SkeletalMeshComponent.h"
#include "Engine/TextureRenderTarget2D.h"
#include "HAL/PlatformApplicationMisc.h"
#include "HAL/PlatformMisc.h"
#include "HAL/PlatformTime.h"
#include "Layout/SlateRect.h"
#include "Misc/ConfigCacheIni.h"

#include "RHIGPUReadback.h"
#include "RenderingThread.h"

namespace
{
template <typename TComponent>
TComponent* FindOwnedComponentByName(const AActor& Owner, const FName ComponentName)
{
	TInlineComponentArray<TComponent*> Components;
	Owner.GetComponents(Components);
	for (TComponent* Component : Components)
	{
		if (Component && Component->GetFName() == ComponentName)
		{
			return Component;
		}
	}
	return nullptr;
}
}

APetCapturePawn::APetCapturePawn()
{
	PrimaryActorTick.bCanEverTick = true;

	RootComp = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	RootComponent = RootComp;

	PetMeshComponent = CreateDefaultSubobject<USkeletalMeshComponent>(TEXT("PetMesh"));
	PetMeshComponent->SetupAttachment(RootComp);
	PetMeshComponent->SetRelativeRotation(FRotator(0.0, 90.0, 0.0));
	PetMeshComponent->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	PetMeshComponent->VisibilityBasedAnimTickOption = EVisibilityBasedAnimTickOption::AlwaysTickPoseAndRefreshBones;

	ComputerMeshComponent = CreateDefaultSubobject<USkeletalMeshComponent>(TEXT("ComputerMesh"));
	ComputerMeshComponent->SetupAttachment(RootComp);
	ComputerMeshComponent->SetRelativeLocation(FVector(0.0, 80.0, 0.0));
	ComputerMeshComponent->SetRelativeRotation(FRotator(0.0, 90.0, 0.0));
	ComputerMeshComponent->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	ComputerMeshComponent->VisibilityBasedAnimTickOption = EVisibilityBasedAnimTickOption::AlwaysTickPoseAndRefreshBones;
	ComputerMeshComponent->SetVisibility(false, true);

	CaptureComponent = CreateDefaultSubobject<USceneCaptureComponent2D>(TEXT("Capture"));
	CaptureComponent->SetupAttachment(RootComp);
	CaptureComponent->SetRelativeLocation(FVector(-350.0, 0.0, 0.0)); // 面向 +X 看向原点
	CaptureComponent->FOVAngle = 40.0f;
	CaptureComponent->CaptureSource = ESceneCaptureSource::SCS_FinalColorLDR;
	CaptureComponent->bCaptureEveryFrame = true;
	CaptureComponent->bCaptureOnMovement = false;
	CaptureComponent->bAlwaysPersistRenderingState = true;
	CaptureComponent->ShowFlags.DynamicShadows = false; // 无接收面，动态阴影只会污染背景 alpha
	CaptureComponent->ShowFlags.Fog = false;             // 背景像素只应有 alpha=0
	CaptureComponent->ShowFlags.VolumetricFog = false;
	CaptureComponent->ShowFlags.Cloud = false;
	CaptureComponent->ShowFlags.SkyLighting = true;
	CaptureComponent->ShowFlags.Bloom = false; // bloom 辉光会写进 alpha=0 的背景像素 RGB，ULW 预乘语义下变成加性虚影

	MessageChannelComponent = CreateDefaultSubobject<UPetMessageChannelComponent>(TEXT("MessageChannel"));
	SceneSlotComponent = CreateDefaultSubobject<UPetSceneSlotComponent>(TEXT("SceneSlots"));
	CameraManagerComponent = CreateDefaultSubobject<UPetCameraManagerComponent>(TEXT("CameraManager"));
	MotionComponent = CreateDefaultSubobject<UPetCharacterMotionComponent>(TEXT("CharacterMotion"));

	MotionComponent->AddTickPrerequisiteComponent(MessageChannelComponent);
	CameraManagerComponent->AddTickPrerequisiteComponent(MessageChannelComponent);
	PetMeshComponent->AddTickPrerequisiteComponent(MotionComponent);
	ComputerMeshComponent->AddTickPrerequisiteComponent(MotionComponent);
	ComputerMeshComponent->AddTickPrerequisiteComponent(PetMeshComponent);
	CaptureComponent->AddTickPrerequisiteComponent(CameraManagerComponent);
	CaptureComponent->AddTickPrerequisiteComponent(ComputerMeshComponent);
}

APetCapturePawn::~APetCapturePawn() = default;

void APetCapturePawn::OnConstruction(const FTransform& Transform)
{
	Super::OnConstruction(Transform);
	ApplyConfiguredCharacterAssets();
}

void APetCapturePawn::PostInitializeComponents()
{
	Super::PostInitializeComponents();
	ApplyConfiguredCharacterAssets();
}

void APetCapturePawn::ApplyConfiguredCharacterAssets()
{
	if (PetMeshComponent)
	{
		if (PetMeshAsset && PetMeshComponent->GetSkeletalMeshAsset() != PetMeshAsset)
		{
			PetMeshComponent->SetSkeletalMeshAsset(PetMeshAsset);
		}
		if (PetAnimInstanceClass && PetMeshComponent->GetAnimClass() != PetAnimInstanceClass)
		{
			PetMeshComponent->SetAnimInstanceClass(PetAnimInstanceClass);
		}
	}

	if (ComputerMeshComponent)
	{
		if (ComputerMeshAsset && ComputerMeshComponent->GetSkeletalMeshAsset() != ComputerMeshAsset)
		{
			ComputerMeshComponent->SetSkeletalMeshAsset(ComputerMeshAsset);
		}
		if (ComputerAnimInstanceClass && ComputerMeshComponent->GetAnimClass() != ComputerAnimInstanceClass)
		{
			ComputerMeshComponent->SetAnimInstanceClass(ComputerAnimInstanceClass);
		}
	}
}

void APetCapturePawn::BeginPlay()
{
	Super::BeginPlay();
	if (!ResolveRuntimeComponents())
	{
		SetActorTickEnabled(false);
		return;
	}

	if (SceneSlotComponent)
	{
		SceneSlotComponent->Initialize(RootComp);
	}
	CameraManagerComponent->Initialize(CaptureComponent, SceneSlotComponent);
	MotionComponent->Initialize(PetMeshComponent, ComputerMeshComponent, SceneSlotComponent);

	// 320x320 BGRA8 RT，清屏为全透明
	RenderTarget = NewObject<UTextureRenderTarget2D>(this);
	RenderTarget->RenderTargetFormat = ETextureRenderTargetFormat::RTF_RGBA8;
	RenderTarget->bForceLinearGamma = false;
	RenderTarget->ClearColor = FLinearColor(0.0f, 0.0f, 0.0f, 0.0f);
	RenderTarget->InitCustomFormat(RTSize, RTSize, PF_B8G8R8A8, false);
	RenderTarget->UpdateResourceImmediate(true);
	CaptureComponent->TextureTarget = RenderTarget;

	// 游戏线程创建窗口（UE 主消息循环会顺带泵它的消息）
	PetWindow = new PetLayeredWindow();
	if (!PetWindow->Create(RTSize, 150, 150))
	{
		UE_LOG(LogPet, Error, TEXT("Failed to create layered window"));
		delete PetWindow;
		PetWindow = nullptr;
	}
	else
	{
		WindowScreenPosition = PetWindow->GetScreenPosition();
	}
	ApplyCameraCursorImage();
	InitializeSessionPanel();

	ENQUEUE_RENDER_COMMAND(CreatePetReadback)(
		[this](FRHICommandListImmediate&)
		{
			Readback = new FRHIGPUTextureReadback(TEXT("KimiPetReadback"));
		});

	MessageChannelComponent->OnPetState.AddUObject(this, &APetCapturePawn::HandlePetState);
	MessageChannelComponent->OnSessionsSnapshot.AddUObject(this, &APetCapturePawn::HandleSessionsSnapshot);
	MessageChannelComponent->OnSessionStart.AddUObject(this, &APetCapturePawn::HandleSessionStart);
	MessageChannelComponent->OnSessionEnd.AddUObject(this, &APetCapturePawn::HandleSessionEnd);
	MessageChannelComponent->OnSessionState.AddUObject(this, &APetCapturePawn::HandleSessionState);
	MessageChannelComponent->OnShutdown.AddUObject(this, &APetCapturePawn::HandleShutdown);
	if (PetWindow)
	{
		PetWindow->OnClick = [this]()
		{
			UE_LOG(LogPet, Log, TEXT("单击宠物 -> 排队切换会话面板"));
			bSessionPanelTogglePending = true;
		};
		PetWindow->OnCloseRequested = [this]()
		{
			UE_LOG(LogPet, Log, TEXT("ESC + 左键单击宠物 -> 排队请求关闭"));
			bCloseRequestPending = true;
		};
		PetWindow->OnDragEnd = [this](int32 X, int32 Y)
		{
			UE_LOG(LogPet, Log, TEXT("拖拽结束 (%d,%d) -> 发送 pet_moved"), X, Y);
			if (MessageChannelComponent)
			{
				MessageChannelComponent->SendPetMoved(X, Y);
			}
		};
		PetWindow->OnCameraRotate = [this](float DeltaX, float DeltaY)
		{
			AdjustCameraRotation(DeltaX, DeltaY);
		};
		PetWindow->OnCameraZoom = [this](float WheelDelta)
		{
			AdjustCameraZoom(WheelDelta);
		};
	}
	MessageChannelComponent->Start();

	UE_LOG(LogPet, Log, TEXT("PetCapturePawn BeginPlay done"));
}

bool APetCapturePawn::ResolveRuntimeComponents()
{
	bool bRecoveredSerializedReference = false;
	auto RecoverReference = [&bRecoveredSerializedReference]<typename TComponent>(
		TObjectPtr<TComponent>& Reference,
		const FName ComponentName,
		const APetCapturePawn& Owner)
	{
		if (!Reference)
		{
			Reference = FindOwnedComponentByName<TComponent>(Owner, ComponentName);
			bRecoveredSerializedReference |= Reference != nullptr;
		}
	};

	if (!RootComp)
	{
		RootComp = GetRootComponent();
		bRecoveredSerializedReference |= RootComp != nullptr;
	}
	RecoverReference(PetMeshComponent, TEXT("PetMesh"), *this);
	RecoverReference(ComputerMeshComponent, TEXT("ComputerMesh"), *this);
	RecoverReference(CaptureComponent, TEXT("Capture"), *this);
	RecoverReference(SceneSlotComponent, TEXT("SceneSlots"), *this);
	RecoverReference(MessageChannelComponent, TEXT("MessageChannel"), *this);
	RecoverReference(CameraManagerComponent, TEXT("CameraManager"), *this);
	RecoverReference(MotionComponent, TEXT("CharacterMotion"), *this);

	const bool bHasAllRequiredComponents = RootComp && PetMeshComponent && ComputerMeshComponent && CaptureComponent &&
		MessageChannelComponent && CameraManagerComponent && MotionComponent;
	if (!bHasAllRequiredComponents)
	{
		UE_LOG(
			LogPet,
			Error,
			TEXT("PetCapturePawn 缺少必要组件：Root=%d PetMesh=%d ComputerMesh=%d Capture=%d MessageChannel=%d CameraManager=%d CharacterMotion=%d"),
			RootComp != nullptr,
			PetMeshComponent != nullptr,
			ComputerMeshComponent != nullptr,
			CaptureComponent != nullptr,
			MessageChannelComponent != nullptr,
			CameraManagerComponent != nullptr,
			MotionComponent != nullptr);
		return false;
	}

	if (bRecoveredSerializedReference)
	{
		UE_LOG(LogPet, Warning, TEXT("已从实例组件恢复 BP_PetCapturePawn 中为空的原生组件引用"));
	}
	if (!SceneSlotComponent)
	{
		UE_LOG(LogPet, Warning, TEXT("PetCapturePawn 缺少 SceneSlots 组件，将使用旧版位置后备值"));
	}

	// 旧蓝图资产可能保留为空的原生组件引用；恢复引用后同步补齐运行时 Tick 顺序。
	MotionComponent->AddTickPrerequisiteComponent(MessageChannelComponent);
	CameraManagerComponent->AddTickPrerequisiteComponent(MessageChannelComponent);
	PetMeshComponent->AddTickPrerequisiteComponent(MotionComponent);
	ComputerMeshComponent->AddTickPrerequisiteComponent(MotionComponent);
	ComputerMeshComponent->AddTickPrerequisiteComponent(PetMeshComponent);
	CaptureComponent->AddTickPrerequisiteComponent(CameraManagerComponent);
	CaptureComponent->AddTickPrerequisiteComponent(ComputerMeshComponent);
	return true;
}

void APetCapturePawn::InitializeSessionPanel()
{
	// WebUI 开关来自 GGameIni 的 [Pet.SessionPanel] bUseWebUI；为 true 优先走 Web 路径，
	// 创建失败回退 UMG 路径；为 false 直接走原有 UMG 路径，原逻辑不动。
	bool bUseWebUI = false;
	if (GConfig)
	{
		GConfig->GetBool(TEXT("Pet.SessionPanel"), TEXT("bUseWebUI"), bUseWebUI, GGameIni);
	}

	if (bUseWebUI)
	{
		SessionWebPanel = MakeUnique<FPetSessionWebPanel>();
		if (!SessionWebPanel->Create())
		{
			UE_LOG(LogPet, Error, TEXT("创建 WebUI 会话面板失败；回退 UMG 路径"));
			SessionWebPanel.Reset();
		}
		else
		{
			SessionWindowHost = new FPetSessionWindowHost();
			if (!SessionWindowHost->Create(SessionWebPanel->GetContentWidget()))
			{
				UE_LOG(LogPet, Error, TEXT("创建 Slate 会话窗口失败；宠物本体将继续运行"));
				delete SessionWindowHost;
				SessionWindowHost = nullptr;
				SessionWebPanel.Reset();
				return;
			}

			if (UPetSessionWebBridge* Bridge = SessionWebPanel->GetBridge())
			{
				Bridge->OnSelectSession.AddUObject(this, &APetCapturePawn::HandleSessionSelected);
				SessionWebCloseHandle = Bridge->OnCloseRequested.AddRaw(SessionWindowHost, &FPetSessionWindowHost::Close);
			}

			UpdateSessionPanelAnchor();
			UE_LOG(LogPet, Log, TEXT("WebUI 会话面板已初始化"));
			return;
		}
	}

	if (SessionPanelWidgetClass.IsNull())
	{
		UE_LOG(LogPet, Error, TEXT("未配置会话面板 Widget 类；请在 BP_PetCapturePawn 中设置软类引用"));
		return;
	}

	const TSubclassOf<UPetSessionPanelWidget> LoadedWidgetClass = SessionPanelWidgetClass.LoadSynchronous();
	if (!LoadedWidgetClass)
	{
		UE_LOG(LogPet, Error, TEXT("加载会话面板 Widget 类失败；宠物本体将继续运行"));
		return;
	}

	SessionPanelWidget = CreateWidget<UPetSessionPanelWidget>(GetWorld(), LoadedWidgetClass);
	if (!SessionPanelWidget)
	{
		UE_LOG(LogPet, Error, TEXT("创建会话面板 Widget 失败；宠物本体将继续运行"));
		return;
	}

	SessionPanelWidget->OnSessionSelected.AddUObject(this, &APetCapturePawn::HandleSessionSelected);
	SessionWindowHost = new FPetSessionWindowHost();
	if (!SessionWindowHost->Create(SessionPanelWidget))
	{
		UE_LOG(LogPet, Error, TEXT("创建 Slate 会话窗口失败；宠物本体将继续运行"));
		delete SessionWindowHost;
		SessionWindowHost = nullptr;
		SessionPanelWidget->OnSessionSelected.RemoveAll(this);
		SessionPanelWidget = nullptr;
		return;
	}

	UpdateSessionPanelAnchor();
	UE_LOG(LogPet, Log, TEXT("Slate 与 UMG 会话面板已初始化"));
}

void APetCapturePawn::ShutdownSessionPanel()
{
	bSessionPanelPresentationPending = false;
	bSessionPanelTogglePending = false;

	if (SessionPanelWidget)
	{
		SessionPanelWidget->OnSessionSelected.RemoveAll(this);
	}

	// 先解绑 Web 桥委托并释放面板，再销毁 Host：句柄解绑在前，避免 Host 销毁后
	// 桥仍持有失效的裸指针委托。
	if (SessionWebPanel)
	{
		if (UPetSessionWebBridge* Bridge = SessionWebPanel->GetBridge())
		{
			Bridge->OnSelectSession.RemoveAll(this);
			Bridge->OnCloseRequested.Remove(SessionWebCloseHandle);
		}
		SessionWebPanel.Reset();
	}
	SessionWebCloseHandle.Reset();

	if (SessionWindowHost)
	{
		SessionWindowHost->Destroy();
		delete SessionWindowHost;
		SessionWindowHost = nullptr;
	}

	SessionPanelWidget = nullptr;
}

void APetCapturePawn::UpdateSessionPanelAnchor()
{
	if (!SessionWindowHost || !PetWindow)
	{
		return;
	}

	// PetLayeredWindow::GetScreenPosition() 返回 Win32 屏幕物理像素，RTSize 也是物理像素；
	// Host 契约（方案 §6.4）只接受 Slate 屏幕坐标。引擎约定 Slate 屏幕坐标 = 物理像素 /
	// DPIScale（SWindow 创建时 AdjustInitialSizeAndPositionForDPIScale 路径以 WindowPosition
	// *= DPIScale 转入平台层，SlateApplication::CalculatePopupWindowPosition 同样按
	// InSize * DPIScale 进平台层、结果 / DPIScale 返回），因此先在坐标契约边界用宠物所在
	// 监视器的 DPI 缩放完成转换；Host 内部不理解物理像素。
	const FIntPoint PetPositionPhysicalPixels = PetWindow->GetScreenPosition();
	const float PetSizePhysicalPixels = static_cast<float>(RTSize);
	const float PetDPIScale = FPlatformApplicationMisc::GetDPIScaleFactorAtPoint(
		static_cast<float>(PetPositionPhysicalPixels.X),
		static_cast<float>(PetPositionPhysicalPixels.Y));
	const FSlateRect PetBoundsInSlateScreen(
		PetPositionPhysicalPixels.X / PetDPIScale,
		PetPositionPhysicalPixels.Y / PetDPIScale,
		(PetPositionPhysicalPixels.X + PetSizePhysicalPixels) / PetDPIScale,
		(PetPositionPhysicalPixels.Y + PetSizePhysicalPixels) / PetDPIScale);
	SessionWindowHost->UpdateAnchor(PetBoundsInSlateScreen);
}

void APetCapturePawn::HandleSessionSelected(const FString& SessionId)
{
	if (SessionId.IsEmpty())
	{
		return;
	}

	UE_LOG(LogPet, Log, TEXT("选择会话 %s -> 发送 open_tui"), *SessionId);
	if (MessageChannelComponent)
	{
		MessageChannelComponent->SendOpenTui(SessionId);
	}
	if (SessionWindowHost)
	{
		SessionWindowHost->Close();
	}
}

void APetCapturePawn::HandlePetState(const FString& State, const FString& Reason)
{
	const EPetWorkStateApplyResult ApplyResult = PetWorkStateLogic::ApplyProtocolValue(State, CurrentPetState);
	if (ApplyResult == EPetWorkStateApplyResult::Invalid)
	{
		UE_LOG(LogPet, Warning, TEXT("收到无法应用的宠物工作状态: %s"), *State);
		return;
	}
	if (ApplyResult == EPetWorkStateApplyResult::Unchanged)
	{
		UE_LOG(LogPet, Verbose, TEXT("pet_state 与当前状态相同，跳过重复蓝图事件: %s (reason=%s)"), *State, *Reason);
		return;
	}

	UE_LOG(LogPet, Log, TEXT("宠物工作状态改变: %s (reason=%s)"), *State, *Reason);
	if (CameraManagerComponent)
	{
		CameraManagerComponent->SetPetState(CurrentPetState);
	}
	if (MotionComponent)
	{
		MotionComponent->SetPetState(CurrentPetState);
	}
	if (CurrentPetState == EPetWorkState::Idle && ComputerMeshComponent)
	{
		if (UPetComputerAnimInstance* ComputerAnim = Cast<UPetComputerAnimInstance>(ComputerMeshComponent->GetAnimInstance()))
		{
			ComputerAnim->StopHitReaction();
		}
	}
	OnPetStateChanged(CurrentPetState);
}

void APetCapturePawn::HandleSessionsSnapshot(const TArray<FPetSessionInfo>& Sessions)
{
	RouteSessionData(
		[&Sessions](FPetSessionWebPanel& Panel) { Panel.ApplySnapshot(Sessions); },
		[&Sessions](UPetSessionPanelWidget& Widget) { Widget.ApplySnapshot(Sessions); });
}

void APetCapturePawn::HandleSessionStart(const FString& SessionId, const FString& Cwd, bool bResume)
{
	RouteSessionData(
		[&SessionId, &Cwd](FPetSessionWebPanel& Panel) { Panel.AddOrUpdateSession(SessionId, FString(), Cwd, true); },
		[&SessionId, &Cwd](UPetSessionPanelWidget& Widget) { Widget.AddOrUpdateSession(SessionId, FString(), Cwd, true); });
}

void APetCapturePawn::HandleSessionEnd(const FString& SessionId, const FString& Reason)
{
	RouteSessionData(
		[&SessionId](FPetSessionWebPanel& Panel) { Panel.SetSessionActive(SessionId, false); },
		[&SessionId](UPetSessionPanelWidget& Widget) { Widget.SetSessionActive(SessionId, false); });
}

void APetCapturePawn::HandleSessionState(const FString& SessionId, bool bWorking, bool bUnread)
{
	RouteSessionData(
		[&SessionId, bWorking, bUnread](FPetSessionWebPanel& Panel) { Panel.UpdateSessionState(SessionId, bWorking, bUnread); },
		[&SessionId, bWorking, bUnread](UPetSessionPanelWidget& Widget) { Widget.UpdateSessionState(SessionId, bWorking, bUnread); });
}

void APetCapturePawn::HandleShutdown(const FString& Reason)
{
	if (GIsEditor)
	{
		UE_LOG(LogPet, Warning, TEXT("PIE 调试中忽略 shutdown，避免退出编辑器（reason=%s）"), *Reason);
		return;
	}
	UE_LOG(LogPet, Log, TEXT("shutdown 请求退出游戏（reason=%s）"), *Reason);
	FPlatformMisc::RequestExit(false);
}

void APetCapturePawn::HandleComputerHitNotify()
{
	if (CurrentPetState != EPetWorkState::Working || !MotionComponent ||
		!MotionComponent->IsWorkPresentationActive() ||
		MotionComponent->GetPresentationPhase() != EPetPresentationPhase::WorkingStable)
	{
		return;
	}

	if (UPetComputerAnimInstance* ComputerAnim = ComputerMeshComponent
		? Cast<UPetComputerAnimInstance>(ComputerMeshComponent->GetAnimInstance())
		: nullptr)
	{
		ComputerAnim->PlayHitReaction();
	}
}

void APetCapturePawn::HandleCloseRequested()
{
	if (bCloseRequested)
	{
		return;
	}
	if (GIsEditor)
	{
		UE_LOG(LogPet, Warning, TEXT("PIE 调试中忽略 ESC + 左键关闭，避免退出编辑器或关闭共享守护进程"));
		return;
	}

	bCloseRequested = true;
	bSessionPanelTogglePending = false;
	bSessionPanelPresentationPending = false;
	ShutdownSessionPanel();
	if (PetWindow)
	{
		PetWindow->Destroy();
	}

	const bool bSent = MessageChannelComponent && MessageChannelComponent->SendClosePet();
	if (bSent)
	{
		CloseFallbackDeadline = FPlatformTime::Seconds() + CloseFallbackSeconds;
		UE_LOG(LogPet, Log, TEXT("用户关闭请求已发送，等待守护进程确认退出"));
	}
	else
	{
		UE_LOG(LogPet, Warning, TEXT("守护进程未连接，直接执行本地退出兜底"));
		FPlatformMisc::RequestExit(false);
	}
}

void APetCapturePawn::Tick(float DeltaTime)
{
	Super::Tick(DeltaTime);

	if (bCloseRequestPending)
	{
		bCloseRequestPending = false;
		HandleCloseRequested();
	}
	if (bCloseRequested && CloseFallbackDeadline > 0.0 && FPlatformTime::Seconds() >= CloseFallbackDeadline)
	{
		CloseFallbackDeadline = 0.0;
		UE_LOG(LogPet, Warning, TEXT("等待守护进程 shutdown 超时，执行本地退出兜底"));
		FPlatformMisc::RequestExit(false);
	}
	if (PetWindow)
	{
		WindowScreenPosition = PetWindow->GetScreenPosition();
		PetWindow->Tick(DeltaTime);
	}
	if (bSessionPanelPresentationPending)
	{
		bSessionPanelPresentationPending = false;
		ReplaySessionPanelPresentation();
	}
	if (bSessionPanelTogglePending)
	{
		bSessionPanelTogglePending = false;
		// Web 路径不创建 UMG Widget（SessionPanelWidget 为空），可用任一资源作为
		// 窗口切换守卫，避免 Web 模式下误报"资源未就绪"。
		if (SessionWindowHost && (SessionPanelWidget || SessionWebPanel))
		{
			UpdateSessionPanelAnchor();
			const bool bWasVisible = SessionWindowHost->IsVisible();
			SessionWindowHost->Toggle();
			if (!bWasVisible)
			{
				// 等到下一帧再重播：此时窗口已可见，ListView 条目也完成了 Slate 布局。
				// Web 路径下 SessionPanelWidget 为空，ReplaySessionPanelPresentation
				// 直接返回，UMG 专属动画自然跳过。
				bSessionPanelPresentationPending = true;
			}
		}
		else
		{
			UE_LOG(LogPet, Warning, TEXT("会话面板资源未就绪，保持宠物本体可用"));
		}
	}
	if (SessionWindowHost)
	{
		if (SessionWindowHost->IsVisible())
		{
			UpdateSessionPanelAnchor();
		}
		SessionWindowHost->TickWindowAnimation(DeltaTime);
		if (SessionPanelWidget && SessionWindowHost->IsVisible())
		{
			SessionPanelWidget->TickDetachedWindowAnimations(DeltaTime);
		}
	}

	if (!RenderTarget)
	{
		return;
	}

	FTextureRenderTargetResource* RTResource = RenderTarget->GameThread_GetRenderTargetResource();
	ENQUEUE_RENDER_COMMAND(PetReadbackTick)(
		[this, RTResource](FRHICommandListImmediate& RHICmdList)
		{
			if (!Readback)
			{
				return;
			}

			if (bCopyInFlight.load())
			{
				if (Readback->IsReady())
				{
					TSharedPtr<TArray<uint8>> Pixels;
					int32 RowPitchPixels = 0;
					int32 BufferHeight = 0;
					void* Data = Readback->Lock(RowPitchPixels, &BufferHeight);
					if (Data && RowPitchPixels > 0 && BufferHeight > 0)
					{
						Pixels = MakeShared<TArray<uint8>>();
						Pixels->SetNumUninitialized(RowPitchPixels * BufferHeight * 4);
						FMemory::Memcpy(Pixels->GetData(), Data, Pixels->Num());
					}
					Readback->Unlock();
					bCopyInFlight.store(false);

					if (Pixels.IsValid())
					{
						TWeakObjectPtr<APetCapturePawn> WeakThis(this);
						AsyncTask(ENamedThreads::GameThread, [WeakThis, Pixels]()
						{
							if (WeakThis.IsValid())
							{
								WeakThis->OnFrameReady(Pixels.ToSharedRef());
							}
						});
					}
				}
			}
			if (!bCopyInFlight.load())
			{
				if (FRHITexture* Tex = RTResource ? RTResource->GetRenderTargetTexture() : nullptr)
				{
					Readback->EnqueueCopy(RHICmdList, Tex);
					bCopyInFlight.store(true);
				}
			}
		});
}

void APetCapturePawn::ReplaySessionPanelPresentation()
{
	if (!SessionPanelWidget || !SessionWindowHost || !SessionWindowHost->IsVisible())
	{
		return;
	}

	SessionPanelWidget->PlayPanelContentAnimation();
	SessionPanelWidget->ReplayVisibleRowAnimations();
}

void APetCapturePawn::AdjustCameraRotation(float DeltaX, float DeltaY)
{
	if (CameraManagerComponent)
	{
		CameraManagerComponent->AddRotationInput(DeltaX, DeltaY);
	}
}

void APetCapturePawn::AdjustCameraZoom(float WheelDelta)
{
	if (CameraManagerComponent)
	{
		CameraManagerComponent->AddZoomInput(WheelDelta);
	}
}

void APetCapturePawn::ApplyCameraCursorImage()
{
	if (!PetWindow)
	{
		return;
	}
	// 光标图是编译期内嵌常量（tools/extract-camera-cursor-image.ts 由源图生成），不走运行时
	// 纹理加载——UE 5.8 PIE 下纹理 BulkData 受异步编译/惰性加载影响可能读不到。
	PetWindow->SetCameraCursorImage(CameraCursorImageData::Bgra, CameraCursorImageData::Width, CameraCursorImageData::Height);
}

void APetCapturePawn::OnFrameReady(TSharedRef<TArray<uint8>> Pixels)
{
	if (Pixels->Num() < RTSize * RTSize * 4)
	{
		return;
	}
	// 首个有效 capture 帧之前，回读到的是 RT 的清屏值（全 0）；取反后 A=255 会被 Present 成
	// 不透明黑方块。以左上角背景像素的 alpha 是否非零作为"capture 已产出画面"的门槛
	//（capture 之后背景 alpha=255，即 kSceneColorClearAlpha=1.0）。
	if (!bPresentedValidFrame && Pixels->GetData()[3] == 0)
	{
		return;
	}
	bPresentedValidFrame = true;
	// 诊断：每 300 帧从回读像素计算 alpha 统计（与 Present 内统计对照，排查缓冲区复用问题）
	if (PresentedFrames % 300 == 0)
	{
		const uint8* P = Pixels->GetData();
		int32 A0 = 0, A255 = 0, Amid = 0;
		for (int32 i = 3; i < Pixels->Num(); i += 4)
		{
			if (P[i] == 0) { ++A0; }
			else if (P[i] == 255) { ++A255; }
			else { ++Amid; }
		}
		UE_LOG(LogPet, Verbose, TEXT("OnFrameReady stats: a==0: %d, a==255: %d, mid: %d"), A0, A255, Amid);
	}
	if (PetWindow)
	{
		PetWindow->Present(Pixels->GetData());
	}
	if (++PresentedFrames == 1 || PresentedFrames % 300 == 0)
	{
		UE_LOG(LogPet, Log, TEXT("Presented %d frames"), PresentedFrames);
	}
}

void APetCapturePawn::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	// 先断开控制回调并等待工作线程退出，确保之后不会再触碰 Widget。
	if (MessageChannelComponent)
	{
		MessageChannelComponent->OnPetState.RemoveAll(this);
		MessageChannelComponent->OnSessionsSnapshot.RemoveAll(this);
		MessageChannelComponent->OnSessionStart.RemoveAll(this);
		MessageChannelComponent->OnSessionEnd.RemoveAll(this);
		MessageChannelComponent->OnSessionState.RemoveAll(this);
		MessageChannelComponent->OnShutdown.RemoveAll(this);
		MessageChannelComponent->Stop();
	}

	bSessionPanelTogglePending = false;
	bCloseRequestPending = false;
	ShutdownSessionPanel();

	delete PetWindow;
	PetWindow = nullptr;

	ENQUEUE_RENDER_COMMAND(DestroyPetReadback)(
		[this](FRHICommandListImmediate&)
		{
			delete Readback;
			Readback = nullptr;
		});

	Super::EndPlay(EndPlayReason);
}
