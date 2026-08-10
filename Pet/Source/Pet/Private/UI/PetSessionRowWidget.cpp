#include "UI/PetSessionRowWidget.h"

#include "Pet.h"
#include "UI/PetSessionItem.h"

#include "Animation/WidgetAnimation.h"
#include "Components/Button.h"
#include "Components/TextBlock.h"
#include "Components/Widget.h"
#include "HAL/PlatformTime.h"

void UPetSessionRowWidget::NativeConstruct()
{
	Super::NativeConstruct();

	if (Button_Row)
	{
		Button_Row->OnClicked.AddUniqueDynamic(this, &UPetSessionRowWidget::HandleSessionClicked);
	}
	else if (!bButtonWarningLogged)
	{
		UE_LOG(LogPet, Warning, TEXT("会话行缺少 BindWidgetOptional 控件 Button_Row，点击只能依赖 UListView 行事件"));
		bButtonWarningLogged = true;
	}

	RefreshFromItem();
}

void UPetSessionRowWidget::NativeDestruct()
{
	ReleaseBoundItem();

	if (Button_Row)
	{
		Button_Row->OnClicked.RemoveDynamic(this, &UPetSessionRowWidget::HandleSessionClicked);
	}

	Super::NativeDestruct();
}

void UPetSessionRowWidget::NativeOnListItemObjectSet(UObject* ListItemObject)
{
	IUserObjectListEntry::NativeOnListItemObjectSet(ListItemObject);

	ReleaseBoundItem();
	BoundItem = Cast<UPetSessionItem>(ListItemObject);
	if (!BoundItem)
	{
		if (!bItemWarningLogged)
		{
			UE_LOG(LogPet, Warning, TEXT("会话行收到的 ListItem 不是 UPetSessionItem，行将显示为空"));
			bItemWarningLogged = true;
		}
		ResetVisualState();
		return;
	}

	BoundItem->OnChanged.AddUObject(this, &UPetSessionRowWidget::HandleItemChanged);
	bStateAnimationsDeferred = Anim_RowEnter != nullptr;
	RefreshFromItem();
	PlayRowEnterAnimation();
}

void UPetSessionRowWidget::NativeOnEntryReleased()
{
	ReleaseBoundItem();
	IUserListEntry::NativeOnEntryReleased();
}

void UPetSessionRowWidget::HandleSessionClicked()
{
	UPetSessionItem* Item = BoundItem.Get();
	if (!Item || Item->SessionId.IsEmpty())
	{
		UE_LOG(LogPet, Verbose, TEXT("会话行点击时没有有效的 UPetSessionItem"));
		return;
	}

	const FString SelectedSessionId = Item->SessionId;

	// 先清除本地未读状态，再广播选择，保证点击反馈不等待 Bridge 回包。
	Item->SetUnread(false);
	Item->NotifySelected();
	OnSessionClicked.Broadcast(SelectedSessionId);
	OnSessionClickedBlueprint.Broadcast(SelectedSessionId);
}

void UPetSessionRowWidget::ReleaseBoundItem()
{
	if (BoundItem)
	{
		BoundItem->OnChanged.RemoveAll(this);
	}

	BoundItem = nullptr;

	if (Anim_WorkingDots)
	{
		StopAnimation(Anim_WorkingDots);
	}
	if (Anim_UnreadBubble)
	{
		StopAnimation(Anim_UnreadBubble);
	}
	if (Anim_RowEnter)
	{
		StopAnimation(Anim_RowEnter);
	}
	FlushAnimations();
	bWorkingAnimationPlaying = false;
	bUnreadAnimationPlaying = false;
	bStateAnimationsDeferred = false;
	bRowEnterClockActive = false;
	RowEnterStartTimeSeconds = 0.0;
	RowEnterDurationSeconds = 0.0;

	ResetVisualState();
}

void UPetSessionRowWidget::HandleItemChanged(UPetSessionItem* Item)
{
	if (Item == BoundItem.Get())
	{
		RefreshFromItem();
	}
}

void UPetSessionRowWidget::RefreshFromItem()
{
	UPetSessionItem* Item = BoundItem.Get();
	if (!Item)
	{
		ResetVisualState();
		return;
	}

	if (Text_Title)
	{
		FString DisplayTitle = Item->Title;
		if (DisplayTitle.IsEmpty() && !Item->Cwd.IsEmpty())
		{
			DisplayTitle = FPaths::GetCleanFilename(Item->Cwd);
			if (DisplayTitle.IsEmpty())
			{
				DisplayTitle = Item->Cwd;
			}
		}
		if (DisplayTitle.IsEmpty())
		{
			DisplayTitle = Item->SessionId;
		}
		Text_Title->SetText(FText::FromString(DisplayTitle));
		Text_Title->SetColorAndOpacity(Item->bActive
			? FSlateColor(FLinearColor::White)
			: FSlateColor(FLinearColor(0.62f, 0.65f, 0.70f, 1.0f)));
	}

	if (Text_SessionId)
	{
		Text_SessionId->SetText(FText::FromString(Item->SessionId.Left(8)));
	}

	if (ActiveBar)
	{
		ActiveBar->SetVisibility(Item->bActive ? ESlateVisibility::Visible : ESlateVisibility::Collapsed);
	}
	else
	{
		// 缺少强调条时仍用行透明度区分历史会话，避免只依赖文字。
		SetRenderOpacity(Item->bActive ? 1.0f : 0.72f);
	}

	SetWorkingAnimationEnabled(Item->bWorking);
	SetUnreadAnimationEnabled(Item->bUnread);
}

