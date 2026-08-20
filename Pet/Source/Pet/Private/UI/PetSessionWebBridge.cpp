#include "UI/PetSessionWebBridge.h"

void UPetSessionWebBridge::SelectSession(const FString& SessionId)
{
	if (SessionId.IsEmpty())
	{
		return;
	}

	OnSelectSession.Broadcast(SessionId);
}

void UPetSessionWebBridge::ClosePanel()
{
	OnCloseRequested.Broadcast();
}

void UPetSessionWebBridge::ReportFps(int32 Fps)
{
	if (Fps < 0)
	{
		return;
	}
	OnReportFps.Broadcast(Fps);
}