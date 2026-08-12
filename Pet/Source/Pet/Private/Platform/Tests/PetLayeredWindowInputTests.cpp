#include "Platform/PetLayeredWindowInput.h"
#include "Misc/AutomationTest.h"

#if WITH_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetLayeredWindowInputTest,
	"Pet.Platform.LayeredWindow.CloseGesture",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetLayeredWindowInputTest::RunTest(const FString& Parameters)
{
	using namespace PetLayeredWindowInput;

	TestEqual(
		TEXT("普通短按仍为普通单击"),
		ResolveReleaseAction(true, false, 120, false),
		EPetPointerReleaseAction::Click);
	TestEqual(
		TEXT("按下瞬间带 ESC 的短按触发关闭"),
		ResolveReleaseAction(true, false, 120, true),
		EPetPointerReleaseAction::Close);
	TestEqual(
		TEXT("ESC 手势形成拖拽后只执行拖拽"),
		ResolveReleaseAction(true, true, 120, true),
		EPetPointerReleaseAction::Drag);
	TestEqual(
		TEXT("ESC 长按不关闭"),
		ResolveReleaseAction(true, false, 800, true),
		EPetPointerReleaseAction::None);
	TestEqual(
		TEXT("没有有效按压时不产生动作"),
		ResolveReleaseAction(false, false, 120, true),
		EPetPointerReleaseAction::None);

	return true;
}

#endif
