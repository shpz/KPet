#include "UI/PetSessionWindowHost.h"

#include "Pet.h"

#include "Framework/Application/SlateApplication.h"
#include "GenericPlatform/GenericWindow.h"
#include "Widgets/SNullWidget.h"
#include "Widgets/SWidget.h"
#include "Widgets/SWindow.h"

#if PLATFORM_WINDOWS
#include "Windows/AllowWindowsPlatformTypes.h"
#include <Windows.h>
#include "Windows/HideWindowsPlatformTypes.h"
#endif

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

FPetSessionWindowSurfacePreparationState PetSessionWindowHostSurface::BeginOpening(
	const bool bNeedsWarmup,
	const float WarmupDuration)
{
	FPetSessionWindowSurfacePreparationState State;
	if (bNeedsWarmup)
	{
		State.Phase = EPetSessionWindowSurfacePreparationPhase::WarmingUp;
		State.Remaining = FMath::Max(WarmupDuration, 0.0f);
	}
	else
	{
		// 关闭动画中途反向打开时原生窗口与 CEF 都未隐藏，可立即重放一次内容。
		State.bContentReplayReady = true;
	}
	return State;
}

bool PetSessionWindowHostSurface::Advance(
	FPetSessionWindowSurfacePreparationState& State,
	const float DeltaTime,
	const float RefreshDuration)
{
	const float SafeDeltaTime = FMath::Max(DeltaTime, 0.0f);
	switch (State.Phase)
	{
	case EPetSessionWindowSurfacePreparationPhase::WarmingUp:
		State.Remaining = FMath::Max(0.0f, State.Remaining - SafeDeltaTime);
		// 累计帧时长常会留下接近零的浮点尾差；不能因此多等一帧，
		// 否则内容重放信号与透明保持时长都会偏离配置值。
		if (State.Remaining > UE_KINDA_SMALL_NUMBER)
		{
			return false;
		}
		// CEF 已脱离 WasHidden；此时才允许内容层下发快照与 refreshSurface。
		State.Phase = EPetSessionWindowSurfacePreparationPhase::Refreshing;
		State.Remaining = FMath::Max(RefreshDuration, 0.0f);
		State.bContentReplayReady = true;
		return true;

	case EPetSessionWindowSurfacePreparationPhase::Refreshing:
		State.Remaining = FMath::Max(0.0f, State.Remaining - SafeDeltaTime);
		if (State.Remaining <= UE_KINDA_SMALL_NUMBER)
		{
			State.Remaining = 0.0f;
			State.Phase = EPetSessionWindowSurfacePreparationPhase::Ready;
		}
		return false;

	case EPetSessionWindowSurfacePreparationPhase::Ready:
	default:
		return false;
	}
}

bool PetSessionWindowHostSurface::ConsumeContentReplayReady(
	FPetSessionWindowSurfacePreparationState& State)
{
	const bool bWasReady = State.bContentReplayReady;
	State.bContentReplayReady = false;
	return bWasReady;
}

