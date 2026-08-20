#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "Player/PetWorkState.h"
#include "Templates/UniquePtr.h"
#include "UObject/SoftObjectPtr.h"
#include "UI/PetPanelStack.h"
#include "UI/PetSessionWebPanel.h"
#include "UI/PetSettingsWebPanel.h"
#include "Communication/PetSessionTypes.h"
#include "PetCapturePawn.generated.h"

class FRHIGPUTextureReadback;
class FPetSessionWindowHost;
class PetLayeredWindow;
class UPetCameraManagerComponent;
class UPetCharacterMotionComponent;
class UPetMessageChannelComponent;
class UPetSceneSlotComponent;
class UAnimInstance;
class USceneCaptureComponent2D;
class USkeletalMeshComponent;
class USkeletalMesh;
class UTextureRenderTarget2D;
struct FPetSessionInfo;

/**
 * 桌宠渲染 Pawn。
 *
 * 负责场景捕获、桌面窗口、会话面板、权威业务状态和原生组件调度。
 * 通信、状态镜头、小电脑运动与动画参数计算由各自组件或 AnimInstance 负责。
 */
UCLASS()
class PET_API APetCapturePawn : public APawn
{
	GENERATED_BODY()

public:
	APetCapturePawn();
	virtual ~APetCapturePawn() override;

	virtual void OnConstruction(const FTransform& Transform) override;
	virtual void PostInitializeComponents() override;
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void Tick(float DeltaTime) override;

	EPetWorkState GetCurrentPetState() const { return CurrentPetState; }
	FIntPoint GetWindowScreenPosition() const { return WindowScreenPosition; }
	USceneCaptureComponent2D* GetCaptureComponent() const { return CaptureComponent; }
	USkeletalMeshComponent* GetPetMesh() const { return PetMeshComponent; }
	USkeletalMeshComponent* GetComputerMesh() const { return ComputerMeshComponent; }
	UPetCharacterMotionComponent* GetPetMotionComponent() const { return MotionComponent; }
	UPetSceneSlotComponent* GetSceneSlotComponent() const { return SceneSlotComponent; }

