using UnrealBuildTool;
using System.Collections.Generic;

public class KimiPetSpikeEditorTarget : TargetRules
{
	public KimiPetSpikeEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("KimiPetSpike");
	}
}
