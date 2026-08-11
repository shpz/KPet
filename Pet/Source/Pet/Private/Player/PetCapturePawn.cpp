#include "Player/PetCapturePawn.h"

#include "Pet.h"
#include "Communication/PetControlClient.h"
#include "Platform/PetLayeredWindow.h"
#include "UI/PetSessionPanelWidget.h"
#include "UI/PetSessionWindowHost.h"

#include "Blueprint/UserWidget.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "HAL/PlatformApplicationMisc.h"
#include "HAL/PlatformMisc.h"
#include "Layout/SlateRect.h"

#include "RHIGPUReadback.h"
#include "RenderingThread.h"

APetCapturePawn::APetCapturePawn()
{
	PrimaryActorTick.bCanEverTick = true;

	RootComp = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	RootComponent = RootComp;

	Capture = CreateDefaultSubobject<USceneCaptureComponent2D>(TEXT("Capture"));
	Capture->SetupAttachment(RootComp);
	Capture->SetRelativeLocation(FVector(-350.0, 0.0, 0.0)); // 面向 +X 看向原点
	Capture->FOVAngle = 40.0f;
	Capture->CaptureSource = ESceneCaptureSource::SCS_FinalColorLDR;
	Capture->bCaptureEveryFrame = true;
	Capture->bCaptureOnMovement = false;
	Capture->bAlwaysPersistRenderingState = true;
	Capture->ShowFlags.DynamicShadows = false; // 无接收面，动态阴影只会污染背景 alpha
	Capture->ShowFlags.Fog = false;             // 背景像素只应有 alpha=0
	Capture->ShowFlags.VolumetricFog = false;
	Capture->ShowFlags.Cloud = false;
	Capture->ShowFlags.SkyLighting = true;
	Capture->ShowFlags.Bloom = false; // bloom 辉光会写进 alpha=0 的背景像素 RGB，ULW 预乘语义下变成加性虚影
}

APetCapturePawn::~APetCapturePawn() = default;