	/** 由主角色 Working 动画中的原生 AnimNotify 调用。 */
	void HandleComputerHitNotify();

protected:
	/** 工作状态真实改变且原生组件已经收到新状态后触发。 */
	UFUNCTION(BlueprintImplementableEvent, Category = "宠物状态")
	void OnPetStateChanged(EPetWorkState NewState);

private:
	bool ResolveRuntimeComponents();
	void ApplyConfiguredCharacterAssets();
	void OnFrameReady(TSharedRef<TArray<uint8>> Pixels);
	void AdjustCameraRotation(float DeltaX, float DeltaY);
	void AdjustCameraZoom(float WheelDelta);
	void ApplyCameraCursorImage();
	void InitializePanels();
	void ShutdownPanels();
	void UpdateSessionPanelAnchor();
	void UpdateSettingsPanelAnchor();
	void ApplyPanelStackStep(const FPetPanelStackStep& Step);
	FSlateRect ComputePetBoundsInSlateScreen() const;
	void HandleSessionSelected(const FString& SessionId);
	void HandleConfigSnapshot(const FPetSettingsSnapshot& Snapshot);
	void HandleSetOpenTarget(const FString& Target);
	void HandleSetTheme(const FString& ThemeId);
	void HandleSetFpsMonitor(bool bEnabled);
	void HandleCloseSettings();
	void HandleCloseSession();
	void HandleReportFps(int32 Fps);
	void ToggleSessionPanel();
	void ToggleSettingsPanel();
	void HandlePetState(const FString& State, const FString& Reason);
	void HandleSessionsSnapshot(const TArray<FPetSessionInfo>& Sessions);
	void HandleSessionStart(const FString& SessionId, const FString& Cwd, bool bResume);
	void HandleSessionEnd(const FString& SessionId, const FString& Reason);
	void HandleSessionState(const FString& SessionId, bool bWorking, bool bUnread);
	void HandleShutdown(const FString& Reason);
	void HandleCloseRequested();

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "组件", meta = (AllowPrivateAccess = "true"))
	TObjectPtr<USceneComponent> RootComp = nullptr;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "组件", meta = (AllowPrivateAccess = "true"))
	TObjectPtr<USkeletalMeshComponent> PetMeshComponent = nullptr;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "组件", meta = (AllowPrivateAccess = "true"))
	TObjectPtr<USkeletalMeshComponent> ComputerMeshComponent = nullptr;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "组件", meta = (AllowPrivateAccess = "true"))
	TObjectPtr<USceneCaptureComponent2D> CaptureComponent = nullptr;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "组件", meta = (AllowPrivateAccess = "true"))
	TObjectPtr<UPetSceneSlotComponent> SceneSlotComponent = nullptr;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "组件", meta = (AllowPrivateAccess = "true"))
	TObjectPtr<UPetMessageChannelComponent> MessageChannelComponent = nullptr;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "组件", meta = (AllowPrivateAccess = "true"))
	TObjectPtr<UPetCameraManagerComponent> CameraManagerComponent = nullptr;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "组件", meta = (AllowPrivateAccess = "true"))
	TObjectPtr<UPetCharacterMotionComponent> MotionComponent = nullptr;

	/** 主角色骨骼网格体资源，由 BP_PetCapturePawn 配置。 */
	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "角色资源|主角色", meta = (AllowPrivateAccess = "true"))
	TObjectPtr<USkeletalMesh> PetMeshAsset = nullptr;

	/** 主角色动画蓝图类，由 BP_PetCapturePawn 配置。 */
	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "角色资源|主角色", meta = (AllowPrivateAccess = "true"))
	TSubclassOf<UAnimInstance> PetAnimInstanceClass;

	/** 小电脑骨骼网格体资源，由 BP_PetCapturePawn 配置。 */
	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "角色资源|小电脑", meta = (AllowPrivateAccess = "true"))
	TObjectPtr<USkeletalMesh> ComputerMeshAsset = nullptr;

	/** 小电脑动画蓝图类，由 BP_PetCapturePawn 配置。 */
	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "角色资源|小电脑", meta = (AllowPrivateAccess = "true"))
	TSubclassOf<UAnimInstance> ComputerAnimInstanceClass;

	UPROPERTY()
	TObjectPtr<UTextureRenderTarget2D> RenderTarget = nullptr;

	/** 分层窗口左上角在 Windows 虚拟桌面中的屏幕像素坐标。 */
	UPROPERTY(VisibleInstanceOnly, BlueprintReadOnly, Transient, Category = "窗口", meta = (AllowPrivateAccess = "true"))
	FIntPoint WindowScreenPosition = FIntPoint::ZeroValue;

	/** 守护进程下发的当前权威工作状态。 */
	UPROPERTY(VisibleInstanceOnly, BlueprintReadOnly, Transient, Category = "宠物状态", meta = (AllowPrivateAccess = "true"))
	EPetWorkState CurrentPetState = EPetWorkState::Idle;

	FRHIGPUTextureReadback* Readback = nullptr;
	std::atomic<bool> bCopyInFlight{ false };

	PetLayeredWindow* PetWindow = nullptr;
	FPetSessionWindowHost* SessionWindowHost = nullptr;
	FPetSessionWindowHost* SettingsWindowHost = nullptr;

	/** WebUI 会话面板。非空时数据走 Web 路径。 */
	TUniquePtr<FPetSessionWebPanel> SessionWebPanel;

	/** WebUI 设置面板。 */
	TUniquePtr<FPetSettingsWebPanel> SettingsWebPanel;

	/** 最近一次 config_snapshot 全量配置（守护进程权威，设置面板回推后对齐）。 */
	FPetSettingsSnapshot CurrentSettings;

	/** 两个 WebUI 面板的堆栈式导航状态；所有开关路径都经它推进。 */
	FPetPanelStackState PanelStack;

	/** Ctrl+, 热键触发的设置面板切换请求（消息线程置位，游戏线程 Tick 消费）。 */
	bool bSettingsPanelTogglePending = false;

	/** 3D 世界帧率统计（Tick 计数，每秒结算一次）。 */
	double WorldFpsStatsStartTime = 0.0;
	int32 WorldFpsFramesInWindow = 0;
	int32 WorldFps = 0;

	/** WebUI 帧率（两面板 ReportFps 取最近值；-1 表示尚无上报的未知态）。 */
	int32 WebFps = -1;

	int32 PresentedFrames = 0;
	bool bPresentedValidFrame = false;
	bool bSessionPanelTogglePending = false;
	bool bCloseRequestPending = false;
	bool bCloseRequested = false;
	double CloseFallbackDeadline = 0.0;

	static constexpr int32 RTSize = 320;
	static constexpr double CloseFallbackSeconds = 3.0;
};
