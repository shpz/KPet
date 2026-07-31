using UnrealBuildTool;

public class KimiPetSpike : ModuleRules
{
	public KimiPetSpike(ReadOnlyTargetRules Target) : base(Target)
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
			"Projects"
		});
	}
}
