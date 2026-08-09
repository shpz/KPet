#include "PetCapturePawn.h"

#include "Pet.h"
#include "PetControlClient.h"
#include "PetLayeredWindow.h"

#include "Components/SceneCaptureComponent2D.h"
#include "Components/PointLightComponent.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Engine/GameViewportClient.h"
#include "Engine/Engine.h"
#include "TimerManager.h"
#include "Widgets/SWindow.h"
#include "GenericPlatform/GenericWindow.h"
#include "HAL/PlatformMisc.h"

#include "RHIGPUReadback.h"
#include "RenderingThread.h"

#include "Windows/AllowWindowsPlatformTypes.h"
#include <Windows.h>
#include "Windows/HideWindowsPlatformTypes.h"

APetCapturePawn::APetCapturePawn()
{
	PrimaryActorTick.bCanEverTick = true;

	RootComp = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	RootComponent = RootComp;

	Light = CreateDefaultSubobject<UPointLightComponent>(TEXT("Light"));
	Light->SetupAttachment(RootComp);
	Light->SetRelativeLocation(FVector(-200.0, 100.0, 150.0));
	Light->SetIntensity(5000.0f);
	Light->CastShadows = false; // 无接收面，阴影只会污染 alpha

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
	Capture->ShowFlags.SkyLighting = false;
	Capture->ShowFlags.Bloom = false; // bloom 辉光会写进 alpha=0 的背景像素 RGB，ULW 预乘语义下变成加性虚影
}

APetCapturePawn::~APetCapturePawn() = default;

void APetCapturePawn::BeginPlay()
{
	Super::BeginPlay();

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

	ENQUEUE_RENDER_COMMAND(CreatePetReadback)(
		[this](FRHICommandListImmediate&)
		{
			Readback = new FRHIGPUTextureReadback(TEXT("KimiPetReadback"));
		});

	// PIE 的 GameViewport 可能挂在编辑器主窗口中，不能对它调用 SW_HIDE。
	// 仅非编辑器运行时隐藏游戏主窗口；主修复仍是启动参数 -RenderOffScreen。
	if (!GIsEditor)
	{
		if (UWorld* World = GetWorld())
		{
			FTimerHandle Timer;
			World->GetTimerManager().SetTimer(Timer, FTimerDelegate::CreateUObject(this, &APetCapturePawn::HideGameWindow), 1.0f, false);
		}
	}

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
			UE_LOG(LogPet, Log, TEXT("单击宠物 -> 发送 open_tui (source=pet)"));
			if (ControlClient)
			{
				ControlClient->SendOpenTui();
			}
		};
		PetWindow->OnDragEnd = [this](int32 X, int32 Y)
		{
			UE_LOG(LogPet, Log, TEXT("拖拽结束 (%d,%d) -> 发送 pet_moved"), X, Y);
			if (ControlClient)
			{
				ControlClient->SendPetMoved(X, Y);
			}
		};
	}
	ControlClient->Start();

	UE_LOG(LogPet, Log, TEXT("PetCapturePawn BeginPlay done"));
}

void APetCapturePawn::HideGameWindow()
{
	// BeginPlay 已阻止 PIE 调用；这里再做保护，避免其他调用路径误隐藏编辑器窗口。
	if (GIsEditor)
	{
		return;
	}

	HWND GameHwnd = nullptr;
	if (GEngine && GEngine->GameViewport)
	{
		if (TSharedPtr<SWindow> SlateWin = GEngine->GameViewport->GetWindow())
		{
			if (TSharedPtr<FGenericWindow> NativeWin = SlateWin->GetNativeWindow())
			{
				GameHwnd = static_cast<HWND>(NativeWin->GetOSWindowHandle());
			}
		}
	}
	if (GameHwnd)
	{
		ShowWindow(GameHwnd, SW_HIDE);
		UE_LOG(LogPet, Log, TEXT("Game window hidden (HWND=%p)"), GameHwnd);
	}
	else
	{
		// -RenderOffScreen 启动时游戏窗口从不可见/不存在，属预期情况
		UE_LOG(LogPet, Verbose, TEXT("Game window handle not found (expected with -RenderOffScreen)"));
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
	// 先停控制管道（等待工作线程退出，回调不再触发），再销毁窗口
	if (ControlClient)
	{
		ControlClient->Shutdown();
		delete ControlClient;
		ControlClient = nullptr;
	}

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
