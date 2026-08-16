#pragma once

#include "CoreMinimal.h"
#include "Blueprint/IUserObjectListEntry.h"
#include "Blueprint/UserWidget.h"

#include "PetSessionRowWidget.generated.h"

class UButton;
class UTextBlock;
class UWidget;
class UWidgetAnimation;
class UPetSessionItem;

/** C++ 使用的会话行点击委托。 */
DECLARE_MULTICAST_DELEGATE_OneParam(FPetSessionRowClickedNative, const FString& /* SessionId */);

/** 蓝图可选的会话行点击事件。 */
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FPetSessionRowClickedDynamic, FString, SessionId);

/**
 * UListView 的单行会话控件。
 *
 * 行对象会被列表虚拟化复用，因此每次绑定新 Item 前都必须解除旧 Item 的变更委托、
 * 停止旧动画并清空旧文本，避免工作状态或未读气泡串到其他会话。
 */
UCLASS(Blueprintable)
class PET_API UPetSessionRowWidget : public UUserWidget, public IUserObjectListEntry
{
	GENERATED_BODY()

public:
	/** 仅广播当前绑定 Item 的完整 SessionId。 */
	FPetSessionRowClickedNative OnSessionClicked;

	/** 蓝图可选的行点击事件。 */
	UPROPERTY(BlueprintAssignable, Category = "会话行")
	FPetSessionRowClickedDynamic OnSessionClickedBlueprint;

	UPetSessionItem* GetBoundSessionItem() const { return BoundItem.Get(); }
	/** 行内存在 Button 时由行自身处理点击，ListView 不应再重复广播同一次选择。 */
	bool HasDedicatedClickHandler() const { return Button_Row != nullptr; }

	/** 供测试或外部原生按钮转发调用；正常情况下由 Button_Row 触发。 */
	UFUNCTION(BlueprintCallable, Category = "会话行")
	void HandleSessionClicked();

	/** 根据状态启停工作中的三点动画；缺少绑定时安全降级为静态指示器。 */
	UFUNCTION(BlueprintCallable, Category = "会话行")
	void SetWorkingAnimationEnabled(bool bEnabled);

	/** 根据状态启停新回复气泡动画；缺少绑定时安全降级为静态指示器。 */
	UFUNCTION(BlueprintCallable, Category = "会话行")
	void SetUnreadAnimationEnabled(bool bEnabled);

	/** 窗口从隐藏态显示后重启动画，避免离屏期间被 UMG 动画管理器停用。 */
	void ReplayPresentationAnimations();

	/** 外部 Slate 窗口可见时，由 Pawn Tick 推进本行动画。 */
	void TickDetachedWindowAnimations(float DeltaTime);

protected:
	virtual void NativeConstruct() override;
	virtual void NativeDestruct() override;

	virtual void NativeOnListItemObjectSet(UObject* ListItemObject) override;
	virtual void NativeOnEntryReleased() override;

	UPROPERTY(BlueprintReadOnly, Category = "会话行", meta = (BindWidgetOptional))
	TObjectPtr<UButton> Button_Row;

	UPROPERTY(BlueprintReadOnly, Category = "会话行", meta = (BindWidgetOptional))
	TObjectPtr<UTextBlock> Text_Title;

	UPROPERTY(BlueprintReadOnly, Category = "会话行", meta = (BindWidgetOptional))
	TObjectPtr<UTextBlock> Text_SessionId;

	UPROPERTY(BlueprintReadOnly, Category = "会话行", meta = (BindWidgetOptional))
	TObjectPtr<UWidget> ActiveBar;

	UPROPERTY(BlueprintReadOnly, Category = "会话行", meta = (BindWidgetOptional))
	TObjectPtr<UWidget> WorkingDots;

	UPROPERTY(BlueprintReadOnly, Category = "会话行", meta = (BindWidgetOptional))
	TObjectPtr<UWidget> UnreadBubble;

	UPROPERTY(Transient, BlueprintReadOnly, Category = "会话行", meta = (BindWidgetAnimOptional))
	TObjectPtr<UWidgetAnimation> Anim_WorkingDots;

	UPROPERTY(Transient, BlueprintReadOnly, Category = "会话行", meta = (BindWidgetAnimOptional))
	TObjectPtr<UWidgetAnimation> Anim_UnreadBubble;

	UPROPERTY(Transient, BlueprintReadOnly, Category = "会话行", meta = (BindWidgetAnimOptional))
	TObjectPtr<UWidgetAnimation> Anim_RowEnter;

private:
	void ReleaseBoundItem();
	void HandleItemChanged(UPetSessionItem* Item);
	void RefreshFromItem();
	void ResetVisualState();
	void PlayRowEnterAnimation();
	void EnableDetachedAnimationClocks();
	void TickDetachedRowEnter();
	void StartDeferredStateAnimations();
	void TickDetachedStateIndicators();
	void UpdateAnimationState(
		UWidgetAnimation* Animation,
		UWidget* Indicator,
		bool bEnabled,
		bool& bAnimationPlaying,
		bool& bAnimationWarningLogged,
		const TCHAR* AnimationName);

	UPROPERTY(Transient)
	TObjectPtr<UPetSessionItem> BoundItem;

	bool bWorkingAnimationPlaying = false;
	bool bUnreadAnimationPlaying = false;
	bool bStateAnimationsDeferred = false;
	bool bUseDetachedRowEnterClock = false;
	bool bRowEnterClockActive = false;
	bool bUseDetachedStateIndicatorClock = false;
	double RowEnterStartTimeSeconds = 0.0;
	double RowEnterDurationSeconds = 0.0;
	bool bWorkingAnimationWarningLogged = false;
	bool bUnreadAnimationWarningLogged = false;
	bool bRowEnterAnimationWarningLogged = false;
	bool bButtonWarningLogged = false;
	bool bItemWarningLogged = false;
};
