#include "Player/PetCapturePawn.h"

#include "Pet.h"
#include "Animation/PetComputerAnimInstance.h"
#include "Communication/PetMessageChannelComponent.h"
#include "Platform/CameraCursorImageData.h"
#include "Platform/PetLayeredWindow.h"
#include "Platform/PetWindowDpi.h"
#include "Player/PetCameraManagerComponent.h"
#include "Player/PetCharacterMotionComponent.h"
#include "Player/PetSceneSlotComponent.h"
#include "UI/PetSessionWebBridge.h"
#include "UI/PetSessionWebPanel.h"
#include "UI/PetSettingsWebBridge.h"
#include "UI/PetSettingsWebPanel.h"
#include "UI/PetSessionWindowHost.h"

#include "Components/SceneCaptureComponent2D.h"
#include "Components/SkeletalMeshComponent.h"
#include "Engine/TextureRenderTarget2D.h"
#include "HAL/PlatformApplicationMisc.h"
#include "HAL/PlatformMisc.h"
#include "HAL/PlatformTime.h"
#include "Layout/SlateRect.h"

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

	// 320 是 96 DPI 基准下的逻辑尺寸。自建 Win 分层窗口不会替我们应用 Slate DPI，
	// 因此 RT、DIB 与窗口都必须显式换算为当前显示器的物理像素尺寸。
	const float InitialDpiScale = FPlatformApplicationMisc::GetDPIScaleFactorAtPoint(
		static_cast<float>(InitialWindowX),
		static_cast<float>(InitialWindowY));
	RenderTargetPixelSize = PetWindowDpi::LogicalToPhysicalSize(LogicalPetWindowSize, InitialDpiScale);

	// DPI 对应尺寸的 BGRA8 RT，清屏为全透明
	RenderTarget = NewObject<UTextureRenderTarget2D>(this);
	RenderTarget->RenderTargetFormat = ETextureRenderTargetFormat::RTF_RGBA8;
	RenderTarget->bForceLinearGamma = false;
	RenderTarget->ClearColor = FLinearColor(0.0f, 0.0f, 0.0f, 0.0f);
	RenderTarget->InitCustomFormat(RenderTargetPixelSize, RenderTargetPixelSize, PF_B8G8R8A8, false);
	RenderTarget->UpdateResourceImmediate(true);
	CaptureComponent->TextureTarget = RenderTarget;

	// 游戏线程创建窗口（UE 主消息循环会顺带泵它的消息）
	PetWindow = MakeUnique<PetLayeredWindow>();
	if (!PetWindow->Create(RenderTargetPixelSize, InitialWindowX, InitialWindowY))
	{
		UE_LOG(LogPet, Error, TEXT("Failed to create layered window"));
		PetWindow.Reset();
	}
	else
	{
		WindowScreenPosition = PetWindow->GetScreenPosition();
	}
	ApplyCameraCursorImage();
	InitializePanels();

	ENQUEUE_RENDER_COMMAND(CreatePetReadback)(
		[this](FRHICommandListImmediate&)
		{
			Readback = new FRHIGPUTextureReadback(TEXT("KPetReadback"));
		});

	MessageChannelComponent->OnPetState.AddUObject(this, &APetCapturePawn::HandlePetState);
	MessageChannelComponent->OnSessionsSnapshot.AddUObject(this, &APetCapturePawn::HandleSessionsSnapshot);
	MessageChannelComponent->OnConfigSnapshot.AddUObject(this, &APetCapturePawn::HandleConfigSnapshot);
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
		PetWindow->OnHotKey = [this]()
		{
			UE_LOG(LogPet, Log, TEXT("Ctrl+, 热键 -> 排队切换设置面板"));
			bSettingsPanelTogglePending = true;
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
		PetWindow->OnDpiScaleChanged = [this](float DpiScale)
		{
			RequestPetSurfaceResize(DpiScale);
		};
	}
	UE_LOG(LogPet, Log, TEXT("桌宠 DPI 初始化: 逻辑尺寸=%d，缩放=%.2f，物理尺寸=%d"),
		LogicalPetWindowSize, InitialDpiScale, RenderTargetPixelSize);
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

