#if WITH_AUTOMATION_TESTS

#include "Misc/AutomationTest.h"
#include "Platform/PetWindowDpi.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetWindowDpiSizeTest,
	"Pet.Platform.DPI.WindowSize",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetWindowDpiSizeTest::RunTest(const FString& Parameters)
{
	constexpr int32 LogicalSize = 320;
	TestEqual(TEXT("100% DPI 保持 320 物理像素"), PetWindowDpi::LogicalToPhysicalSize(LogicalSize, 1.0f), 320);
	TestEqual(TEXT("125% DPI 换算为 400 物理像素"), PetWindowDpi::LogicalToPhysicalSize(LogicalSize, 1.25f), 400);
	TestEqual(TEXT("150% DPI 换算为 480 物理像素"), PetWindowDpi::LogicalToPhysicalSize(LogicalSize, 1.5f), 480);
	TestEqual(TEXT("200% DPI 换算为 640 物理像素"), PetWindowDpi::LogicalToPhysicalSize(LogicalSize, 2.0f), 640);
	TestEqual(TEXT("无效 DPI 回退到 100%"), PetWindowDpi::LogicalToPhysicalSize(LogicalSize, 0.0f), 320);
	TestTrue(TEXT("非法逻辑尺寸仍生成正尺寸"), PetWindowDpi::LogicalToPhysicalSize(0, 1.5f) > 0);
	return true;
}

#endif