void UPetSessionRowWidget::ResetVisualState()
{
	if (Text_Title)
	{
		Text_Title->SetText(FText::GetEmpty());
	}
	if (Text_SessionId)
	{
		Text_SessionId->SetText(FText::GetEmpty());
	}
	if (ActiveBar)
	{
		ActiveBar->SetVisibility(ESlateVisibility::Collapsed);
	}
	if (Button_Row)
	{
		Button_Row->SetRenderOpacity(1.0f);
	}
	if (WorkingDots)
	{
		WorkingDots->SetVisibility(ESlateVisibility::Collapsed);
		WorkingDots->SetRenderOpacity(1.0f);
	}
	if (UnreadBubble)
	{
		UnreadBubble->SetVisibility(ESlateVisibility::Collapsed);
		UnreadBubble->SetRenderOpacity(1.0f);
	}
	SetRenderOpacity(1.0f);
}

void UPetSessionRowWidget::PlayRowEnterAnimation()
{
	if (Anim_RowEnter)
	{
		bStateAnimationsDeferred = true;
		RowEnterDurationSeconds = FMath::Max(
			Anim_RowEnter->GetEndTime() - Anim_RowEnter->GetStartTime(),
			KINDA_SMALL_NUMBER);
		RowEnterStartTimeSeconds = FPlatformTime::Seconds();
		bRowEnterClockActive = true;
		if (bUseDetachedRowEnterClock)
		{
			SetRenderOpacity(0.0f);
			if (Button_Row)
			{
				Button_Row->SetRenderOpacity(1.0f);
			}
		}
		else
		{
			PlayAnimation(Anim_RowEnter, 0.0f, 1, EUMGSequencePlayMode::Forward, 1.0f);
		}
		return;
	}

	bStateAnimationsDeferred = false;
	bRowEnterClockActive = false;
	RowEnterStartTimeSeconds = 0.0;
	RowEnterDurationSeconds = 0.0;

	if (!bRowEnterAnimationWarningLogged)
	{
		UE_LOG(LogPet, Verbose, TEXT("会话行未绑定可选动画 Anim_RowEnter，使用静态进入效果"));
		bRowEnterAnimationWarningLogged = true;
	}
}

void UPetSessionRowWidget::SetWorkingAnimationEnabled(bool bEnabled)
{
	UpdateAnimationState(
		Anim_WorkingDots,
		WorkingDots,
		bEnabled,
		bWorkingAnimationPlaying,
		bWorkingAnimationWarningLogged,
		TEXT("Anim_WorkingDots"));
}

void UPetSessionRowWidget::SetUnreadAnimationEnabled(bool bEnabled)
{
	UpdateAnimationState(
		Anim_UnreadBubble,
		UnreadBubble,
		bEnabled,
		bUnreadAnimationPlaying,
		bUnreadAnimationWarningLogged,
		TEXT("Anim_UnreadBubble"));
}

void UPetSessionRowWidget::ReplayPresentationAnimations()
{
	if (Anim_WorkingDots)
	{
		StopAnimation(Anim_WorkingDots);
	}
	if (Anim_UnreadBubble)
	{
		StopAnimation(Anim_UnreadBubble);
	}
	if (Anim_RowEnter)
	{
		StopAnimation(Anim_RowEnter);
	}
	FlushAnimations();
	bWorkingAnimationPlaying = false;
	bUnreadAnimationPlaying = false;

	PlayRowEnterAnimation();
	if (const UPetSessionItem* Item = BoundItem.Get())
	{
		SetWorkingAnimationEnabled(Item->bWorking);
		SetUnreadAnimationEnabled(Item->bUnread);
	}
}

void UPetSessionRowWidget::TickDetachedWindowAnimations(const float DeltaTime)
{
	(void)DeltaTime;
	EnableDetachedAnimationClocks();
	TickDetachedRowEnter();
	TickDetachedStateIndicators();
	InvalidateLayoutAndVolatility();
}