void APetCapturePawn::InitializePanels()
{
	// ---- 会话面板（仅 WebUI 路径：创建失败只记日志，不再回退 UMG） ----
	SessionWebPanel = MakeUnique<FPetSessionWebPanel>();
	if (!SessionWebPanel->Create())
	{
		UE_LOG(LogPet, Error, TEXT("创建 WebUI 会话面板失败；宠物本体将继续运行"));
		SessionWebPanel.Reset();
		return;
	}

	SessionWindowHost = MakeUnique<FPetSessionWindowHost>();
	if (!SessionWindowHost->Create(SessionWebPanel->GetContentWidget()))
	{
		UE_LOG(LogPet, Error, TEXT("创建 Slate 会话窗口失败；宠物本体将继续运行"));
		SessionWindowHost.Reset();
		SessionWebPanel.Reset();
		return;
	}

	if (UPetSessionWebBridge* Bridge = SessionWebPanel->GetBridge())
	{
		Bridge->OnSelectSession.AddUObject(this, &APetCapturePawn::HandleSessionSelected);
		Bridge->OnReportFps.AddUObject(this, &APetCapturePawn::HandleReportFps);
		// × 按钮的关闭经 Pawn 处理，关闭时按栈语义弹栈恢复被压置的另一面板。
		Bridge->OnCloseRequested.AddUObject(this, &APetCapturePawn::HandleCloseSession);
	}

	// ---- 设置面板（Ctrl+, 打开；窗口与 settings.html 的圆角卡片同尺寸） ----
	SettingsWebPanel = MakeUnique<FPetSettingsWebPanel>();
	if (!SettingsWebPanel->Create())
	{
		UE_LOG(LogPet, Error, TEXT("创建 WebUI 设置面板失败；宠物本体与 Ctrl+, 不可用"));
		SettingsWebPanel.Reset();
	}
	else
	{
		SettingsWindowHost = MakeUnique<FPetSessionWindowHost>();
		// 卡片直接铺满客户区，避免透明留白在综合色键失效时露出黑色矩形。
		SettingsWindowHost->SetClientSize(FVector2f(340.0f, 270.0f));
		if (!SettingsWindowHost->Create(SettingsWebPanel->GetContentWidget()))
		{
			UE_LOG(LogPet, Error, TEXT("创建 Slate 设置窗口失败；设置面板不可用"));
			SettingsWindowHost.Reset();
			SettingsWebPanel.Reset();
		}
		else if (UPetSettingsWebBridge* Bridge = SettingsWebPanel->GetBridge())
		{
			Bridge->OnSetOpenTarget.AddUObject(this, &APetCapturePawn::HandleSetOpenTarget);
			Bridge->OnSetTheme.AddUObject(this, &APetCapturePawn::HandleSetTheme);
			Bridge->OnSetFpsMonitor.AddUObject(this, &APetCapturePawn::HandleSetFpsMonitor);
			Bridge->OnReportFps.AddUObject(this, &APetCapturePawn::HandleReportFps);
			// × 按钮的关闭经 Pawn 处理，关闭时按栈语义弹栈恢复被压置的另一面板。
			Bridge->OnCloseSettings.AddUObject(this, &APetCapturePawn::HandleCloseSettings);
		}
	}

	UpdateSessionPanelAnchor();
	if (SettingsWindowHost)
	{
		UpdateSettingsPanelAnchor();
	}
	UE_LOG(LogPet, Log, TEXT("WebUI 会话面板%s已初始化"), SettingsWindowHost ? TEXT("与设置面板") : TEXT(""));
}