void APetCapturePawn::BeginPlay()
{
	Super::BeginPlay();
	const FVector InitialOffset = Capture->GetRelativeLocation();
	CameraDistance = FMath::Clamp(InitialOffset.Size(), CameraMinDistance, FMath::Max(CameraMinDistance, CameraMaxDistance));
	InitialCameraDirection = InitialOffset.GetSafeNormal(UE_SMALL_NUMBER, FVector(-1.0f, 0.0f, 0.0f));
	ApplyCameraTransform();

	// 320x320 BGRA8 RT，清屏为全透明
	RenderTarget = NewObject<UTextureRenderTarget2D>(this);
	RenderTarget->RenderTargetFormat = ETextureRenderTargetFormat::RTF_RGBA8;
	RenderTarget->bForceLinearGamma = false;
	RenderTarget->ClearColor = FLinearColor(0.0f, 0.0f, 0.0f, 0.0f);
	RenderTarget->InitCustomFormat(RTSize, RTSize, PF_B8G8R8A8, false);
	RenderTarget->UpdateResourceImmediate(true);
	Capture->TextureTarget = RenderTarget;

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
	InitializeSessionPanel();

	ENQUEUE_RENDER_COMMAND(CreatePetReadback)(
		[this](FRHICommandListImmediate&)
		{
			Readback = new FRHIGPUTextureReadback(TEXT("KimiPetReadback"));
		});

	// 控制管道客户端：接入守护进程（§4.1 / §4.5-5），回调全部在游戏线程触发
	ControlClient = new FPetControlClient();
	ControlClient->OnShutdown = [this](const FString& Reason)
	{
		if (GIsEditor)
		{
			UE_LOG(LogPet, Warning, TEXT("PIE 调试中忽略 shutdown，避免退出编辑器（reason=%s）"), *Reason);
			return;
		}
		UE_LOG(LogPet, Log, TEXT("shutdown 请求退出游戏（reason=%s）"), *Reason);
		FPlatformMisc::RequestExit(false);
	};
	if (PetWindow)
	{
		PetWindow->OnClick = [this]()
		{
			UE_LOG(LogPet, Log, TEXT("单击宠物 -> 排队切换会话面板"));
			bSessionPanelTogglePending = true;
		};
		PetWindow->OnDragEnd = [this](int32 X, int32 Y)
		{
			UE_LOG(LogPet, Log, TEXT("拖拽结束 (%d,%d) -> 发送 pet_moved"), X, Y);
			if (ControlClient)
			{
				ControlClient->SendPetMoved(X, Y);
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
	ControlClient->OnSessionsSnapshot = [this](const TArray<FPetSessionInfo>& Sessions)
	{
		if (!SessionPanelWidget)
		{
			return;
		}
		SessionPanelWidget->ApplySnapshot(Sessions);
	};
	ControlClient->OnSessionStart = [this](const FString& SessionId, const FString& Cwd, bool bResume)
	{
		if (SessionPanelWidget)
		{
			SessionPanelWidget->AddOrUpdateSession(SessionId, FString(), Cwd, true);
		}
	};
	ControlClient->OnSessionEnd = [this](const FString& SessionId, const FString& Reason)
	{
		if (SessionPanelWidget)
		{
			SessionPanelWidget->SetSessionActive(SessionId, false);
		}
	};
	ControlClient->OnSessionState = [this](const FString& SessionId, bool bWorking, bool bUnread)
	{
		if (SessionPanelWidget)
		{
			SessionPanelWidget->UpdateSessionState(SessionId, bWorking, bUnread);
		}
	};
	ControlClient->Start();

	UE_LOG(LogPet, Log, TEXT("PetCapturePawn BeginPlay done"));
}

void APetCapturePawn::InitializeSessionPanel()
{
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
	if (ControlClient)
	{
		ControlClient->SendOpenTui(SessionId);
	}
	if (SessionWindowHost)
	{
		SessionWindowHost->Close();
	}
}

void APetCapturePawn::Tick(float DeltaTime)
{
	Super::Tick(DeltaTime);

	if (ControlClient)
	{
		ControlClient->Tick(); // 收包转交 + 心跳
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
		if (SessionWindowHost && SessionPanelWidget)
		{
			UpdateSessionPanelAnchor();
			const bool bWasVisible = SessionWindowHost->IsVisible();
			SessionWindowHost->Toggle();
			if (!bWasVisible)
			{
				// 等到下一帧再重播：此时窗口已可见，ListView 条目也完成了 Slate 布局。
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
	CameraYaw = FMath::Clamp(CameraYaw + DeltaX * CameraRotateSensitivity, -CameraYawLimit, CameraYawLimit);
	CameraPitch = FMath::Clamp(CameraPitch + DeltaY * CameraRotateSensitivity, -CameraPitchLimit, CameraPitchLimit);
	ApplyCameraTransform();
	UE_LOG(LogPet, Verbose, TEXT("摄像机旋转调整 yaw=%.2f pitch=%.2f"), CameraYaw, CameraPitch);
}

void APetCapturePawn::AdjustCameraZoom(float WheelDelta)
{
	const float MinDistance = FMath::Min(CameraMinDistance, CameraMaxDistance);
	const float MaxDistance = FMath::Max(CameraMinDistance, CameraMaxDistance);
	CameraDistance = FMath::Clamp(CameraDistance - WheelDelta * CameraZoomStep, MinDistance, MaxDistance);
	ApplyCameraTransform();
	UE_LOG(LogPet, Verbose, TEXT("摄像机距离调整 distance=%.2f"), CameraDistance);
}

void APetCapturePawn::ApplyCameraTransform()
{
	if (!Capture)
	{
		return;
	}
	const FVector Offset = FRotator(CameraPitch, CameraYaw, 0.0f).RotateVector(InitialCameraDirection * CameraDistance);
	Capture->SetRelativeLocation(Offset);
	Capture->SetRelativeRotation((-Offset).Rotation());
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
	if (ControlClient)
	{
		ControlClient->OnPetState = nullptr;
		ControlClient->OnSessionsSnapshot = nullptr;
		ControlClient->OnSessionStart = nullptr;
		ControlClient->OnSessionEnd = nullptr;
		ControlClient->OnSessionState = nullptr;
		ControlClient->OnShutdown = nullptr;
		ControlClient->Shutdown();
		delete ControlClient;
		ControlClient = nullptr;
	}

	bSessionPanelTogglePending = false;
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
