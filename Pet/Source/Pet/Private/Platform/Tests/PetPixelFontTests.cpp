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

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetPixelFontTransparentFpsOverlayTest,
	"Pet.Platform.PixelFont.TransparentFpsOverlay",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetPixelFontTransparentFpsOverlayTest::RunTest(const FString& Parameters)
{
	constexpr int32 CanvasWidth = 96;
	constexpr int32 CanvasHeight = 40;
	const FString Text = TEXT("3D:12");
	TArray<uint8> Pixels;
	Pixels.Init(0, CanvasWidth * CanvasHeight * 4);

	PetPixelFont::DrawFpsOverlayTextToBgra(Pixels.GetData(), CanvasWidth, CanvasHeight, Text);

	// 以同一字形表推导应写入的位置。若渲染器重新引入矩形底板，非字形像素会立即失败。
	TSet<int32> ExpectedInk;
	const int32 TextWidth = (Text.Len() * PetPixelFont::AdvanceWidth - 1) * PetPixelFont::FpsOverlayScale;
	const int32 BaseX = CanvasWidth - PetPixelFont::FpsOverlayMargin - TextWidth;
	const int32 BaseY = PetPixelFont::FpsOverlayMargin;
	for (int32 CharIndex = 0; CharIndex < Text.Len(); ++CharIndex)
	{
		for (int32 Row = 0; Row < PetPixelFont::GlyphHeight; ++Row)
		{
			const uint8 Mask = PetPixelFont::GetGlyphRow(Text[CharIndex], Row);
			for (int32 Col = 0; Col < PetPixelFont::GlyphWidth; ++Col)
			{
				if ((Mask & (1u << (PetPixelFont::GlyphWidth - 1 - Col))) == 0)
				{
					continue;
				}
				for (int32 Dy = 0; Dy < PetPixelFont::FpsOverlayScale; ++Dy)
				{
					for (int32 Dx = 0; Dx < PetPixelFont::FpsOverlayScale; ++Dx)
					{
						const int32 X = BaseX + (CharIndex * PetPixelFont::AdvanceWidth + Col) * PetPixelFont::FpsOverlayScale + Dx;
						const int32 Y = BaseY + Row * PetPixelFont::FpsOverlayScale + Dy;
						ExpectedInk.Add(Y * CanvasWidth + X);
					}
				}
			}
		}
	}

	int32 ActualInkCount = 0;
	bool bUnexpectedPixelWritten = false;
	bool bGlyphColorInvalid = false;
	for (int32 PixelIndex = 0; PixelIndex < CanvasWidth * CanvasHeight; ++PixelIndex)
	{
		const uint8* Pixel = Pixels.GetData() + PixelIndex * 4;
		const bool bWritten = Pixel[0] != 0 || Pixel[1] != 0 || Pixel[2] != 0 || Pixel[3] != 0;
		if (!bWritten)
		{
			continue;
		}

		++ActualInkCount;
		if (!ExpectedInk.Contains(PixelIndex))
		{
			bUnexpectedPixelWritten = true;
			continue;
		}
		if (Pixel[0] != 0 || Pixel[1] != 255 || Pixel[2] != 0 || Pixel[3] != 255)
		{
			bGlyphColorInvalid = true;
		}
	}

	TestEqual(TEXT("只写入字形像素数量"), ActualInkCount, ExpectedInk.Num());
	TestFalse(TEXT("非字形像素保持透明且没有底板"), bUnexpectedPixelWritten);
	TestFalse(TEXT("字形像素保持不透明绿字"), bGlyphColorInvalid);
	return true;
}

#endif
