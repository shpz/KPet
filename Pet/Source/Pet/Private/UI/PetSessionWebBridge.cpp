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