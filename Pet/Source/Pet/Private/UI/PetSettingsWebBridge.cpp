#include "UI/PetSettingsWebBridge.h"

void UPetSettingsWebBridge::SetOpenTarget(const FString& Target)
{
	if (Target != TEXT("cli") && Target != TEXT("web"))
	{
		return;
	}
	OnSetOpenTarget.Broadcast(Target);
}

void UPetSettingsWebBridge::SetTheme(const FString& ThemeId)
{
	if (ThemeId != TEXT("dark-glass") && ThemeId != TEXT("light-minimal") && ThemeId != TEXT("cute-pet"))
	{
		return;
	}
	OnSetTheme.Broadcast(ThemeId);
}

void UPetSettingsWebBridge::SetFpsMonitor(bool bEnabled)
{
	OnSetFpsMonitor.Broadcast(bEnabled);
}

void UPetSettingsWebBridge::CloseSettings()
{
	OnCloseSettings.Broadcast();
}

void UPetSettingsWebBridge::ReportFps(int32 Fps)
{
	if (Fps < 0)
	{
		return;
	}
	OnReportFps.Broadcast(Fps);
}
