#pragma once

#include "CoreMinimal.h"

/** 面板标识。 */
enum class EPetPanel : uint8
{
	None,
	Session,
	Settings
};

/** 面板堆栈导航的纯状态。 */
struct FPetPanelStackState
{
	/** 当前用户可见（正在交互）的面板；None 表示两面板均不可见。 */
	EPetPanel Visible = EPetPanel::None;

	/** 被压栈隐藏、等待恢复的面板；None 表示栈空。两面板场景深度不超过 1。 */
	EPetPanel Stashed = EPetPanel::None;
};

/** 一次栈推进需要外部（Pawn 执行层）完成的面板动作。 */
struct FPetPanelStackStep
{
	/** 需要先关闭的面板（被压栈隐藏）；None 表示无需关闭。 */
	EPetPanel Close = EPetPanel::None;

	/** 需要打开的面板（本次主张打开或弹栈恢复）；None 表示无需打开。 */
	EPetPanel Open = EPetPanel::None;
};

/**
 * 面板堆栈式导航的纯逻辑状态机。
 *
 * 只操作面板标识与状态，不访问平台窗口、Slate 或 Web 数据，可独立单测。
 * 两面板场景栈深度不超过 1：打开某个面板时把当前可见面板压栈记住并关闭，
 * 关闭当前面板时若栈非空则弹栈恢复。各推进函数返回新状态，同时把要由
 * 执行层完成的外部动作写入 OutStep。
 */
namespace PetPanelStack
{
	/**
	 * 切换指定面板的打开/关闭（单击宠物切换会话面板、Ctrl+, 切换设置面板）。
	 * 目标面板当前可见则关闭它并弹栈恢复；否则打开它并把当前可见面板压栈。
	 */
	FPetPanelStackState Toggle(FPetPanelStackState State, EPetPanel Panel, FPetPanelStackStep& OutStep);

	/** 无条件关闭指定面板（面板 × 按钮、选中会话等关闭路径）；栈非空时弹栈恢复。 */
	FPetPanelStackState Close(FPetPanelStackState State, EPetPanel Panel, FPetPanelStackStep& OutStep);

	/** 清空栈状态（面板整体销毁/退出时调用）；执行层应随后销毁全部面板。 */
	FPetPanelStackState Reset();
}

inline FPetPanelStackState PetPanelStack::Toggle(
	FPetPanelStackState State,
	EPetPanel Panel,
	FPetPanelStackStep& OutStep)
{
	OutStep = FPetPanelStackStep();
	if (Panel == EPetPanel::None)
	{
		return State;
	}

	if (State.Visible == Panel)
	{
		// 目标面板当前可见 -> 关闭它，并从栈中弹回被压置的面板。
		OutStep.Close = Panel;
		if (State.Stashed != EPetPanel::None)
		{
			OutStep.Open = State.Stashed;
			State.Visible = State.Stashed;
			State.Stashed = EPetPanel::None;
		}
		else
		{
			State.Visible = EPetPanel::None;
		}
	}
	else
	{
		// 目标面板隐藏 -> 打开它；若另有面板可见则将其压栈关闭。
		const EPetPanel Displaced = State.Visible;
		if (Displaced != EPetPanel::None)
		{
			State.Stashed = Displaced;
			OutStep.Close = Displaced;
		}
		OutStep.Open = Panel;
		State.Visible = Panel;
	}
	return State;
}

inline FPetPanelStackState PetPanelStack::Close(
	FPetPanelStackState State,
	EPetPanel Panel,
	FPetPanelStackStep& OutStep)
{
	OutStep = FPetPanelStackStep();
	if (Panel == EPetPanel::None || State.Visible != Panel)
	{
		// 目标面板并非当前可见，无需推进（× 按钮只会在面板可见时到达）。
		return State;
	}

	OutStep.Close = Panel;
	if (State.Stashed != EPetPanel::None)
	{
		// 栈里压着另一面板 -> 弹栈，由执行层恢复打开。
		OutStep.Open = State.Stashed;
		State.Visible = State.Stashed;
		State.Stashed = EPetPanel::None;
	}
	else
	{
		State.Visible = EPetPanel::None;
	}
	return State;
}

inline FPetPanelStackState PetPanelStack::Reset()
{
	return FPetPanelStackState();
}
