// Copyright Epic Games, Inc. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "Modules/ModuleManager.h"

DECLARE_LOG_CATEGORY_EXTERN(LogPet, Log, All);

// 自定义游戏模块：注册 core ticker 作启动黑屏的兜底隐藏（主修复是启动参数 -RenderOffScreen，
// 游戏主窗口创建时就不显示；本 ticker 应对未带该参数启动的情况）
class FPetModule : public FDefaultGameModuleImpl
{
public:
	virtual void StartupModule() override;
	virtual void ShutdownModule() override;

private:
	// UE 5.8 起 ticker 句柄是 FTSTicker 自有类型（TWeakPtr<FElement>），不是全局 FDelegateHandle
	FTSTicker::FDelegateHandle HideWindowTickerHandle;
};
