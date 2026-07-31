#include "SpikeCaptureActor.h"

#include "KimiPetSpike.h"
#include "LayeredPetWindow.h"

#include "Components/SceneCaptureComponent2D.h"
#include "Components/StaticMeshComponent.h"
#include "Components/PointLightComponent.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Engine/StaticMesh.h"
#include "Engine/GameViewportClient.h"
#include "Engine/Engine.h"
#include "Materials/MaterialInterface.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "UObject/ConstructorHelpers.h"
#include "TimerManager.h"
#include "Widgets/SWindow.h"
#include "GenericPlatform/GenericWindow.h"

#include "RHIGPUReadback.h"
#include "RenderingThread.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/FileManager.h"

#include "Windows/AllowWindowsPlatformTypes.h"
#include <Windows.h>
#include "Windows/HideWindowsPlatformTypes.h"

ASpikeCaptureActor::ASpikeCaptureActor()
{
	PrimaryActorTick.bCanEverTick = true;

	RootComp = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	RootComponent = RootComp;

	Sphere = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Sphere"));
	Sphere->SetupAttachment(RootComp);
	Sphere->SetRelativeLocation(FVector::ZeroVector);
	Sphere->SetWorldScale3D(FVector(2.0f)); // 基础球直径 1m -> 2m（与设计稿一致）
	Sphere->CastShadow = false; // 无地面，投影只会给 RT 底部带来半透阴影

	static ConstructorHelpers::FObjectFinder<UStaticMesh> SphereMesh(TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	if (SphereMesh.Succeeded())
	{
		Sphere->SetStaticMesh(SphereMesh.Object);
	}

	// 用引擎自带的材质实例作父材质：直接用 BasicShapeMaterial 创建 MID 会丢失内部参数映射，
	// 导致 Color 参数不生效（本次 spike 实测踩坑：球体渲染成了灰白）。
	static ConstructorHelpers::FObjectFinder<UMaterialInterface> ShapeMatInst(TEXT("/Engine/BasicShapes/BasicShapeMaterial_Inst.BasicShapeMaterial_Inst"));
	if (ShapeMatInst.Succeeded())
	{
		Sphere->SetMaterial(0, ShapeMatInst.Object);
	}

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
	Capture->ShowFlags.DynamicShadows = false; // 球体无接收面，动态阴影只会污染背景 alpha
	Capture->ShowFlags.Fog = false;             // 背景像素只应有 alpha=0
	Capture->ShowFlags.VolumetricFog = false;
	Capture->ShowFlags.Cloud = false;
	Capture->ShowFlags.SkyLighting = false;
}

ASpikeCaptureActor::~ASpikeCaptureActor() = default;

void ASpikeCaptureActor::BeginPlay()
{
	Super::BeginPlay();

	// 宠物体色（Kimi 蓝）——spike 顺手验证颜色通道顺序（BGRA）是否正确
	// 注意：必须用引擎材质实例做父材质；直接用 BasicShapeMaterial 创建 MID 会丢失内部参数映射，
	// 导致 Color 参数不生效（本次 spike 实测踩坑：球体渲染成了灰白）。
	if (UMaterialInstanceDynamic* MID = Sphere->CreateAndSetMaterialInstanceDynamic(0))
	{
		MID->SetVectorParameterValue(TEXT("Color"), FLinearColor(0.24f, 0.35f, 1.0f));
	}

	// 320x320 BGRA8 RT，清屏为全透明
	RenderTarget = NewObject<UTextureRenderTarget2D>(this);
	RenderTarget->RenderTargetFormat = ETextureRenderTargetFormat::RTF_RGBA8;
	RenderTarget->bForceLinearGamma = false;
	RenderTarget->ClearColor = FLinearColor(0.0f, 0.0f, 0.0f, 0.0f);
	RenderTarget->InitCustomFormat(RTSize, RTSize, PF_B8G8R8A8, false);
	RenderTarget->UpdateResourceImmediate(true);
	Capture->TextureTarget = RenderTarget;

	// 游戏线程创建窗口（UE 主消息循环会顺带泵它的消息）
	PetWindow = new FLayeredPetWindow();
	if (!PetWindow->Create(RTSize, 150, 150))
	{
		UE_LOG(LogKimiPetSpike, Error, TEXT("Failed to create layered window"));
		delete PetWindow;
		PetWindow = nullptr;
	}

	ENQUEUE_RENDER_COMMAND(CreateSpikeReadback)(
		[this](FRHICommandListImmediate&)
		{
			Readback = new FRHIGPUTextureReadback(TEXT("KimiPetSpikeReadback"));
		});

	// 游戏窗口完全初始化后再隐藏，避免启动闪烁
	if (UWorld* World = GetWorld())
	{
		FTimerHandle Timer;
		World->GetTimerManager().SetTimer(Timer, FTimerDelegate::CreateUObject(this, &ASpikeCaptureActor::HideGameWindow), 1.0f, false);
	}

	UE_LOG(LogKimiPetSpike, Log, TEXT("SpikeCaptureActor BeginPlay done"));
}

void ASpikeCaptureActor::HideGameWindow()
{
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
		UE_LOG(LogKimiPetSpike, Log, TEXT("Game window hidden (HWND=%p)"), GameHwnd);
	}
	else
	{
		UE_LOG(LogKimiPetSpike, Warning, TEXT("Game window handle not found"));
	}
}

