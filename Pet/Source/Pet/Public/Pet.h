// Copyright Epic Games, Inc. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"

DECLARE_LOG_CATEGORY_EXTERN(LogPet, Log, All);

class SWindow;

// 自定义游戏模块：在 Slate 首次绘制前隐藏默认游戏窗口。
class FPetModule : public FDefaultGameModuleImpl
{
public:
	virtual void StartupModule() override;
	virtual void ShutdownModule() override;

private:
	void HandleSlatePreTick(float DeltaTime);
	void RemoveSlatePreTickGuard();
	bool IsStartupWindow(const SWindow* CandidateWindow) const;

	// 只保存弱引用，不延长 Slate 窗口的生命周期。
	TArray<TWeakPtr<SWindow>> StartupTopLevelWindows;
	TWeakPtr<SWindow> GameWindow;
	FDelegateHandle SlatePreTickHandle;
	int32 HiddenWindowCount = 0;
};
