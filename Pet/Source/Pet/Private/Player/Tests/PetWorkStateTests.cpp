#include "Player/PetWorkState.h"
#include "Misc/AutomationTest.h"

#if WITH_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetWorkStateProtocolTest,
	"Pet.Player.WorkState.ProtocolAndDeduplication",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetWorkStateProtocolTest::RunTest(const FString& Parameters)
{
	EPetWorkState State = EPetWorkState::Idle;

	TestEqual(
		TEXT("初始 Idle 快照不产生重复切换"),
		PetWorkStateLogic::ApplyProtocolValue(TEXT("Idle"), State),
		EPetWorkStateApplyResult::Unchanged);
	TestEqual(
		TEXT("Working 产生真实切换"),
		PetWorkStateLogic::ApplyProtocolValue(TEXT("Working"), State),
		EPetWorkStateApplyResult::Changed);
	TestEqual(TEXT("状态更新为 Working"), State, EPetWorkState::Working);
	TestEqual(
		TEXT("重连重复 Working 不产生切换"),
		PetWorkStateLogic::ApplyProtocolValue(TEXT("Working"), State),
		EPetWorkStateApplyResult::Unchanged);
	TestEqual(
		TEXT("Idle 产生真实切换"),
		PetWorkStateLogic::ApplyProtocolValue(TEXT("Idle"), State),
		EPetWorkStateApplyResult::Changed);
	TestEqual(TEXT("状态更新为 Idle"), State, EPetWorkState::Idle);
	TestEqual(
		TEXT("非法协议值被拒绝"),
		PetWorkStateLogic::ApplyProtocolValue(TEXT("Busy"), State),
		EPetWorkStateApplyResult::Invalid);
	TestEqual(TEXT("非法值不改变当前状态"), State, EPetWorkState::Idle);

	return true;
}

#endif