void APetCapturePawn::ShutdownPanels()
{
	bSessionPanelTogglePending = false;
	bSettingsPanelTogglePending = false;
	// 面板销毁前先置隐藏标志，阻止销毁 / 释放期间任何 JS 下发（页内 Bridge 反调在此之前摘除）。
	if (SessionWebPanel)
	{
		SessionWebPanel->SetPanelVisible(false);
	}
	if (SettingsWebPanel)
	{
		SettingsWebPanel->SetPanelVisible(false);
	}
	// 面板全部销毁后栈状态必须清空，避免残留导致下次打开行为异常。
	PanelStack = PetPanelStack::Reset();

	// 先解绑 Web 桥委托并释放面板，再销毁 Host：句柄解绑在前，避免 Host 销毁后
	// 桥仍持有失效的裸指针委托。
	if (SessionWebPanel)
	{
		if (UPetSessionWebBridge* Bridge = SessionWebPanel->GetBridge())
		{
			Bridge->OnSelectSession.RemoveAll(this);
			Bridge->OnReportFps.RemoveAll(this);
			Bridge->OnCloseRequested.RemoveAll(this);
		}
		SessionWebPanel.Reset();
	}

	if (SessionWindowHost)
	{
		SessionWindowHost->Destroy();
		SessionWindowHost.Reset();
	}

	if (SettingsWebPanel)
	{
		if (UPetSettingsWebBridge* Bridge = SettingsWebPanel->GetBridge())
		{
			Bridge->OnSetOpenTarget.RemoveAll(this);
			Bridge->OnSetTheme.RemoveAll(this);
			Bridge->OnSetFpsMonitor.RemoveAll(this);
			Bridge->OnReportFps.RemoveAll(this);
			Bridge->OnCloseSettings.RemoveAll(this);
		}
		SettingsWebPanel.Reset();
	}

	if (SettingsWindowHost)
	{
		SettingsWindowHost->Destroy();
		SettingsWindowHost.Reset();
	}
}

void APetCapturePawn::RequestPetSurfaceResize(float DpiScale)
{
	const int32 RequestedPixelSize = PetWindowDpi::LogicalToPhysicalSize(LogicalPetWindowSize, DpiScale);
	PendingPetSurfacePixelSize = RequestedPixelSize != RenderTargetPixelSize
		? RequestedPixelSize
		: 0;
}

void APetCapturePawn::ApplyPendingPetSurfaceResize()
{
	const int32 RequestedPixelSize = PendingPetSurfacePixelSize;
	PendingPetSurfacePixelSize = 0;
	if (RequestedPixelSize <= 0 || RequestedPixelSize == RenderTargetPixelSize || !PetWindow || !RenderTarget)
	{
		return;
	}

	const int32 PreviousPixelSize = RenderTargetPixelSize;
	if (!PetWindow->Resize(RequestedPixelSize))
	{
		UE_LOG(LogPet, Error, TEXT("无法把桌宠窗口调整为 DPI 对应尺寸 %d，继续使用 %d"),
			RequestedPixelSize, PreviousPixelSize);
		return;
	}

	// ResizeTarget 与下方回读重建命令按提交顺序在渲染线程执行。FRHIGPUTextureReadback
	// 的复用契约要求源纹理尺寸固定，因此 DPI 改变时必须等待旧副本并重建 staging 纹理。
	RenderTargetPixelSize = RequestedPixelSize;
	bPresentedValidFrame = false;
	RenderTarget->ResizeTarget(RequestedPixelSize, RequestedPixelSize);
	ENQUEUE_RENDER_COMMAND(RecreatePetReadbackForDpi)(
		[this](FRHICommandListImmediate& RHICmdList)
		{
			if (Readback)
			{
				if (bCopyInFlight.load())
				{
					Readback->Wait(RHICmdList, Readback->GetLastCopyGPUMask());
				}
				delete Readback;
			}
			Readback = new FRHIGPUTextureReadback(TEXT("KPetReadback"));
			ReadbackPixelSize = 0;
			bCopyInFlight.store(false);
		});

	UE_LOG(LogPet, Log, TEXT("桌宠渲染表面随 DPI 调整: %d -> %d 物理像素"),
		PreviousPixelSize, RequestedPixelSize);
}

