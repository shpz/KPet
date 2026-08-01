// Copyright Epic Games, Inc. All Rights Reserved.

#include "Pet.h"
#include "Modules/ModuleManager.h"

#include "Containers/Ticker.h"
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Widgets/SWindow.h"
#include "GenericPlatform/GenericWindow.h"

#include "Windows/AllowWindowsPlatformTypes.h"
#include <Windows.h>
#include "Windows/HideWindowsPlatformTypes.h"

DEFINE_LOG_CATEGORY(LogPet);

void FPetModule::StartupModule()
{
	// 编辑器/PIE 下不干预窗口（本模块在编辑器里也会加载）
	if (GIsEditor)
	{
		return;
	}

	// 启动黑屏的主修复在启动参数 -RenderOffScreen（bridge 拉起渲染进程时传入）：
	// UGameEngine::CreateGameWindow 检查 IsRenderingOffScreen()，直接不 ShowWindow，
	// 游戏主窗口从创建起就不可见（GameEngine.cpp:713），黑屏根除。
	// 本 ticker 是"未带该参数启动"时的兜底：窗口一旦被显示，在 core ticker 首次触发时
	// SW_HIDE。注意不存在"更早隐藏"的捷径：游戏窗口在引擎 Init 期间就被 ShowWindow，
	// 而跨线程 ShowWindow 会阻塞到属主（游戏）线程泵消息才真正生效（实测），
	// 实际时机并不比游戏线程上的 ticker 早。
	HideWindowTickerHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([](float DeltaTime) -> bool
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

		// 只在窗口已显示后才隐藏：窗口创建时本就不可见，若提前 SW_HIDE 仍会再被显示。
		// 隐藏成功后注销 ticker。
		if (GameHwnd && ::IsWindowVisible(GameHwnd))
		{
			::ShowWindow(GameHwnd, SW_HIDE);
			UE_LOG(LogPet, Log, TEXT("Game window hidden on first visible frame (HWND=%p)"), GameHwnd);
			return false;
		}
		return true; // 继续等下一帧
	}));
}

void FPetModule::ShutdownModule()
{
	FTSTicker::GetCoreTicker().RemoveTicker(HideWindowTickerHandle);
}

IMPLEMENT_PRIMARY_GAME_MODULE( FPetModule, Pet, "Pet" );