bool PetSessionWindowHostSurface::ShouldKeepWindowTransparent(
	const FPetSessionWindowSurfacePreparationState& State)
{
	return State.Phase != EPetSessionWindowSurfacePreparationPhase::Ready;
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
		.ClientSize(ClientSize);

	// TakeWidget 只在创建时接入 Slate。Host 不保存会话数据，也不包装 Widget 的选择委托。
	SessionContent = Content;
	SessionWindow->SetContent(SessionContent.ToSharedRef());
	FSlateApplication::Get().AddWindow(SessionWindow.ToSharedRef(), false);
	SessionWindow->SetOpacity(0.0f);
	SessionWindow->HideWindow();
	WindowSizeInSlateScreen = ReadWindowSizeInSlateScreen();
	ApplyRoundedWindowRegion(true);

	AnimationState = EPetSessionWindowAnimationState::Hidden;
	AnimationProgress = 0.0f;
	SurfacePreparation = FPetSessionWindowSurfacePreparationState();
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
	SurfacePreparation = FPetSessionWindowSurfacePreparationState();
	LastRoundedRegionSize = FIntPoint::NoneValue;
	LastRoundedRegionRadius = INDEX_NONE;
	bHasAnchor = false;
	bHasMovedPosition = false;
	StopContentActiveTimer();

	if (!SessionWindow.IsValid())
	{
		SessionContent.Reset();
		return;
	}

	// 先停止显示，再断开 SObjectWidget，最后请求 Slate 销毁窗口，避免 Widget 被延迟 GC。
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
	// 已彻底隐藏的窗口恢复时，CEF 要先从 WasHidden 状态苏醒并补齐软件纹理。
	// 关闭动画中途反向打开仍有完整纹理，不额外等待，保证快速反向操作连贯。
	const bool bNeedsSurfaceWarmup = !SessionWindow->IsVisible();
	AnimationState = EPetSessionWindowAnimationState::Opening;
	SurfacePreparation = PetSessionWindowHostSurface::BeginOpening(
		bNeedsSurfaceWarmup,
		SurfaceWarmupDuration);
	if (bNeedsSurfaceWarmup)
	{
		// 原生窗口若已隐藏，旧动画进度不再具有视觉连续性；必须从全透明开始预热，
		// 避免异常关闭/重显交错时沿用非零 alpha 露出尚未刷新的浏览器表面。
		AnimationProgress = 0.0f;
	}
	StartContentActiveTimer();
	// 先设置透明度与锚点位置，再让 Slate 显示窗口，避免透明窗口先出现在默认的 0,0。
	ApplyWindowTransform(true);
	if (SessionWindow.IsValid() && !SessionWindow->IsVisible())
	{
		SessionWindow->ShowWindow();
		// ShowWindow 首次会创建 Slate viewport，并可能重写原生分层窗口属性；显示后
		// 立即重放透明度与色键，避免首帧短暂露出黑色矩形。
		ApplyWindowTransform(true);
		ApplyRoundedWindowRegion(true);
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
	SurfacePreparation = FPetSessionWindowSurfacePreparationState();
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

	if (AnimationState == EPetSessionWindowAnimationState::Opening &&
		PetSessionWindowHostSurface::ShouldKeepWindowTransparent(SurfacePreparation))
	{
		PetSessionWindowHostSurface::Advance(
			SurfacePreparation,
			DeltaTime,
			SurfaceRefreshDuration);
		// 预热和整页刷新阶段保持当前进度（隐藏态打开时为 0），每帧重申原生综合色键，
		// 防止 viewport 初始化或窗口重显覆盖 LWA_COLORKEY。
		ApplyWindowTransform(false);
		if (PetSessionWindowHostSurface::ShouldKeepWindowTransparent(SurfacePreparation))
		{
			return;
		}
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
		SurfacePreparation = FPetSessionWindowSurfacePreparationState();
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

	ApplyWindowOpacity(AnimationProgress);
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
		// 跨显示器移动可能同步改变原生窗口 DPI 与物理尺寸；按新尺寸更新圆角区域。
		ApplyRoundedWindowRegion(false);
	}
}

void FPetSessionWindowHost::ApplyWindowOpacity(const float Opacity)
{
	if (!SessionWindow.IsValid())
	{
		return;
	}

	// 保持 SWindow 内部状态与平台层整窗 alpha 一致；Windows 下的色键由下方调用补上。
	SessionWindow->SetOpacity(Opacity);

#if PLATFORM_WINDOWS
	// Slate 弹窗在 Windows 经不透明 swapchain 上屏：PerWindow 只提供整窗 alpha，
	// 像素 alpha 被 DWM 忽略，两个透明 WebUI 页面卡片外区域因此会渲染成黑框。
	// 给分层窗口追加黑色色键（LWA_COLORKEY）：CEF 透明像素预乘后恰为纯黑，
	// 由 DWM 抠除透出桌面；LWA_ALPHA 继续承担整窗淡入淡出。
	// 代价：页面任何元素都不得使用纯黑 RGB(0,0,0)，且半透明像素按预乘色显示
	// （卡片圆角与阴影呈暗化描边，而不是与桌面混合）。
	const TSharedPtr<FGenericWindow>& NativeWindow = SessionWindow->GetNativeWindow();
	if (NativeWindow.IsValid())
	{
		if (HWND HWnd = static_cast<HWND>(NativeWindow->GetOSWindowHandle()))
		{
			::SetLayeredWindowAttributes(
				HWnd,
				RGB(0, 0, 0),
				static_cast<BYTE>(FMath::Clamp(FMath::TruncToInt(Opacity * 255.0f), 0, 255)),
				LWA_COLORKEY | LWA_ALPHA);
		}
	}
#endif
}

void FPetSessionWindowHost::ApplyRoundedWindowRegion(const bool bForce)
{
#if PLATFORM_WINDOWS
	if (!SessionWindow.IsValid())
	{
		return;
	}

	const TSharedPtr<FGenericWindow>& NativeWindow = SessionWindow->GetNativeWindow();
	if (!NativeWindow.IsValid())
	{
		return;
	}

	HWND HWnd = static_cast<HWND>(NativeWindow->GetOSWindowHandle());
	RECT WindowRect = {};
	if (!HWnd || !::GetWindowRect(HWnd, &WindowRect))
	{
		return;
	}

	const int32 Width = WindowRect.right - WindowRect.left;
	const int32 Height = WindowRect.bottom - WindowRect.top;
	if (Width <= 0 || Height <= 0)
	{
		return;
	}

	const uint32 WindowDpi = ::GetDpiForWindow(HWnd);
	const float DpiScale = WindowDpi > 0 ? static_cast<float>(WindowDpi) / 96.0f : 1.0f;
	const int32 Radius = FMath::Max(1, FMath::RoundToInt(RoundedCornerRadius * DpiScale));
	const FIntPoint RegionSize(Width, Height);
	if (!bForce && RegionSize == LastRoundedRegionSize && Radius == LastRoundedRegionRadius)
	{
		return;
	}

	// CreateRoundRectRgn 的右下边界会少一像素，按 UE 自身 WindowsWindow 实现加一补齐。
	HRGN RoundedRegion = ::CreateRoundRectRgn(0, 0, Width + 1, Height + 1, Radius * 2, Radius * 2);
	if (!RoundedRegion)
	{
		UE_LOG(LogPet, Warning, TEXT("创建 WebUI 窗口圆角区域失败，Win 错误码=%lu"), ::GetLastError());
		return;
	}

	// SetWindowRgn 成功后区域句柄归系统所有；失败时仍由调用方释放。
	if (::SetWindowRgn(HWnd, RoundedRegion, true) == 0)
	{
		const DWORD ErrorCode = ::GetLastError();
		::DeleteObject(RoundedRegion);
		UE_LOG(LogPet, Warning, TEXT("应用 WebUI 窗口圆角区域失败，Win 错误码=%lu"), ErrorCode);
		return;
	}

	LastRoundedRegionSize = RegionSize;
	LastRoundedRegionRadius = Radius;
#else
	(void)bForce;
#endif
}

FVector2f FPetSessionWindowHost::ReadWindowSizeInSlateScreen() const
{
	if (!SessionWindow.IsValid())
	{
		return ClientSize;
	}

	const FVector2f WindowSize = SessionWindow->GetSizeInScreen();
	return WindowSize.X > UE_SMALL_NUMBER && WindowSize.Y > UE_SMALL_NUMBER
		? WindowSize
		: ClientSize;
}

bool FPetSessionWindowHost::IsVisible() const
{
	return SessionWindow.IsValid() && AnimationState != EPetSessionWindowAnimationState::Hidden;
}

bool FPetSessionWindowHost::ConsumeContentSurfaceReady()
{
	if (!IsGameThreadCall())
	{
		return false;
	}

	return PetSessionWindowHostSurface::ConsumeContentReplayReady(SurfacePreparation);
}
