#include "UI/PetSessionWindowHost.h"
#include "Misc/AutomationTest.h"

#if WITH_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetSessionWindowHostLayoutTest,
	"Pet.UI.SessionWindowHost.Layout",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetSessionWindowHostLayoutTest::RunTest(const FString& Parameters)
{
	const FVector2f WindowSize(360.0f, 234.0f);

	{
		const FPetSessionWindowLayout Layout = PetSessionWindowHostLayout::Calculate(
			FSlateRect(500.0f, 300.0f, 600.0f, 400.0f),
			FSlateRect(0.0f, 0.0f, 1920.0f, 1080.0f),
			WindowSize);
		TestFalse(TEXT("空间充足时面板放在右侧"), Layout.bPlaceOnLeft);
		TestEqual(TEXT("右侧间距"), Layout.Position.X, 610.0f);
		TestEqual(TEXT("垂直居中"), Layout.Position.Y, 233.0f);
	}

	{
		const FPetSessionWindowLayout Layout = PetSessionWindowHostLayout::Calculate(
			FSlateRect(700.0f, 300.0f, 800.0f, 400.0f),
			FSlateRect(0.0f, 0.0f, 1000.0f, 800.0f),
			WindowSize);
		TestTrue(TEXT("右侧不足且左侧更宽时翻转到左侧"), Layout.bPlaceOnLeft);
		TestEqual(TEXT("左侧间距"), Layout.Position.X, 330.0f);
	}

	{
		const FPetSessionWindowLayout Layout = PetSessionWindowHostLayout::Calculate(
			FSlateRect(-300.0f, -200.0f, -200.0f, -100.0f),
			FSlateRect(-1920.0f, -1080.0f, 0.0f, 0.0f),
			WindowSize);
		TestTrue(TEXT("负坐标工作区保持负坐标"), Layout.Position.X < 0.0f && Layout.Position.Y < 0.0f);
		TestTrue(TEXT("窗口左边界受工作区约束"), Layout.Position.X >= Layout.WorkArea.Left);
		TestTrue(TEXT("窗口上边界受工作区约束"), Layout.Position.Y >= Layout.WorkArea.Top);
		TestTrue(TEXT("窗口右边界受工作区约束"), Layout.Position.X + WindowSize.X <= Layout.WorkArea.Right);
		TestTrue(TEXT("窗口下边界受工作区约束"), Layout.Position.Y + WindowSize.Y <= Layout.WorkArea.Bottom);
	}

	{
		// DPI 缩放后的窗口尺寸以 GetSizeInScreen 返回的平台屏幕物理像素为准，
		// 不能再次使用面板设计尺寸参与边界计算。
		constexpr float DpiScales[] = {1.0f, 1.25f, 1.5f, 2.0f};
		for (const float DpiScale : DpiScales)
		{
			const FVector2f ScaledWindowSize = WindowSize * DpiScale;
			const FPetSessionWindowLayout Layout = PetSessionWindowHostLayout::Calculate(
				FSlateRect(1750.0f, 700.0f, 1850.0f, 800.0f),
				FSlateRect(0.0f, 0.0f, 1920.0f, 1080.0f),
				ScaledWindowSize);
			TestTrue(FString::Printf(TEXT("%.0f%% DPI 输入触发左右翻转"), DpiScale * 100.0f), Layout.bPlaceOnLeft);
			TestTrue(
				FString::Printf(TEXT("%.0f%% DPI 右边界受工作区约束"), DpiScale * 100.0f),
				Layout.Position.X + ScaledWindowSize.X <= Layout.WorkArea.Right);
			TestTrue(
				FString::Printf(TEXT("%.0f%% DPI 下边界受工作区约束"), DpiScale * 100.0f),
				Layout.Position.Y + ScaledWindowSize.Y <= Layout.WorkArea.Bottom);
		}
	}

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetSessionWindowHostAnimationTest,
	"Pet.UI.SessionWindowHost.Animation",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetSessionWindowHostAnimationTest::RunTest(const FString& Parameters)
{
	using EState = EPetSessionWindowAnimationState;

	TestEqual(TEXT("隐藏切换到打开"),
		PetSessionWindowHostAnimation::Toggle(EState::Hidden),
		EState::Opening);
	TestEqual(TEXT("打开中切换立即反向关闭"),
		PetSessionWindowHostAnimation::Toggle(EState::Opening),
		EState::Closing);
	TestEqual(TEXT("关闭中切换立即反向打开"),
		PetSessionWindowHostAnimation::Toggle(EState::Closing),
		EState::Opening);
	TestEqual(TEXT("可见态切换立即关闭"),
		PetSessionWindowHostAnimation::Toggle(EState::Visible),
		EState::Closing);
	TestEqual(TEXT("关闭请求不改变隐藏态"),
		PetSessionWindowHostAnimation::Close(EState::Hidden),
		EState::Hidden);
	TestEqual(TEXT("打开中关闭请求"),
		PetSessionWindowHostAnimation::Close(EState::Opening),
		EState::Closing);
	TestEqual(TEXT("关闭中关闭请求保持"),
		PetSessionWindowHostAnimation::Close(EState::Closing),
		EState::Closing);
	TestEqual(TEXT("可见态关闭请求"),
		PetSessionWindowHostAnimation::Close(EState::Visible),
		EState::Closing);

	TestEqual(TEXT("打开推进到上限"),
		PetSessionWindowHostAnimation::AdvanceProgress(EState::Opening, 0.5f, 0.5f, 0.5f),
		1.0f);
	TestEqual(TEXT("关闭推进到下限"),
		PetSessionWindowHostAnimation::AdvanceProgress(EState::Closing, 0.5f, 0.5f, 0.5f),
		0.0f);
	TestEqual(TEXT("可见态推进保持上限"),
		PetSessionWindowHostAnimation::AdvanceProgress(EState::Visible, 0.5f, 0.5f, 0.5f),
		1.0f);
	TestEqual(TEXT("隐藏态推进保持下限"),
		PetSessionWindowHostAnimation::AdvanceProgress(EState::Hidden, 0.5f, 0.5f, 0.5f),
		0.0f);

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetSessionWindowHostSurfacePreparationTest,
	"Pet.UI.SessionWindowHost.SurfacePreparation",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetSessionWindowHostSurfacePreparationTest::RunTest(const FString& Parameters)
{
	using EPhase = EPetSessionWindowSurfacePreparationPhase;
	constexpr float WarmupDuration = 0.10f;
	constexpr float RefreshDuration = 0.10f;

	// 两个 Host 分别承载会话页和设置页；它们的信号必须彼此独立，且在预热期不允许下发。
	FPetSessionWindowSurfacePreparationState SessionSurface =
		PetSessionWindowHostSurface::BeginOpening(true, WarmupDuration);
	FPetSessionWindowSurfacePreparationState SettingsSurface =
		PetSessionWindowHostSurface::BeginOpening(true, WarmupDuration);
	TestEqual(TEXT("会话页隐藏后打开先进入预热"), SessionSurface.Phase, EPhase::WarmingUp);
	TestEqual(TEXT("设置页隐藏后打开先进入预热"), SettingsSurface.Phase, EPhase::WarmingUp);
	TestFalse(TEXT("会话页预热开始时不下发快照"),
		PetSessionWindowHostSurface::ConsumeContentReplayReady(SessionSurface));
	TestFalse(TEXT("设置页预热开始时不下发快照"),
		PetSessionWindowHostSurface::ConsumeContentReplayReady(SettingsSurface));

	TestFalse(TEXT("会话页预热未结束不发就绪信号"),
		PetSessionWindowHostSurface::Advance(SessionSurface, 0.04f, RefreshDuration));
	TestFalse(TEXT("设置页预热未结束不发就绪信号"),
		PetSessionWindowHostSurface::Advance(SettingsSurface, 0.04f, RefreshDuration));
	TestTrue(TEXT("预热期会话页保持透明"),
		PetSessionWindowHostSurface::ShouldKeepWindowTransparent(SessionSurface));
	TestTrue(TEXT("预热期设置页保持透明"),
		PetSessionWindowHostSurface::ShouldKeepWindowTransparent(SettingsSurface));

	TestTrue(TEXT("会话页预热结束仅发一次就绪信号"),
		PetSessionWindowHostSurface::Advance(SessionSurface, 0.06f, RefreshDuration));
	TestTrue(TEXT("设置页预热结束仅发一次就绪信号"),
		PetSessionWindowHostSurface::Advance(SettingsSurface, 0.06f, RefreshDuration));
	TestEqual(TEXT("会话页进入整页刷新等待"), SessionSurface.Phase, EPhase::Refreshing);
	TestEqual(TEXT("设置页进入整页刷新等待"), SettingsSurface.Phase, EPhase::Refreshing);
	TestTrue(TEXT("会话页可取到一次重放信号"),
		PetSessionWindowHostSurface::ConsumeContentReplayReady(SessionSurface));
	TestTrue(TEXT("设置页可取到一次重放信号"),
		PetSessionWindowHostSurface::ConsumeContentReplayReady(SettingsSurface));
	TestFalse(TEXT("会话页重放信号不可重复消费"),
		PetSessionWindowHostSurface::ConsumeContentReplayReady(SessionSurface));
	TestFalse(TEXT("设置页重放信号不可重复消费"),
		PetSessionWindowHostSurface::ConsumeContentReplayReady(SettingsSurface));

	PetSessionWindowHostSurface::Advance(SessionSurface, RefreshDuration, RefreshDuration);
	PetSessionWindowHostSurface::Advance(SettingsSurface, RefreshDuration, RefreshDuration);
	TestEqual(TEXT("会话页整页刷新后允许淡入"), SessionSurface.Phase, EPhase::Ready);
	TestEqual(TEXT("设置页整页刷新后允许淡入"), SettingsSurface.Phase, EPhase::Ready);

	// 关闭动画中途反向打开时没有进入 WasHidden，应立即下发一次而不额外等待预热。
	FPetSessionWindowSurfacePreparationState ReversedSurface =
		PetSessionWindowHostSurface::BeginOpening(false, WarmupDuration);
	TestEqual(TEXT("关闭中反向打开无需预热"), ReversedSurface.Phase, EPhase::Ready);
	TestTrue(TEXT("关闭中反向打开立即允许重放"),
		PetSessionWindowHostSurface::ConsumeContentReplayReady(ReversedSurface));
	TestFalse(TEXT("关闭中反向打开的信号仅一次"),
		PetSessionWindowHostSurface::ConsumeContentReplayReady(ReversedSurface));
	TestFalse(TEXT("关闭中反向打开不保持透明"),
		PetSessionWindowHostSurface::ShouldKeepWindowTransparent(ReversedSurface));

	return true;
}

#endif
