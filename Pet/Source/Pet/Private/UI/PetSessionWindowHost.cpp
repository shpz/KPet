#include "UI/PetSessionWindowHost.h"

#include "Pet.h"
#include "UI/PetSessionPanelWidget.h"

#include "Framework/Application/SlateApplication.h"
#include "Widgets/SNullWidget.h"
#include "Widgets/SWidget.h"
#include "Widgets/SWindow.h"

namespace
{
	constexpr float PositionEpsilon = 1.0f;

	float ClampProgress(float Progress)
	{
		return FMath::Clamp(Progress, 0.0f, 1.0f);
	}

	FVector2f ClampWindowPosition(const FVector2f& Position, const FSlateRect& WorkArea, const FVector2f& WindowSize)
	{
		const float MinX = WorkArea.Left;
		const float MinY = WorkArea.Top;
		const float MaxX = FMath::Max(MinX, WorkArea.Right - WindowSize.X);
		const float MaxY = FMath::Max(MinY, WorkArea.Bottom - WindowSize.Y);

		return FVector2f(
			FMath::Clamp(Position.X, MinX, MaxX),
			FMath::Clamp(Position.Y, MinY, MaxY));
	}
}

FPetSessionWindowLayout PetSessionWindowHostLayout::Calculate(
	const FSlateRect& PetBounds,
	const FSlateRect& WorkArea,
	const FVector2f& WindowSize,
	const float Gap)
{
	FPetSessionWindowLayout Result;
	Result.WorkArea = WorkArea;

	const float RightSpace = WorkArea.Right - (PetBounds.Right + Gap);
	const float LeftSpace = PetBounds.Left - WorkArea.Left;
	Result.bPlaceOnLeft = RightSpace < WindowSize.X && LeftSpace > RightSpace;

	const float UnclampedX = Result.bPlaceOnLeft
		? PetBounds.Left - WindowSize.X - Gap
		: PetBounds.Right + Gap;
	const float UnclampedY = (PetBounds.Top + PetBounds.Bottom - WindowSize.Y) * 0.5f;

	Result.Position = ClampWindowPosition(
		FVector2f(UnclampedX, UnclampedY),
		WorkArea,
		WindowSize);
	return Result;
}

EPetSessionWindowAnimationState PetSessionWindowHostAnimation::Toggle(
	const EPetSessionWindowAnimationState State)
{
	switch (State)
	{
	case EPetSessionWindowAnimationState::Hidden:
	case EPetSessionWindowAnimationState::Closing:
		return EPetSessionWindowAnimationState::Opening;
	case EPetSessionWindowAnimationState::Opening:
	case EPetSessionWindowAnimationState::Visible:
		return EPetSessionWindowAnimationState::Closing;
	default:
		return EPetSessionWindowAnimationState::Hidden;
	}
}

EPetSessionWindowAnimationState PetSessionWindowHostAnimation::Close(
	const EPetSessionWindowAnimationState State)
{
	return State == EPetSessionWindowAnimationState::Hidden
		? EPetSessionWindowAnimationState::Hidden
		: EPetSessionWindowAnimationState::Closing;
}

float PetSessionWindowHostAnimation::AdvanceProgress(
	const EPetSessionWindowAnimationState State,
	const float Progress,
	const float DeltaTime,
	const float AnimationDuration)
{
	const float SafeDuration = FMath::Max(AnimationDuration, UE_SMALL_NUMBER);
	const float SafeDeltaTime = FMath::Max(DeltaTime, 0.0f);

	switch (State)
	{
	case EPetSessionWindowAnimationState::Opening:
		return ClampProgress(Progress + SafeDeltaTime / SafeDuration);
	case EPetSessionWindowAnimationState::Closing:
		return ClampProgress(Progress - SafeDeltaTime / SafeDuration);
	case EPetSessionWindowAnimationState::Visible:
		return 1.0f;
	case EPetSessionWindowAnimationState::Hidden:
	default:
		return 0.0f;
	}
}

FPetSessionWindowHost::~FPetSessionWindowHost()
{
	Destroy();
}

bool FPetSessionWindowHost::IsGameThreadCall() const
{
	if (IsInGameThread())
	{
		return true;
	}

	UE_LOG(LogPet, Warning, TEXT("FPetSessionWindowHost 只能在游戏线程调用"));
	return false;
}

bool FPetSessionWindowHost::Create(UPetSessionPanelWidget* PanelWidget)
{
	if (!PanelWidget)
	{
		return false;
	}

	return Create(PanelWidget->TakeWidget());
}

