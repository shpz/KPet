// Copyright Epic Games, Inc. All Rights Reserved.

using UnrealBuildTool;
using System.Collections.Generic;

public class PetTarget : TargetRules
{
	public PetTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.V7;
		IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_8;
		// 让 Shipping 可执行文件使用 UE 的 PerMonitorV2 清单；运行时配置同时开启 Slate 高 DPI。
		WindowsPlatform.bForceHighDPIInGameMode = true;
		ExtraModuleNames.Add("Pet");
	}
}