void ASpikeCaptureActor::Tick(float DeltaTime)
{
	Super::Tick(DeltaTime);

	if (!RenderTarget)
	{
		return;
	}

	FTextureRenderTargetResource* RTResource = RenderTarget->GameThread_GetRenderTargetResource();
	ENQUEUE_RENDER_COMMAND(SpikeReadbackTick)(
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
						TWeakObjectPtr<ASpikeCaptureActor> WeakThis(this);
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
			else
			{
				if (FRHITexture* Tex = RTResource ? RTResource->GetRenderTargetTexture() : nullptr)
				{
					Readback->EnqueueCopy(RHICmdList, Tex);
					bCopyInFlight.store(true);
				}
			}
		});
}

void ASpikeCaptureActor::OnFrameReady(TSharedRef<TArray<uint8>> Pixels)
{
	if (Pixels->Num() < RTSize * RTSize * 4)
	{
		return;
	}
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
		UE_LOG(LogKimiPetSpike, Log, TEXT("OnFrameReady stats: a==0: %d, a==255: %d, mid: %d"), A0, A255, Amid);
	}
	// 诊断：PresentedFrames==0 时（首帧）直接落盘原始回读像素，不经过 Present
	if (false && PresentedFrames == 0)
	{
		FString Dir = FPaths::ProjectSavedDir() / TEXT("Diag2");
		IFileManager::Get().MakeDirectory(*Dir, true);
		const uint8* P = Pixels->GetData();
		auto SavePPM = [&](const TCHAR* Name, int Channel)
		{
			FString Content = FString::Printf(TEXT("P3\n%d %d\n255\n"), RTSize, RTSize);
			for (int32 i = 0; i < RTSize * RTSize; ++i)
			{
				const uint8 V = P[i * 4 + Channel];
				Content += FString::Printf(TEXT("%d %d %d "), V, V, V);
			}
			FFileHelper::SaveStringToFile(Content, *(Dir / Name));
		};
		SavePPM(TEXT("r.ppm"), 2);
		SavePPM(TEXT("g.ppm"), 1);
		SavePPM(TEXT("b.ppm"), 0);
		SavePPM(TEXT("a.ppm"), 3);
		UE_LOG(LogKimiPetSpike, Log, TEXT("Diag2: first frame dumped from OnFrameReady"));
	}
	if (PetWindow)
	{
		PetWindow->Present(Pixels->GetData());
	}
	if (++PresentedFrames == 1 || PresentedFrames % 300 == 0)
	{
		UE_LOG(LogKimiPetSpike, Log, TEXT("Presented %d frames"), PresentedFrames);
	}
}

void ASpikeCaptureActor::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	delete PetWindow;
	PetWindow = nullptr;

	ENQUEUE_RENDER_COMMAND(DestroySpikeReadback)(
		[this](FRHICommandListImmediate&)
		{
			delete Readback;
			Readback = nullptr;
		});

	Super::EndPlay(EndPlayReason);
}