bool FPetSessionWindowHost::Create(TSharedRef<SWidget> Content)
{
	if (!IsGameThreadCall())
	{
		return false;
	}

	if (SessionWindow.IsValid())
	{
		return true;
	}

	if (!FSlateApplication::IsInitialized())
	{
		UE_LOG(LogPet, Warning, TEXT("Slate 尚未初始化，无法创建会话窗口"));
		return false;
	}

	if (FSlateApplication::Get().IsRenderingOffScreen())
	{
		UE_LOG(LogPet, Error, TEXT("Slate 正在离屏渲染，无法创建可见会话窗口；请移除 RenderOffScreen 启动参数"));
		return false;
	}

	SAssignNew(SessionWindow, SWindow)
		.Type(EWindowType::Notification)
		.Title(FText::FromString(TEXT("KimiPet 会话")))
		.IsPopupWindow(true)
		.AutoCenter(EAutoCenter::None)
		.IsTopmostWindow(true)
		.UseOSWindowBorder(false)
		.CreateTitleBar(false)
		.HasCloseButton(false)
		.SupportsMinimize(false)
		.SupportsMaximize(false)
		.SupportsTransparency(EWindowTransparency::PerWindow)
		.InitialOpacity(0.0f)
		.SizingRule(ESizingRule::FixedSize)
		.FocusWhenFirstShown(false)
		.ActivationPolicy(EWindowActivationPolicy::Never)
		.AdjustInitialSizeAndPositionForDPIScale(true)
		.ClientSize(FVector2f(PanelDesignWidth, PanelDesignHeight));

	// TakeWidget 只在创建时接入 Slate。Host 不保存会话数据，也不包装 Widget 的选择委托。
	SessionContent = Content;
	SessionWindow->SetContent(SessionContent.ToSharedRef());
	FSlateApplication::Get().AddWindow(SessionWindow.ToSharedRef(), false);
	SessionWindow->SetOpacity(0.0f);
	SessionWindow->HideWindow();
	WindowSizeInSlateScreen = ReadWindowSizeInSlateScreen();

	AnimationState = EPetSessionWindowAnimationState::Hidden;
	AnimationProgress = 0.0f;
	bHasMovedPosition = false;
	return true;
}

void FPetSessionWindowHost::Destroy()
{
	if (!IsGameThreadCall())
	{
		return;
	}

	AnimationState = EPetSessionWindowAnimationState::Hidden;
	AnimationProgress = 0.0f;
	bHasAnchor = false;
	bHasMovedPosition = false;
	StopContentActiveTimer();

	if (!SessionWindow.IsValid())
	{
		SessionContent.Reset();
		return;
	}

	// 先停止显示，再断开 SObjectWidget，最后请求 Slate 销毁窗口，避免 UMG 被延迟 GC。
	SessionWindow->SetOpacity(0.0f);
	SessionWindow->HideWindow();
	SessionWindow->SetContent(SNullWidget::NullWidget);
	if (FSlateApplication::IsInitialized())
	{
		FSlateApplication::Get().RequestDestroyWindow(SessionWindow.ToSharedRef());
	}
	SessionWindow.Reset();
	SessionContent.Reset();
}

void FPetSessionWindowHost::BeginOpening()
{
	AnimationState = EPetSessionWindowAnimationState::Opening;
	StartContentActiveTimer();
	// 先设置透明度与锚点位置，再让 Slate 显示窗口，避免透明窗口先出现在默认的 0,0。
	ApplyWindowTransform(true);
	if (SessionWindow.IsValid() && !SessionWindow->IsVisible())
	{
		SessionWindow->ShowWindow();
	}
	SessionWindow->BringToFront(false);
}

void FPetSessionWindowHost::StartContentActiveTimer()
{
	if (!ContentActiveTimerHandle.IsValid() && SessionContent.IsValid())
	{
		// 独立且不激活显示的窗口不能依赖用户输入唤醒 Slate。活动计时器只请求
		// Slate 持续 Tick 与 Paint，不会激活原生窗口或改变键盘焦点。
		ContentActiveTimerHandle = SessionContent->RegisterActiveTimer(
			0.0f,
			FWidgetActiveTimerDelegate::CreateRaw(
				this,
				&FPetSessionWindowHost::HandleContentActiveTimer));
	}
}

void FPetSessionWindowHost::StopContentActiveTimer()
{
	if (ContentActiveTimerHandle.IsValid() && SessionContent.IsValid())
	{
		SessionContent->UnRegisterActiveTimer(ContentActiveTimerHandle.ToSharedRef());
	}
	ContentActiveTimerHandle.Reset();
}

EActiveTimerReturnType FPetSessionWindowHost::HandleContentActiveTimer(double, float)
{
	return EActiveTimerReturnType::Continue;
}

void FPetSessionWindowHost::BeginClosing()
{
	AnimationState = EPetSessionWindowAnimationState::Closing;
	ApplyWindowTransform(false);
}

