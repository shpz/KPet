#include "UI/PetPanelStack.h"
#include "Misc/AutomationTest.h"

#if WITH_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetPanelStackTest,
	"Pet.UI.PanelStack",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetPanelStackTest::RunTest(const FString& Parameters)
{
	using EPanel = EPetPanel;
	FPetPanelStackStep Step;

	// ---- 空栈打开：只打开目标面板，无压栈关闭 ----
	{
		FPetPanelStackState State;
		State = PetPanelStack::Toggle(State, EPanel::Session, Step);
		TestEqual(TEXT("空栈打开会话 -> 可见会话"), State.Visible, EPanel::Session);
		TestEqual(TEXT("空栈打开会话 -> 栈空"), State.Stashed, EPanel::None);
		TestEqual(TEXT("空栈打开会话 -> 无面板被关闭"), Step.Close, EPanel::None);
		TestEqual(TEXT("空栈打开会话 -> 打开会话"), Step.Open, EPanel::Session);
	}

	// ---- 可见且栈空时 Toggle 关闭 ----
	{
		FPetPanelStackState State;
		State = PetPanelStack::Toggle(State, EPanel::Settings, Step); // 打开设置
		State = PetPanelStack::Toggle(State, EPanel::Settings, Step); // 再切 -> 关闭
		TestEqual(TEXT("可见设置再 Toggle -> 无可见面板"), State.Visible, EPanel::None);
		TestEqual(TEXT("可见设置再 Toggle -> 栈空"), State.Stashed, EPanel::None);
		TestEqual(TEXT("可见设置再 Toggle -> 关闭设置"), Step.Close, EPanel::Settings);
		TestEqual(TEXT("可见设置再 Toggle -> 无恢复面板"), Step.Open, EPanel::None);
	}

	// ---- 打开设置时压栈会话（需求 1）----
	{
		FPetPanelStackState State;
		State = PetPanelStack::Toggle(State, EPanel::Session, Step);           // 会话可见
		State = PetPanelStack::Toggle(State, EPanel::Settings, Step);          // 打开设置
		TestEqual(TEXT("开设置可见会话被压栈"), State.Stashed, EPanel::Session);
		TestEqual(TEXT("开设置后可见设置"), State.Visible, EPanel::Settings);
		TestEqual(TEXT("开设置时关闭被压栈会话"), Step.Close, EPanel::Session);
		TestEqual(TEXT("开设置时打开设置"), Step.Open, EPanel::Settings);
	}

	// ---- 设置关闭（× 按钮/再次 Ctrl+,）弹栈恢复会话（需求 2、6）----
	{
		FPetPanelStackState State;
		State = PetPanelStack::Toggle(State, EPanel::Session, Step);
		State = PetPanelStack::Toggle(State, EPanel::Settings, Step);  // 会话被压栈
		State = PetPanelStack::Toggle(State, EPanel::Settings, Step);  // 再 Ctrl+, -> 关闭设置
		TestEqual(TEXT("再次 Ctrl+, 恢复会话可见"), State.Visible, EPanel::Session);
		TestEqual(TEXT("再次 Ctrl+, 栈已弹空"), State.Stashed, EPanel::None);
		TestEqual(TEXT("再次 Ctrl+, 关闭设置"), Step.Close, EPanel::Settings);
		TestEqual(TEXT("再次 Ctrl+, 恢复会话"), Step.Open, EPanel::Session);
	}

	// ---- × 按钮路径用 Close：设置可见且会话压栈时关闭设置 -> 恢复会话 ----
	{
		FPetPanelStackState State;
		State = PetPanelStack::Toggle(State, EPanel::Session, Step);
		State = PetPanelStack::Toggle(State, EPanel::Settings, Step);
		State = PetPanelStack::Close(State, EPanel::Settings, Step);
		TestEqual(TEXT("设置 × 关闭后恢复会话可见"), State.Visible, EPanel::Session);
		TestEqual(TEXT("设置 × 关闭后栈弹空"), State.Stashed, EPanel::None);
		TestEqual(TEXT("设置 × 关闭时关闭设置"), Step.Close, EPanel::Settings);
		TestEqual(TEXT("设置 × 关闭时恢复会话"), Step.Open, EPanel::Session);
	}

	// ---- 对称处理：设置可见时打开会话 -> 压栈设置（需求 3）----
	{
		FPetPanelStackState State;
		State = PetPanelStack::Toggle(State, EPanel::Settings, Step);          // 设置可见
		State = PetPanelStack::Toggle(State, EPanel::Session, Step);           // 单击宠物开会话
		TestEqual(TEXT("开会话压栈设置"), State.Stashed, EPanel::Settings);
		TestEqual(TEXT("开会话后可见会话"), State.Visible, EPanel::Session);
		TestEqual(TEXT("开会话时关闭被压栈设置"), Step.Close, EPanel::Settings);
		TestEqual(TEXT("开会话时打开会话"), Step.Open, EPanel::Session);

		// 会话关闭（选中会话/× 按钮）-> 恢复设置
		State = PetPanelStack::Close(State, EPanel::Session, Step);
		TestEqual(TEXT("关会话恢复设置可见"), State.Visible, EPanel::Settings);
		TestEqual(TEXT("关会话后栈弹空"), State.Stashed, EPanel::None);
		TestEqual(TEXT("关会话时关闭会话"), Step.Close, EPanel::Session);
		TestEqual(TEXT("关会话时恢复设置"), Step.Open, EPanel::Settings);
	}

	// ---- 反复切换保持栈一致（会话 <-> 设置 反复互切）----
	{
		FPetPanelStackState State;
		State = PetPanelStack::Toggle(State, EPanel::Session, Step);
		State = PetPanelStack::Toggle(State, EPanel::Settings, Step);
		State = PetPanelStack::Toggle(State, EPanel::Settings, Step); // 回会话
		TestEqual(TEXT("回合后可见会话"), State.Visible, EPanel::Session);
		TestEqual(TEXT("回合后栈空"), State.Stashed, EPanel::None);
		State = PetPanelStack::Toggle(State, EPanel::Settings, Step); // 又开设置
		TestEqual(TEXT("再开设置可见设置"), State.Visible, EPanel::Settings);
		TestEqual(TEXT("再开设置压栈会话"), State.Stashed, EPanel::Session);
		State = PetPanelStack::Toggle(State, EPanel::Settings, Step); // 又关设置
		TestEqual(TEXT("再关设置可见会话"), State.Visible, EPanel::Session);
		TestEqual(TEXT("再关设置栈空"), State.Stashed, EPanel::None);
	}

	// ---- 打开已被压栈的面板：当前可见面板重新压栈，原栈位被新面板占用 ----
	{
		FPetPanelStackState State;
		State = PetPanelStack::Toggle(State, EPanel::Session, Step);
		State = PetPanelStack::Toggle(State, EPanel::Settings, Step);  // stash=Session
		State = PetPanelStack::Toggle(State, EPanel::Session, Step);   // 打开已压栈的 Session
		TestEqual(TEXT("打开已压栈会话后可见会话"), State.Visible, EPanel::Session);
		TestEqual(TEXT("打开已压栈会话后原当前设置压栈"), State.Stashed, EPanel::Settings);
		TestEqual(TEXT("打开已压栈会话时关闭设置"), Step.Close, EPanel::Settings);
		TestEqual(TEXT("打开已压栈会话时打开会话"), Step.Open, EPanel::Session);
	}

	// ---- Close 非当前可见面板为无操作（不会误关）----
	{
		FPetPanelStackState State;
		State = PetPanelStack::Toggle(State, EPanel::Settings, Step);
		State = PetPanelStack::Close(State, EPanel::Session, Step); // 会话未可见
		TestEqual(TEXT("关闭不可见面板保持设置可见"), State.Visible, EPanel::Settings);
		TestEqual(TEXT("关闭不可见面板不压栈"), State.Stashed, EPanel::None);
		TestEqual(TEXT("关闭不可见面板无关闭动作"), Step.Close, EPanel::None);
		TestEqual(TEXT("关闭不可见面板无打开动作"), Step.Open, EPanel::None);
	}

	// ---- 销毁时 Reset 清空（需求 5）----
	{
		FPetPanelStackState State;
		State = PetPanelStack::Toggle(State, EPanel::Session, Step);
		State = PetPanelStack::Toggle(State, EPanel::Settings, Step); // 有压栈
		State = PetPanelStack::Reset();
		TestEqual(TEXT("Reset 后无可见面板"), State.Visible, EPanel::None);
		TestEqual(TEXT("Reset 后栈空"), State.Stashed, EPanel::None);
	}

	return true;
}

#endif
