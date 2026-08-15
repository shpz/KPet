#include "Communication/PetMessageChannelComponent.h"

#include "Communication/PetControlClient.h"

UPetMessageChannelComponent::UPetMessageChannelComponent()
{
	PrimaryComponentTick.bCanEverTick = true;
	PrimaryComponentTick.bStartWithTickEnabled = false;
	PrimaryComponentTick.TickGroup = TG_PrePhysics;
}

UPetMessageChannelComponent::~UPetMessageChannelComponent()
{
	Stop();
}

void UPetMessageChannelComponent::Start()
{
	if (ControlClient)
	{
		return;
	}

	ControlClient = MakeUnique<FPetControlClient>();
	ControlClient->OnPetState = [this](const FString& State, const FString& Reason)
	{
		OnPetState.Broadcast(State, Reason);
	};
	ControlClient->OnSessionsSnapshot = [this](const TArray<FPetSessionInfo>& Sessions)
	{
		OnSessionsSnapshot.Broadcast(Sessions);
	};
	ControlClient->OnSessionStart = [this](const FString& SessionId, const FString& Cwd, bool bResume)
	{
		OnSessionStart.Broadcast(SessionId, Cwd, bResume);
	};
	ControlClient->OnSessionEnd = [this](const FString& SessionId, const FString& Reason)
	{
		OnSessionEnd.Broadcast(SessionId, Reason);
	};
	ControlClient->OnSessionState = [this](const FString& SessionId, bool bWorking, bool bUnread)
	{
		OnSessionState.Broadcast(SessionId, bWorking, bUnread);
	};
	ControlClient->OnShutdown = [this](const FString& Reason)
	{
		OnShutdown.Broadcast(Reason);
	};

	ControlClient->Start();
	SetComponentTickEnabled(true);
}

void UPetMessageChannelComponent::Stop()
{
	SetComponentTickEnabled(false);
	if (!ControlClient)
	{
		return;
	}

	ControlClient->OnPetState = nullptr;
	ControlClient->OnSessionsSnapshot = nullptr;
	ControlClient->OnSessionStart = nullptr;
	ControlClient->OnSessionEnd = nullptr;
	ControlClient->OnSessionState = nullptr;
	ControlClient->OnShutdown = nullptr;
	ControlClient->Shutdown();
	ControlClient.Reset();
}

void UPetMessageChannelComponent::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	Stop();
	Super::EndPlay(EndPlayReason);
}

void UPetMessageChannelComponent::TickComponent(
	float DeltaTime,
	ELevelTick TickType,
	FActorComponentTickFunction* ThisTickFunction)
{
	Super::TickComponent(DeltaTime, TickType, ThisTickFunction);
	if (ControlClient)
	{
		ControlClient->Tick();
	}
}

void UPetMessageChannelComponent::SendOpenTui(const FString& SessionId)
{
	if (ControlClient)
	{
		ControlClient->SendOpenTui(SessionId);
	}
}

void UPetMessageChannelComponent::SendPetMoved(int32 X, int32 Y)
{
	if (ControlClient)
	{
		ControlClient->SendPetMoved(X, Y);
	}
}

bool UPetMessageChannelComponent::SendClosePet()
{
	return ControlClient && ControlClient->SendClosePet();
}

bool UPetMessageChannelComponent::IsConnected() const
{
	return ControlClient && ControlClient->IsConnected();
}

FString UPetMessageChannelComponent::GetCurrentProtocolState() const
{
	return ControlClient ? ControlClient->GetCurrentState() : FString(TEXT("Idle"));
}
