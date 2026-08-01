// Copyright Epic Games, Inc. All Rights Reserved.

using UnrealBuildTool;

public class Pet : ModuleRules
{
	public Pet(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"InputCore",
			"RHI",
			"RenderCore",
			"Slate",
			"SlateCore",
			"ApplicationCore",
			"Projects",
			"Json",          // 协议消息解析/构造（§4.1：发布版可用）
			"JsonUtilities"
		});
	}
}