FSlateRect APetCapturePawn::ComputePetBoundsInScreenPixels() const
{
	// SWindow::GetSizeInScreen、MoveWindowTo 与 SlateApplication::GetWorkArea 都使用
	// 平台屏幕物理像素；桌宠分层窗口也使用同一坐标系，因此这里不做 DPI 除法。
	const FIntPoint PetPositionPhysicalPixels = PetWindow->GetScreenPosition();
	const float PetSizePhysicalPixels = static_cast<float>(PetWindow->GetPixelSize());
	return FSlateRect(
		static_cast<float>(PetPositionPhysicalPixels.X),
		static_cast<float>(PetPositionPhysicalPixels.Y),
		PetPositionPhysicalPixels.X + PetSizePhysicalPixels,
		PetPositionPhysicalPixels.Y + PetSizePhysicalPixels);
}

void APetCapturePawn::UpdateSessionPanelAnchor()
{
	if (!SessionWindowHost || !PetWindow)
	{
		return;
	}
	SessionWindowHost->UpdateAnchor(ComputePetBoundsInScreenPixels());
}

void APetCapturePawn::UpdateSettingsPanelAnchor()
{
	if (!SettingsWindowHost || !PetWindow)
	{
		return;
	}
	SettingsWindowHost->UpdateAnchor(ComputePetBoundsInScreenPixels());
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
	// 选中会话后关闭会话面板；若设置面板被压栈则一并弹栈恢复。
	HandleCloseSession();
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
	if (SessionWebPanel)
	{
		SessionWebPanel->ApplySnapshot(Sessions);
	}
}

void APetCapturePawn::HandleConfigSnapshot(const FPetSettingsSnapshot& Snapshot)
{
	// 守护进程权威快照：整体对齐本地状态（设置面板乐观更新后以回推为准收敛）。
	CurrentSettings = Snapshot;

	if (SessionWebPanel)
	{
		SessionWebPanel->SetTheme(Snapshot.UiTheme);
		SessionWebPanel->SetFpsMonitor(Snapshot.bFpsMonitor);
	}
	// 快照始终进设置面板缓存：面板已打开时即时上屏，未打开时缓存到打开/加载完成再推。
	if (SettingsWebPanel)
	{
		SettingsWebPanel->ApplySnapshot(Snapshot);
	}
	if (PetWindow)
	{
		PetWindow->SetFpsOverlayEnabled(Snapshot.bFpsMonitor);
		PetWindow->SetFpsValues(WorldFps, WebFps);
	}
	UE_LOG(LogPet, Log, TEXT("已应用配置快照: open_target=%s ui_theme=%s fps_monitor=%d"),
		*Snapshot.OpenTarget, *Snapshot.UiTheme, Snapshot.bFpsMonitor ? 1 : 0);
}

void APetCapturePawn::HandleSetOpenTarget(const FString& Target)
{
	// 乐观更新本地；快照回推后经 HandleConfigSnapshot 对齐（设置页本地已由 JS 自更）。
	CurrentSettings.OpenTarget = Target;
	if (MessageChannelComponent)
	{
		FPetConfigPatch Patch;
		Patch.OpenTarget = Target;
		MessageChannelComponent->SendUpdateConfig(Patch);
	}
}

void APetCapturePawn::HandleSetTheme(const FString& ThemeId)
{
	CurrentSettings.UiTheme = ThemeId;
	// 乐观应用会话面板主题，快照回推后再对齐，避免等待往返的视觉延迟。
	if (SessionWebPanel)
	{
		SessionWebPanel->SetTheme(ThemeId);
	}
	if (MessageChannelComponent)
	{
		FPetConfigPatch Patch;
		Patch.UiTheme = ThemeId;
		MessageChannelComponent->SendUpdateConfig(Patch);
	}
}