void UPetSessionRowWidget::EnableDetachedAnimationClocks()
{
	bool bStoppedAnimation = false;
	bool bStoppedRowAnimation = false;
	if (!bUseDetachedRowEnterClock)
	{
		bUseDetachedRowEnterClock = true;
		if (Anim_RowEnter)
		{
			StopAnimation(Anim_RowEnter);
			bStoppedAnimation = true;
			bStoppedRowAnimation = true;
		}
	}

	if (!bUseDetachedStateIndicatorClock)
	{
		bUseDetachedStateIndicatorClock = true;
		if (Anim_WorkingDots)
		{
			StopAnimation(Anim_WorkingDots);
			bStoppedAnimation = true;
		}
		if (Anim_UnreadBubble)
		{
			StopAnimation(Anim_UnreadBubble);
			bStoppedAnimation = true;
		}
		bWorkingAnimationPlaying = false;
		bUnreadAnimationPlaying = false;
	}

	if (bStoppedAnimation)
	{
		FlushAnimations();
	}
	if (bStoppedRowAnimation && Button_Row)
	{
		// MovieScene 绑定 Button_Row.RenderOpacity；Flush 后显式恢复，再由根节点时钟淡入。
		Button_Row->SetRenderOpacity(1.0f);
	}
}

void UPetSessionRowWidget::TickDetachedRowEnter()
{
	if (!bStateAnimationsDeferred || !bRowEnterClockActive)
	{
		return;
	}

	const double ElapsedSeconds = FPlatformTime::Seconds() - RowEnterStartTimeSeconds;
	const float Progress = static_cast<float>(FMath::Clamp(
		ElapsedSeconds / FMath::Max(RowEnterDurationSeconds, static_cast<double>(KINDA_SMALL_NUMBER)),
		0.0,
		1.0));
	SetRenderOpacity(Progress);

	if (Progress >= 1.0f)
	{
		StartDeferredStateAnimations();
	}
}

void UPetSessionRowWidget::StartDeferredStateAnimations()
{
	bStateAnimationsDeferred = false;
	bRowEnterClockActive = false;
	RowEnterStartTimeSeconds = 0.0;
	RowEnterDurationSeconds = 0.0;
	SetRenderOpacity(1.0f);
	if (Button_Row)
	{
		Button_Row->SetRenderOpacity(1.0f);
	}

	if (const UPetSessionItem* Item = BoundItem.Get())
	{
		SetWorkingAnimationEnabled(Item->bWorking);
		SetUnreadAnimationEnabled(Item->bUnread);
	}
}

void UPetSessionRowWidget::TickDetachedStateIndicators()
{
	const UPetSessionItem* Item = BoundItem.Get();
	const bool bAnimateWorking = Item && Item->bWorking && WorkingDots && !bStateAnimationsDeferred;
	const bool bAnimateUnread = Item && Item->bUnread && UnreadBubble && !bStateAnimationsDeferred;

	if (WorkingDots)
	{
		if (bAnimateWorking)
		{
			constexpr double Duration = 0.8;
			const float Phase = static_cast<float>(FMath::Fmod(FPlatformTime::Seconds(), Duration) / Duration);
			const float Triangle = 1.0f - FMath::Abs(Phase * 2.0f - 1.0f);
			WorkingDots->SetRenderOpacity(FMath::Lerp(0.35f, 1.0f, Triangle));
		}
		else
		{
			WorkingDots->SetRenderOpacity(1.0f);
		}
	}

	if (UnreadBubble)
	{
		if (bAnimateUnread)
		{
			constexpr double Duration = 1.0;
			const float Phase = static_cast<float>(FMath::Fmod(FPlatformTime::Seconds(), Duration) / Duration);
			const float Triangle = 1.0f - FMath::Abs(Phase * 2.0f - 1.0f);
			UnreadBubble->SetRenderOpacity(FMath::Lerp(0.60f, 1.0f, Triangle));
		}
		else
		{
			UnreadBubble->SetRenderOpacity(1.0f);
		}
	}
}

void UPetSessionRowWidget::UpdateAnimationState(
	UWidgetAnimation* Animation,
	UWidget* Indicator,
	bool bEnabled,
	bool& bAnimationPlaying,
	bool& bAnimationWarningLogged,
	const TCHAR* AnimationName)
{
	if (Indicator)
	{
		Indicator->SetVisibility(bEnabled ? ESlateVisibility::Visible : ESlateVisibility::Collapsed);
	}

	if (bUseDetachedStateIndicatorClock)
	{
		bAnimationPlaying = false;
		return;
	}

	if (!Animation)
	{
		if (bEnabled && !bAnimationWarningLogged)
		{
			UE_LOG(LogPet, Verbose, TEXT("会话行未绑定可选动画 %s，使用静态指示器"), AnimationName);
			bAnimationWarningLogged = true;
		}
		bAnimationPlaying = false;
		return;
	}

	if (bEnabled)
	{
		if (bStateAnimationsDeferred)
		{
			bAnimationPlaying = false;
			return;
		}

		if (!bAnimationPlaying)
		{
			PlayAnimation(Animation, 0.0f, 0, EUMGSequencePlayMode::Forward, 1.0f);
			bAnimationPlaying = true;
		}
	}
	else
	{
		StopAnimation(Animation);
		bAnimationPlaying = false;
	}
}
