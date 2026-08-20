#include "Platform/PetPixelFont.h"
#include "Misc/AutomationTest.h"

#if WITH_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetPixelFontGlyphTableTest,
	"Pet.Platform.PixelFont.GlyphTable",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetPixelFontGlyphTableTest::RunTest(const FString& Parameters)
{
	// FPS 叠加层内容形如 "3D:120 UI:30"，覆盖数字 0-9、D/U/I、空格、冒号/连字符。
	const FString Required = TEXT("0123456789DUI: -");
	const FString NonBlankGlyphs = TEXT("0123456789DUI:-"); // 空格为分立校验
	for (TCHAR Ch : Required)
	{
		TestTrue(FString::Printf(TEXT("字形覆盖字符 %c"), Ch), PetPixelFont::HasGlyph(Ch));
	}

	// 每个非空格字形必须有确定的行数（GlyphHeight），且至少占一像素，避免空字形。
	for (TCHAR Ch : NonBlankGlyphs)
	{
		int32 PopCount = 0;
		for (int32 Row = 0; Row < PetPixelFont::GlyphHeight; ++Row)
		{
			PopCount += FMath::CountBits(static_cast<uint32>(PetPixelFont::GetGlyphRow(Ch, Row)));
		}
		TestTrue(FString::Printf(TEXT("字符 %c 至少有一个像素"), Ch), PopCount > 0);
	}

	// 空格作为字形存在，但全行掩码为 0（仅占字距留白）。
	for (int32 Row = 0; Row < PetPixelFont::GlyphHeight; ++Row)
	{
		TestEqual(TEXT("空格全部行掩码为 0"), PetPixelFont::GetGlyphRow(TEXT(' '), Row), 0);
	}

	// 未知字符按空格处理（空行），调用方无需前置判断即可安全绘制任意文本。
	for (int32 Row = 0; Row < PetPixelFont::GlyphHeight; ++Row)
	{
		TestEqual(TEXT("未收录字符绘制为空格"), PetPixelFont::GetGlyphRow(TEXT('~'), Row), 0);
		TestFalse(TEXT("未收录字符不是字形"), PetPixelFont::HasGlyph(TEXT('~')));
		TestEqual(TEXT("越界行返回 0"), PetPixelFont::GetGlyphRow(TEXT('8'), Row + PetPixelFont::GlyphHeight), 0);
	}

	return true;
}

#endif