void APetCapturePawn::HandleSetFpsMonitor(bool bEnabled)
{
	CurrentSettings.bFpsMonitor = bEnabled;
	// 乐观同步：叠加层、会话面板上报开关即时切换；设置页已由 JS 自更。
	if (SessionWebPanel)
	{
		SessionWebPanel->SetFpsMonitor(bEnabled);
	}
	if (PetWindow)
	{
		PetWindow->SetFpsOverlayEnabled(bEnabled);
		PetWindow->SetFpsValues(WorldFps, WebFps);
	}
	if (MessageChannelComponent)
	{
		FPetConfigPatch Patch;
		Patch.FpsMonitor = bEnabled;
		MessageChannelComponent->SendUpdateConfig(Patch);
	}
}

void APetCapturePawn::ApplyPanelStackStep(const FPetPanelStackStep& Step)
{
	// 栈推进执行：先关闭被压栈的面板，再打开目标（含弹栈恢复）面板。
	// 关闭/打开沿用各面板原有的锚点与快照惯例，保证动画衔接一致。
	if (Step.Close == EPetPanel::Session && SessionWindowHost)
	{
		SessionWindowHost->Close();
		if (SessionWebPanel)
		{
			// 压栈隐藏：CEF 已停帧，隐藏期 JS 一律不下发，恢复可见时经 SetPanelVisible 全量重放。
			SessionWebPanel->SetPanelVisible(false);
		}
	}
	else if (Step.Close == EPetPanel::Settings && SettingsWindowHost)
	{
		SettingsWindowHost->Close();
		if (SettingsWebPanel)
		{
			SettingsWebPanel->SetPanelVisible(false);
		}
	}

	if (Step.Open == EPetPanel::Session && SessionWindowHost && SessionWebPanel)
	{
		UpdateSessionPanelAnchor();
		SessionWindowHost->Toggle();
		// ShowWindow 已同步完成后置可见标志；页面就绪时推送全量状态。
		SessionWebPanel->SetPanelVisible(true);
	}
	else if (Step.Open == EPetPanel::Settings && SettingsWindowHost && SettingsWebPanel)
	{
		UpdateSettingsPanelAnchor();
		// 打开/恢复前推一次快照：此刻面板仍隐藏、ApplySnapshot 只入缓存不下发；
		// Toggle 显示后 SetPanelVisible(true) 触发重放，保证页面（含 FPS 上报开关）与本地状态一致。
		SettingsWebPanel->ApplySnapshot(CurrentSettings);
		SettingsWindowHost->Toggle();
		SettingsWebPanel->SetPanelVisible(true);
	}
}

void APetCapturePawn::HandleCloseSettings()
{
	if (!SettingsWindowHost || !SettingsWebPanel)
	{
		return;
	}
	FPetPanelStackStep Step;
	PanelStack = PetPanelStack::Close(PanelStack, EPetPanel::Settings, Step);
	ApplyPanelStackStep(Step);
}

void APetCapturePawn::HandleCloseSession()
{
	if (!SessionWindowHost || !SessionWebPanel)
	{
		return;
	}
	FPetPanelStackStep Step;
	PanelStack = PetPanelStack::Close(PanelStack, EPetPanel::Session, Step);
	ApplyPanelStackStep(Step);
}

void APetCapturePawn::HandleReportFps(int32 Fps)
{
	// 会话面板与设置面板的 reportfps 都汇入同一"WebUI 帧率"，取最近上报值。
	WebFps = Fps;
	if (PetWindow)
	{
		PetWindow->SetFpsValues(WorldFps, WebFps);
	}
}

