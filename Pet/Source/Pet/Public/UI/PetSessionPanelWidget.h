#pragma once

#include "CoreMinimal.h"
#include "Blueprint/UserWidget.h"

#include "UI/PetSessionItem.h"
#include "PetSessionPanelWidget.generated.h"

class UListView;
class UWidget;
class UWidgetAnimation;
/** C++ 使用的直接会话选择委托。 */
DECLARE_MULTICAST_DELEGATE_OneParam(FPetSessionSelectedNative, const FString& /* SessionId */);

/** 蓝图可选的会话选择委托；C++ 调用方应优先使用 OnSessionSelected。 */
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FPetSessionSelectedDynamic, FString, SessionId);

/**
 * UMG 会话列表面板。
 *
 * 该类只负责会话数据、UListView 和内容动画，不持有 SWindow、Pawn 或通信对象。
 * BindWidget 控件全部按 Optional 处理：未制作 Blueprint 资源时，数据仍保留在内存中，
 * 同时输出明确警告而不让宠物本体失效。
 */
UCLASS(Blueprintable)
class PET_API UPetSessionPanelWidget : public UUserWidget
{
	GENERATED_BODY()

public:
	/** 用快照合并当前列表，并复用相同 SessionId 对应的 UObject。 */
	void ApplySnapshot(const TArray<FPetSessionInfo>& Sessions);

	/** 增量新增或更新会话。 */
	void AddOrUpdateSession(const FPetSessionInfo& Session);

	/** 兼容增量 session_start 的轻量重载；已有对象的 working/unread 会被保留。 */
	void AddOrUpdateSession(
		const FString& SessionId,
		const FString& Title,
		const FString& Cwd,
		bool bActive);

	void RemoveSession(const FString& SessionId);
	void ClearSessions();
	void SetSessionActive(const FString& SessionId, bool bActive);
	void UpdateSessionState(const FString& SessionId, bool bWorking, bool bUnread);

	/** 请求播放面板内容动画；缺少动画绑定时保持静态显示并记录一次警告。 */
	UFUNCTION(BlueprintCallable, Category = "会话面板")
	void PlayPanelContentAnimation();

	/** 重播当前可见列表行的入场与状态动画。 */
	void ReplayVisibleRowAnimations();

	/** 独立 Slate 窗口可见期间，由 Pawn Tick 推进面板与可见行的 UMG 动画。 */
	void TickDetachedWindowAnimations(float DeltaTime);

	/** 查询接口主要供 C++ 接线和自动化测试使用。 */
	UPetSessionItem* FindSessionItem(const FString& SessionId) const;
	int32 GetSessionCount() const { return SessionItemOrder.Num(); }
	const TArray<TObjectPtr<UPetSessionItem>>& GetSessionItems() const { return SessionItemOrder; }

	/** Panel 直接把当前会话标识交给 Pawn，不经过 Window Host。 */
	FPetSessionSelectedNative OnSessionSelected;

	/** 蓝图可选的同名语义事件。 */
	UPROPERTY(BlueprintAssignable, Category = "会话面板")
	FPetSessionSelectedDynamic OnSessionSelectedBlueprint;

protected:
	virtual void NativeConstruct() override;
	virtual void NativeDestruct() override;

	/** 这些控件可由 WBP_PetSessionPanel 提供；缺失时只降级为无可视列表。 */
	UPROPERTY(BlueprintReadOnly, Category = "会话面板", meta = (BindWidgetOptional))
	TObjectPtr<UListView> ListView_Sessions;

	UPROPERTY(BlueprintReadOnly, Category = "会话面板", meta = (BindWidgetOptional))
	TObjectPtr<UWidget> EmptyState;

	UPROPERTY(Transient, BlueprintReadOnly, Category = "会话面板", meta = (BindWidgetAnimOptional))
	TObjectPtr<UWidgetAnimation> Anim_PanelEnter;

private:
	UPetSessionItem* FindOrCreateSession(
		const FString& SessionId,
		const FString& Title,
		const FString& Cwd,
		bool bActive,
		bool bWorking,
		bool bUnread,
		bool& bCreated);

	void BindItem(UPetSessionItem* Item);
	void UnbindItem(UPetSessionItem* Item);
	void HandleItemSelected(UPetSessionItem* Item);
	void HandleListItemClicked(UObject* ItemObject);
	void RefreshList();
	void UpdateEmptyState();

	UPROPERTY(Transient)
	TMap<FString, TObjectPtr<UPetSessionItem>> SessionItemsById;

	UPROPERTY(Transient)
	TArray<TObjectPtr<UPetSessionItem>> SessionItemOrder;

	FDelegateHandle ListItemClickedHandle;
	bool bListBindingWarningLogged = false;
	bool bEmptyStateWarningLogged = false;
	bool bContentAnimationWarningLogged = false;
};
