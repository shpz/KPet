#pragma once

#include "CoreMinimal.h"
#include "Layout/SlateRect.h"

class FActiveTimerHandle;
class SWidget;
class SWindow;
class UPetSessionPanelWidget;
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
	bool Create(UPetSessionPanelWidget* PanelWidget);
	void Destroy();

	void Toggle();
	void Close();
	void TickWindowAnimation(float DeltaTime);
	void UpdateAnchor(const FSlateRect& PetBoundsInSlateScreen);

	bool IsVisible() const;

private:
	static constexpr float PanelDesignWidth = 360.0f;
	static constexpr float PanelDesignHeight = 234.0f;
	static constexpr float AnimationDuration = 0.18f;
	static constexpr float SlideDistance = 18.0f;

	void BeginOpening();
	void BeginClosing();
	void StartContentActiveTimer();
	void StopContentActiveTimer();
	EActiveTimerReturnType HandleContentActiveTimer(double CurrentTime, float DeltaTime);
	void ApplyWindowTransform(bool bForceMove);
	FVector2f ReadWindowSizeInSlateScreen() const;
	bool IsGameThreadCall() const;

	TSharedPtr<SWindow> SessionWindow;
	TSharedPtr<SWidget> SessionContent;
	TSharedPtr<FActiveTimerHandle> ContentActiveTimerHandle;
	EPetSessionWindowAnimationState AnimationState = EPetSessionWindowAnimationState::Hidden;
	float AnimationProgress = 0.0f;

	FVector2f TargetPosition = FVector2f::ZeroVector;
	FSlateRect TargetWorkArea;
	FVector2f WindowSizeInSlateScreen = FVector2f(PanelDesignWidth, PanelDesignHeight);
	FVector2f LastMovedPosition = FVector2f::ZeroVector;
	bool bHasAnchor = false;
	bool bHasMovedPosition = false;
	bool bPanelOnLeft = false;
};
