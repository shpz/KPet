using UnrealBuildTool;
using System.Collections.Generic;

public class KimiPetSpikeTarget : TargetRules
{
	public KimiPetSpikeTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("KimiPetSpike");
	}
}