void APetCapturePawn::ToggleSettingsPanel()
{
	if (!SettingsWindowHost || !SettingsWebPanel)
	{
		UE_LOG(LogPet, Warning, TEXT("设置面板资源未就绪，Ctrl+, 热键忽略"));
		return;
	}
	FPetPanelStackStep Step;
	PanelStack = PetPanelStack::Toggle(PanelStack, EPetPanel::Settings, Step);
	ApplyPanelStackStep(Step);
}

void APetCapturePawn::ToggleSessionPanel()
{
	if (!SessionWindowHost || !SessionWebPanel)
	{
		UE_LOG(LogPet, Warning, TEXT("会话面板资源未就绪，保持宠物本体可用"));
		return;
	}
	FPetPanelStackStep Step;
	PanelStack = PetPanelStack::Toggle(PanelStack, EPetPanel::Session, Step);
	ApplyPanelStackStep(Step);
}

void APetCapturePawn::HandleSessionStart(const FString& SessionId, const FString& Cwd, bool bResume)
{
	if (SessionWebPanel)
	{
		SessionWebPanel->AddOrUpdateSession(SessionId, FString(), Cwd, true);
	}
}

void APetCapturePawn::HandleSessionEnd(const FString& SessionId, const FString& Reason)
{
	if (SessionWebPanel)
	{
		SessionWebPanel->SetSessionActive(SessionId, false);
	}
}

void APetCapturePawn::HandleSessionState(const FString& SessionId, bool bWorking, bool bUnread)
{
	if (SessionWebPanel)
	{
		SessionWebPanel->UpdateSessionState(SessionId, bWorking, bUnread);
	}
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
	bSettingsPanelTogglePending = false;
	ShutdownPanels();
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

	// 3D 世界帧率：以 Tick 次数近似每渲染帧计数，每秒结算一次并推送叠加层。
	{
		const double Now = FPlatformTime::Seconds();
		if (WorldFpsStatsStartTime <= 0.0)
		{
			WorldFpsStatsStartTime = Now;
		}
		++WorldFpsFramesInWindow;
		const double Elapsed = Now - WorldFpsStatsStartTime;
		if (Elapsed >= 1.0)
		{
			WorldFps = FMath::Max(0, FMath::RoundToInt(WorldFpsFramesInWindow / Elapsed));
			WorldFpsFramesInWindow = 0;
			WorldFpsStatsStartTime = Now;
			if (PetWindow)
			{
				PetWindow->SetFpsValues(WorldFps, WebFps);
			}
		}
	}

	if (PetWindow)
	{
		WindowScreenPosition = PetWindow->GetScreenPosition();
		PetWindow->Tick(DeltaTime);
	}
	ApplyPendingPetSurfaceResize();
	if (bSessionPanelTogglePending)
	{
		bSessionPanelTogglePending = false;
		ToggleSessionPanel();
	}
	if (SessionWindowHost)
	{
		if (SessionWindowHost->IsVisible())
		{
			UpdateSessionPanelAnchor();
		}
		SessionWindowHost->TickWindowAnimation(DeltaTime);
		// 隐藏后重显时，宿主先让 CEF 退出 WasHidden，再允许会话页提交快照与整页刷新。
		// 这样不会把隐藏期积压的列表更新写进尚未稳定的软件纹理，留下视觉重复行。
		if (SessionWebPanel && SessionWindowHost->ConsumeContentSurfaceReady())
		{
			SessionWebPanel->NotifyWindowSurfaceReady();
		}
	}

	// Ctrl+, 切换设置面板；显隐动画与锚点与会话面板一致。
	if (bSettingsPanelTogglePending)
	{
		bSettingsPanelTogglePending = false;
		ToggleSettingsPanel();
	}
	if (SettingsWindowHost)
	{
		if (SettingsWindowHost->IsVisible())
		{
			UpdateSettingsPanelAnchor();
		}
		SettingsWindowHost->TickWindowAnimation(DeltaTime);
		// 设置页同样使用透明 CEF 软件纹理；必须等宿主预热结束后再重放设置快照，
		// 否则首次打开或压栈恢复会把旧纹理直接暴露到桌面。
		if (SettingsWebPanel && SettingsWindowHost->ConsumeContentSurfaceReady())
		{
			SettingsWebPanel->NotifyWindowSurfaceReady();
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
					const int32 CompletedPixelSize = ReadbackPixelSize;
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
						AsyncTask(ENamedThreads::GameThread, [
							WeakThis,
							Pixels,
							CompletedPixelSize,
							RowPitchPixels,
							BufferHeight]()
						{
							if (WeakThis.IsValid())
							{
								WeakThis->OnFrameReady(
									Pixels.ToSharedRef(),
									CompletedPixelSize,
									RowPitchPixels,
									BufferHeight);
							}
						});
					}
				}
			}
			if (!bCopyInFlight.load())
			{
				if (FRHITexture* Tex = RTResource ? RTResource->GetRenderTargetTexture() : nullptr)
				{
					const FIntVector TextureSize = Tex->GetSizeXYZ();
					if (TextureSize.X > 0 && TextureSize.X == TextureSize.Y)
					{
						ReadbackPixelSize = TextureSize.X;
						Readback->EnqueueCopy(RHICmdList, Tex);
						bCopyInFlight.store(true);
					}
				}
			}
		});
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

