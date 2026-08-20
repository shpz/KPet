#pragma once

#include "CoreMinimal.h"
#include "Layout/SlateRect.h"

class FActiveTimerHandle;
class SWidget;
class SWindow;
enum class EActiveTimerReturnType : uint8;

/** 窗口布局计算结果。所有字段均使用 Slate 屏幕坐标。 */
struct FPetSessionWindowLayout
{
	FVector2f Position = FVector2f::ZeroVector;
	FSlateRect WorkArea;
	bool bPlaceOnLeft = false;
};

/**
 * 会话窗口的无平台布局函数。
 *
 * PetBounds、WorkArea、WindowSize 和返回的位置必须使用同一套 Slate 屏幕单位。
 * 该函数不访问平台 API，也不读取任何会话数据。
 */
namespace PetSessionWindowHostLayout
{
	FPetSessionWindowLayout Calculate(
		const FSlateRect& PetBounds,
		const FSlateRect& WorkArea,
		const FVector2f& WindowSize,
		float Gap = 10.0f);
}

/** 窗口级动画四态。 */
enum class EPetSessionWindowAnimationState : uint8
{
	Hidden,
	Opening,
	Visible,
	Closing
};

/** 窗口级动画的无平台状态推进函数。 */
namespace PetSessionWindowHostAnimation
{
	EPetSessionWindowAnimationState Toggle(EPetSessionWindowAnimationState State);
	EPetSessionWindowAnimationState Close(EPetSessionWindowAnimationState State);
	float AdvanceProgress(
		EPetSessionWindowAnimationState State,
		float Progress,
		float DeltaTime,
		float AnimationDuration);
}

/**
 * 隐藏后的 Web 内容表面恢复阶段。
 *
 * 先让 CEF 从 WasHidden 状态醒来，再允许内容重放；重放后额外保持透明，
 * 留出两帧完整重绘覆盖旧的脏矩形。该状态机不接触 Slate 或浏览器，供自动化测试验证时序。
 */
enum class EPetSessionWindowSurfacePreparationPhase : uint8
{
	Ready,
	WarmingUp,
	Refreshing
};

struct FPetSessionWindowSurfacePreparationState
{
	EPetSessionWindowSurfacePreparationPhase Phase = EPetSessionWindowSurfacePreparationPhase::Ready;
	float Remaining = 0.0f;
	/** 预热结束或无需预热时置位；调用方取走后清除，保证每个可见周期只重放一次。 */
	bool bContentReplayReady = false;
};

namespace PetSessionWindowHostSurface
{
	FPetSessionWindowSurfacePreparationState BeginOpening(bool bNeedsWarmup, float WarmupDuration);

	/**
	 * 推进一次表面恢复。返回 true 表示预热刚完成，调用方可安全下发全量内容；
	 * Refreshing 阶段仍需保持窗口透明，直到两帧整页重绘完成。
	 */
	bool Advance(
		FPetSessionWindowSurfacePreparationState& State,
		float DeltaTime,
		float RefreshDuration);

	bool ConsumeContentReplayReady(FPetSessionWindowSurfacePreparationState& State);
	bool ShouldKeepWindowTransparent(const FPetSessionWindowSurfacePreparationState& State);
}

/**
 * 跨平台会话面板的 Slate 窗口宿主。
 *
 * Host 只负责 SWindow 的生命周期、显示状态、位置和窗口级动画，不持有会话数据，
 * 不解释 Bridge 消息，也不暴露任何平台窗口句柄。
 */
class FPetSessionWindowHost
{
public:
	FPetSessionWindowHost() = default;
	~FPetSessionWindowHost();

	bool Create(TSharedRef<SWidget> Content);
	void Destroy();

	/**
	 * Create 之前设置窗口客户区尺寸（Slate 设计单位，DPI 由 AdjustInitialSizeAndPositionForDPIScale
	 * 在平台层处理）。默认会话面板 360×234；设置面板使用 340×270 的紧凑卡片。
	 */
	void SetClientSize(const FVector2f& InClientSize) { ClientSize = InClientSize; }

	void Toggle();
	void Close();
	void TickWindowAnimation(float DeltaTime);
	void UpdateAnchor(const FSlateRect& PetBoundsInSlateScreen);

	bool IsVisible() const;

	/**
	 * 取出一次性内容表面就绪信号。隐藏后重显时，只有收到该信号才应向 Web 内容
	 * 下发快照或强制刷新；Host 不保存也不解释任何会话数据。
	 */
	bool ConsumeContentSurfaceReady();

private:
	/** 会话面板默认尺寸：360×234。 */
	static constexpr float DefaultPanelWidth = 360.0f;
	static constexpr float DefaultPanelHeight = 234.0f;
	static constexpr float AnimationDuration = 0.18f;
	/** 首次或隐藏后显示时先给 CEF 退出 WasHidden 状态的预热时间。 */
	static constexpr float SurfaceWarmupDuration = 0.10f;
	/** 内容重放与 refreshSurface 后，继续保持透明以等待整页重绘落到纹理。 */
	static constexpr float SurfaceRefreshDuration = 0.10f;
	/** 与两个 Web 页面卡片一致的逻辑像素圆角半径。 */
	static constexpr float RoundedCornerRadius = 14.0f;
	static constexpr float SlideDistance = 18.0f;

	void BeginOpening();
	void BeginClosing();
	void StartContentActiveTimer();
	void StopContentActiveTimer();
	EActiveTimerReturnType HandleContentActiveTimer(double CurrentTime, float DeltaTime);
	void ApplyWindowTransform(bool bForceMove);
	/** 设置窗口透明度；Windows 下附带黑色色键，让透明页面的卡片外区域透出桌面。 */
	void ApplyWindowOpacity(float Opacity);
	/** Windows 下用原生窗口区域硬裁四角，综合色键失效时也不会退化为黑色矩形。 */
	void ApplyRoundedWindowRegion(bool bForce);
	FVector2f ReadWindowSizeInSlateScreen() const;
	bool IsGameThreadCall() const;

	TSharedPtr<SWindow> SessionWindow;
	TSharedPtr<SWidget> SessionContent;
	TSharedPtr<FActiveTimerHandle> ContentActiveTimerHandle;
	EPetSessionWindowAnimationState AnimationState = EPetSessionWindowAnimationState::Hidden;
	float AnimationProgress = 0.0f;
	FPetSessionWindowSurfacePreparationState SurfacePreparation;
	FIntPoint LastRoundedRegionSize = FIntPoint::NoneValue;
	int32 LastRoundedRegionRadius = INDEX_NONE;

	/** 窗口客户区尺寸（Slate 设计单位），Create 时写入 SWindow。 */
	FVector2f ClientSize = FVector2f(DefaultPanelWidth, DefaultPanelHeight);

	FVector2f TargetPosition = FVector2f::ZeroVector;
	FSlateRect TargetWorkArea;
	FVector2f WindowSizeInSlateScreen = FVector2f(DefaultPanelWidth, DefaultPanelHeight);
	FVector2f LastMovedPosition = FVector2f::ZeroVector;
	bool bHasAnchor = false;
	bool bHasMovedPosition = false;
	bool bPanelOnLeft = false;
};
