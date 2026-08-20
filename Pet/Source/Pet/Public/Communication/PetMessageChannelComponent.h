#pragma once

#include "CoreMinimal.h"
#include "Communication/PetControlClient.h"
#include "Communication/PetSessionTypes.h"
#include "Components/ActorComponent.h"
#include "PetMessageChannelComponent.generated.h"

DECLARE_MULTICAST_DELEGATE_TwoParams(FPetStateMessageNative, const FString&, const FString&);
DECLARE_MULTICAST_DELEGATE_OneParam(FPetSessionsSnapshotNative, const TArray<FPetSessionInfo>&);
DECLARE_MULTICAST_DELEGATE_OneParam(FPetConfigSnapshotNative, const FPetSettingsSnapshot&);
DECLARE_MULTICAST_DELEGATE_ThreeParams(FPetSessionStartNative, const FString&, const FString&, bool);
DECLARE_MULTICAST_DELEGATE_TwoParams(FPetSessionEndNative, const FString&, const FString&);
DECLARE_MULTICAST_DELEGATE_ThreeParams(FPetSessionStateNative, const FString&, bool, bool);
DECLARE_MULTICAST_DELEGATE_OneParam(FPetShutdownNative, const FString&);

/**
 * 守护进程消息通道。
 *
 * 组件只负责客户端、协议、连接和命令，不直接操作摄像机、网格体、动画或界面。
 * 所有事件仍由 FPetControlClient 在游戏线程分发。
 */
UCLASS(ClassGroup = (Pet), meta = (BlueprintSpawnableComponent))
class PET_API UPetMessageChannelComponent : public UActorComponent
{
	GENERATED_BODY()

public:
	UPetMessageChannelComponent();
	virtual ~UPetMessageChannelComponent() override;

	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void TickComponent(
		float DeltaTime,
		ELevelTick TickType,
		FActorComponentTickFunction* ThisTickFunction) override;

	/** 在 Pawn 完成事件绑定后启动通信。重复调用安全无效。 */
	void Start();

	/** 清空回调并等待客户端线程退出。重复调用安全无效。 */
	void Stop();

	void SendOpenTui(const FString& SessionId = FString());
	void SendPetMoved(int32 X, int32 Y);
	void SendUpdateConfig(const FPetConfigPatch& Patch);
	bool SendClosePet();

	bool IsConnected() const;
	FString GetCurrentProtocolState() const;

	FPetStateMessageNative OnPetState;
	FPetSessionsSnapshotNative OnSessionsSnapshot;
	FPetConfigSnapshotNative OnConfigSnapshot;
	FPetSessionStartNative OnSessionStart;
	FPetSessionEndNative OnSessionEnd;
	FPetSessionStateNative OnSessionState;
	FPetShutdownNative OnShutdown;

private:
	TUniquePtr<FPetControlClient> ControlClient;
};