void APetCapturePawn::OnFrameReady(
	TSharedRef<TArray<uint8>> Pixels,
	int32 SourcePixelSize,
	int32 SourceRowPitchPixels,
	int32 SourceBufferHeight)
{
	const int64 RequiredBytes = static_cast<int64>(SourceRowPitchPixels) * SourcePixelSize * 4;
	if (SourcePixelSize != RenderTargetPixelSize ||
		SourceRowPitchPixels < SourcePixelSize ||
		SourceBufferHeight < SourcePixelSize ||
		RequiredBytes <= 0 ||
		Pixels->Num() < RequiredBytes)
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
		for (int32 Y = 0; Y < SourcePixelSize; ++Y)
		{
			const uint8* Row = P + static_cast<int64>(Y) * SourceRowPitchPixels * 4;
			for (int32 X = 0; X < SourcePixelSize; ++X)
			{
				const uint8 A = Row[X * 4 + 3];
				if (A == 0) { ++A0; }
				else if (A == 255) { ++A255; }
				else { ++Amid; }
			}
		}
		UE_LOG(LogPet, Verbose, TEXT("OnFrameReady stats: a==0: %d, a==255: %d, mid: %d"), A0, A255, Amid);
	}
	if (PetWindow)
	{
		PetWindow->Present(Pixels->GetData(), SourcePixelSize, SourceRowPitchPixels);
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
		MessageChannelComponent->OnConfigSnapshot.RemoveAll(this);
		MessageChannelComponent->OnSessionStart.RemoveAll(this);
		MessageChannelComponent->OnSessionEnd.RemoveAll(this);
		MessageChannelComponent->OnSessionState.RemoveAll(this);
		MessageChannelComponent->OnShutdown.RemoveAll(this);
		MessageChannelComponent->Stop();
	}

	bSessionPanelTogglePending = false;
	bCloseRequestPending = false;
	bSettingsPanelTogglePending = false;
	ShutdownPanels();

	PetWindow.Reset();

	ENQUEUE_RENDER_COMMAND(DestroyPetReadback)(
		[this](FRHICommandListImmediate& RHICmdList)
		{
			if (Readback && bCopyInFlight.load())
			{
				Readback->Wait(RHICmdList, Readback->GetLastCopyGPUMask());
			}
			delete Readback;
			Readback = nullptr;
			ReadbackPixelSize = 0;
			bCopyInFlight.store(false);
		});

	Super::EndPlay(EndPlayReason);
}
