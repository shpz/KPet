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
			"UMG"
		});

		PrivateDependencyModuleNames.AddRange(new string[]
		{
			"InputCore",
			"RHI",
			"RenderCore",
			"Slate",
			"SlateCore",
			"ApplicationCore",
			"Projects",
			"Json",
			"JsonUtilities"
		});
	}
}
