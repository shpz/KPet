// Copyright Epic Games, Inc. All Rights Reserved.

#include "Pet.h"
#include "Modules/ModuleManager.h"

#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Framework/Application/SlateApplication.h"
#include "Widgets/SWindow.h"

DEFINE_LOG_CATEGORY(LogPet);

void FPetModule::StartupModule()
{
	// 编辑器/PIE 下不干预窗口，本模块在编辑器里也会加载。
	if (GIsEditor || !FSlateApplication::IsInitialized())
	{
		return;
	}

	// 记录模块加载前已经存在的窗口。MoviePlayer 在部分打包启动路径中会先创建默认
	// 游戏窗口，因此第一个常规窗口也作为临时目标；GameViewport 可用后再校准。
	for (const TSharedRef<SWindow>& Window : FSlateApplication::Get().GetTopLevelWindows())
	{
		StartupTopLevelWindows.Add(Window);
		if (!GameWindow.IsValid() && Window->IsRegularWindow())
		{
			GameWindow = Window;
		}
	}

	SlatePreTickHandle = FSlateApplication::Get().OnPreTick().Add(
		FSlateApplication::FSlateTickEvent::FDelegate::CreateRaw(this, &FPetModule::HandleSlatePreTick));
	UE_LOG(LogPet, Log, TEXT("默认游戏窗口 Slate 启动守卫已注册"));

	// 极少数启动路径会在模块加载前先显示 MoviePlayer 的窗口。此处先行隐藏，随后
	// OnPreTick 仍会覆盖引擎初始化完成后的再次显示。
	const TSharedPtr<SWindow> ExistingGameWindow = GameWindow.Pin();
	if (ExistingGameWindow.IsValid() && ExistingGameWindow->IsVisible())
	{
		ExistingGameWindow->HideWindow();
		++HiddenWindowCount;
		UE_LOG(LogPet, Log, TEXT("已隐藏模块加载时存在的默认游戏窗口，第 %d 次"), HiddenWindowCount);
	}
}

void FPetModule::ShutdownModule()
{
	RemoveSlatePreTickGuard();
	GameWindow.Reset();
	StartupTopLevelWindows.Reset();
	HiddenWindowCount = 0;
}

bool FPetModule::IsStartupWindow(const SWindow* CandidateWindow) const
{
	if (CandidateWindow == nullptr)
	{
		return false;
	}

	for (const TWeakPtr<SWindow>& StartupWindow : StartupTopLevelWindows)
	{
		const TSharedPtr<SWindow> PinnedWindow = StartupWindow.Pin();
		if (PinnedWindow.Get() == CandidateWindow)
		{
			return true;
		}
	}

	return false;
}

void FPetModule::HandleSlatePreTick(float)
{
	if (!FSlateApplication::IsInitialized())
	{
		return;
	}

	// GameViewport 创建完成后，用公开接口校准目标；它优先于仅依据窗口列表的发现结果。
	if (GEngine != nullptr && GEngine->GameViewport != nullptr)
	{
		const TSharedPtr<SWindow> ViewportWindow = GEngine->GameViewport->GetWindow();
		if (ViewportWindow.IsValid() && ViewportWindow->IsRegularWindow())
		{
			GameWindow = ViewportWindow;
		}
	}

	// 在 GameViewport 尚不可用的启动阶段，从新增的顶层常规窗口中发现默认游戏窗口。
	if (!GameWindow.IsValid())
	{
		for (const TSharedRef<SWindow>& Window : FSlateApplication::Get().GetTopLevelWindows())
		{
			if (Window->IsRegularWindow() && !IsStartupWindow(&Window.Get()))
			{
				GameWindow = Window;
				break;
			}
		}
	}

	const TSharedPtr<SWindow> WindowToHide = GameWindow.Pin();
	if (!WindowToHide.IsValid() || !WindowToHide->IsRegularWindow())
	{
		return;
	}

	// UGameEngine::CreateGameWindow 会在创建时显示并触发一次 Slate Tick，之后首次
	// UGameEngine::Tick 还会再次显示。两次可见状态都在 OnPreTick 中隐藏后即可解绑。
	if (WindowToHide->IsVisible())
	{
		WindowToHide->HideWindow();
		++HiddenWindowCount;
		UE_LOG(LogPet, Log, TEXT("已隐藏默认游戏窗口，第 %d 次"), HiddenWindowCount);
	}

	if (HiddenWindowCount >= 2)
	{
		RemoveSlatePreTickGuard();
	}
}

void FPetModule::RemoveSlatePreTickGuard()
{
	if (SlatePreTickHandle.IsValid() && FSlateApplication::IsInitialized())
	{
		FSlateApplication::Get().OnPreTick().Remove(SlatePreTickHandle);
	}

	SlatePreTickHandle.Reset();
	GameWindow.Reset();
	StartupTopLevelWindows.Reset();
}

IMPLEMENT_PRIMARY_GAME_MODULE( FPetModule, Pet, "Pet" );