void FPetSessionWindowHost::Toggle()
{
	if (!IsGameThreadCall() || !SessionWindow.IsValid())
	{
		return;
	}

	const EPetSessionWindowAnimationState NextState = PetSessionWindowHostAnimation::Toggle(AnimationState);
	if (NextState == EPetSessionWindowAnimationState::Opening)
	{
		BeginOpening();
	}
	else
	{
		BeginClosing();
	}
}

void FPetSessionWindowHost::Close()
{
	if (!IsGameThreadCall() || !SessionWindow.IsValid())
	{
		return;
	}

	const EPetSessionWindowAnimationState NextState = PetSessionWindowHostAnimation::Close(AnimationState);
	if (NextState == EPetSessionWindowAnimationState::Closing)
	{
		BeginClosing();
	}
}

void FPetSessionWindowHost::TickWindowAnimation(const float DeltaTime)
{
	if (!IsGameThreadCall() || !SessionWindow.IsValid() ||
		AnimationState == EPetSessionWindowAnimationState::Hidden)
	{
		return;
	}

	AnimationProgress = PetSessionWindowHostAnimation::AdvanceProgress(
		AnimationState,
		AnimationProgress,
		DeltaTime,
		AnimationDuration);

	if (AnimationState == EPetSessionWindowAnimationState::Opening && AnimationProgress >= 1.0f)
	{
		AnimationState = EPetSessionWindowAnimationState::Visible;
	}
	else if (AnimationState == EPetSessionWindowAnimationState::Closing && AnimationProgress <= 0.0f)
	{
		AnimationProgress = 0.0f;
		ApplyWindowTransform(true);
		SessionWindow->HideWindow();
		AnimationState = EPetSessionWindowAnimationState::Hidden;
		StopContentActiveTimer();
		return;
	}

	ApplyWindowTransform(false);
}

void FPetSessionWindowHost::UpdateAnchor(const FSlateRect& PetBoundsInSlateScreen)
{
	if (!IsGameThreadCall() || !SessionWindow.IsValid() || !FSlateApplication::IsInitialized())
	{
		return;
	}

	const FSlateRect WorkArea = FSlateApplication::Get().GetWorkArea(PetBoundsInSlateScreen);
	WindowSizeInSlateScreen = ReadWindowSizeInSlateScreen();
	const FPetSessionWindowLayout Layout = PetSessionWindowHostLayout::Calculate(
		PetBoundsInSlateScreen,
		WorkArea,
		WindowSizeInSlateScreen);

	TargetPosition = Layout.Position;
	TargetWorkArea = Layout.WorkArea;
	bPanelOnLeft = Layout.bPlaceOnLeft;
	bHasAnchor = true;

	// 完全隐藏时只缓存锚点，避免窗口隐藏期间持续触碰位置。
	if (AnimationState != EPetSessionWindowAnimationState::Hidden)
	{
		ApplyWindowTransform(false);
	}
}

void FPetSessionWindowHost::ApplyWindowTransform(const bool bForceMove)
{
	if (!SessionWindow.IsValid())
	{
		return;
	}

	const float SlideDirection = bPanelOnLeft ? 1.0f : -1.0f;
	const FVector2f UnclampedAnimatedPosition = bHasAnchor
		? TargetPosition + FVector2f(SlideDirection * (1.0f - AnimationProgress) * SlideDistance, 0.0f)
		: FVector2f::ZeroVector;
	const FVector2f AnimatedPosition = bHasAnchor
		? ClampWindowPosition(UnclampedAnimatedPosition, TargetWorkArea, WindowSizeInSlateScreen)
		: FVector2f::ZeroVector;

	SessionWindow->SetOpacity(AnimationProgress);
	if (!bHasAnchor)
	{
		return;
	}

	const bool bPositionChangedEnough = !bHasMovedPosition ||
		FMath::Abs(AnimatedPosition.X - LastMovedPosition.X) >= PositionEpsilon ||
		FMath::Abs(AnimatedPosition.Y - LastMovedPosition.Y) >= PositionEpsilon;
	if (bForceMove || bPositionChangedEnough)
	{
		SessionWindow->MoveWindowTo(AnimatedPosition);
		LastMovedPosition = AnimatedPosition;
		bHasMovedPosition = true;
	}
}

FVector2f FPetSessionWindowHost::ReadWindowSizeInSlateScreen() const
{
	if (!SessionWindow.IsValid())
	{
		return FVector2f(PanelDesignWidth, PanelDesignHeight);
	}

	const FVector2f WindowSize = SessionWindow->GetSizeInScreen();
	return WindowSize.X > UE_SMALL_NUMBER && WindowSize.Y > UE_SMALL_NUMBER
		? WindowSize
		: FVector2f(PanelDesignWidth, PanelDesignHeight);
}

bool FPetSessionWindowHost::IsVisible() const
{
	return SessionWindow.IsValid() && AnimationState != EPetSessionWindowAnimationState::Hidden;
}
