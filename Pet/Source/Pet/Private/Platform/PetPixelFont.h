#pragma once

#include "CoreMinimal.h"

/**
 * FPS 叠加层用内置像素字体。
 *
 * 需求背景：FPS 叠加层画在 PetLayeredWindow 的 32bpp 预乘 BGRA DIB 上，GDI
 * DrawText 会把目标像素 alpha 清零导致文本不可见，因此改用逐像素写入的内置字体。
 *
 * 字形为 4 宽 × 6 高，覆盖数字 0-9、D/U/I、空格、冒号与连字符，足以渲染
 * "3D:120 UI:30"（WebUI 帧率未知时显示 "--"）。GetGlyphRow 返回第 Row 行的 4 bit
 * 掩码（高位在左）；未收录字符返回空行（当作空格），保证任意文本安全绘制。
 *
 * 纯逻辑、不访问平台 API，供 PetLayeredWindow 与自动化测试共同使用。
 */
namespace PetPixelFont
{
	constexpr int32 GlyphWidth = 4;
	constexpr int32 GlyphHeight = 6;
	/** 字距步长：相邻字形列间距为 1px，取 GlyphWidth + 1。 */
	constexpr int32 AdvanceWidth = GlyphWidth + 1;
	/** FPS 叠加文字的输出规格：仅绘制字形，不绘制任何矩形底板。 */
	constexpr int32 FpsOverlayScale = 2;
	constexpr int32 FpsOverlayMargin = 8;

	/** 是否为已收录字形（空格也视为字形，其行掩码全 0、经 AdvanceWidth 留白）。 */
	inline bool HasGlyph(const TCHAR Ch)
	{
		switch (Ch)
		{
		case TEXT(' '):
		case TEXT('0'):
		case TEXT('1'):
		case TEXT('2'):
		case TEXT('3'):
		case TEXT('4'):
		case TEXT('5'):
		case TEXT('6'):
		case TEXT('7'):
		case TEXT('8'):
		case TEXT('9'):
		case TEXT('D'):
		case TEXT('U'):
		case TEXT('I'):
		case TEXT(':'):
		case TEXT('-'):
			return true;
		default:
			return false;
		}
	}

	/** 取某字符第 Row 行的位掩码（4 bit，高位在左）；未收录字符返回 0。 */
	inline uint8 GetGlyphRow(TCHAR Ch, int32 Row)
	{
		if (Row < 0 || Row >= GlyphHeight)
		{
			return 0;
		}
		static constexpr uint8 Rows[][GlyphHeight] = {
			/* '0' */ { 0x6, 0x9, 0x9, 0x9, 0x9, 0x6 },
			/* '1' */ { 0x2, 0x6, 0x2, 0x2, 0x2, 0x7 },
			/* '2' */ { 0x6, 0x9, 0x1, 0x2, 0x4, 0xF },
			/* '3' */ { 0xE, 0x1, 0x6, 0x1, 0x1, 0xE },
			/* '4' */ { 0x9, 0x9, 0xF, 0x1, 0x1, 0x1 },
			/* '5' */ { 0xF, 0x8, 0xE, 0x1, 0x9, 0x6 },
			/* '6' */ { 0x6, 0x8, 0xE, 0x9, 0x9, 0x6 },
			/* '7' */ { 0xF, 0x1, 0x2, 0x4, 0x4, 0x4 },
			/* '8' */ { 0x6, 0x9, 0x6, 0x9, 0x9, 0x6 },
			/* '9' */ { 0x6, 0x9, 0x9, 0x7, 0x1, 0x6 },
			/* 'D' */ { 0xE, 0x9, 0x9, 0x9, 0x9, 0xE },
			/* 'U' */ { 0x9, 0x9, 0x9, 0x9, 0x9, 0x6 },
			/* 'I' */ { 0x7, 0x2, 0x2, 0x2, 0x2, 0x7 },
			/* ':' */ { 0x0, 0x6, 0x6, 0x0, 0x6, 0x6 },
			/* '-' */ { 0x0, 0x0, 0x0, 0xF, 0x0, 0x0 },
		};
		static constexpr TCHAR Keys[] = {
			TEXT('0'), TEXT('1'), TEXT('2'), TEXT('3'), TEXT('4'), TEXT('5'),
			TEXT('6'), TEXT('7'), TEXT('8'), TEXT('9'), TEXT('D'), TEXT('U'),
			TEXT('I'), TEXT(':'), TEXT('-'),
		};
		for (int32 i = 0; i < UE_ARRAY_COUNT(Keys); ++i)
		{
			if (Keys[i] == Ch)
			{
				return Rows[i][Row];
			}
		}
		return 0;
	}

	/**
	 * 把 FPS 文本直接写入预乘 BGRA DIB 的右上角。
	 * 仅覆盖命中字形的像素；其余像素完全不动，因而叠加层没有深色底板。
	 */
	inline void DrawFpsOverlayTextToBgra(uint8* Bgra, int32 Width, int32 Height, const FString& Text)
	{
		if (!Bgra || Width <= 0 || Height <= 0 || Text.IsEmpty())
		{
			return;
		}

		const int32 TextWidth = FMath::Max(Text.Len(), 1) * AdvanceWidth - 1;
		const int32 BaseX = Width - FpsOverlayMargin - TextWidth * FpsOverlayScale;
		const int32 BaseY = FpsOverlayMargin;

		for (int32 CharIndex = 0; CharIndex < Text.Len(); ++CharIndex)
		{
			const TCHAR Ch = Text[CharIndex];
			for (int32 Row = 0; Row < GlyphHeight; ++Row)
			{
				const uint8 Mask = GetGlyphRow(Ch, Row);
				for (int32 Col = 0; Col < GlyphWidth; ++Col)
				{
					if ((Mask & (1u << (GlyphWidth - 1 - Col))) == 0)
					{
						continue;
					}

					const int32 GlyphX = BaseX + (CharIndex * AdvanceWidth + Col) * FpsOverlayScale;
					const int32 GlyphY = BaseY + Row * FpsOverlayScale;
					for (int32 Dy = 0; Dy < FpsOverlayScale; ++Dy)
					{
						for (int32 Dx = 0; Dx < FpsOverlayScale; ++Dx)
						{
							const int32 X = GlyphX + Dx;
							const int32 Y = GlyphY + Dy;
							if (X < 0 || X >= Width || Y < 0 || Y >= Height)
							{
								continue;
							}

							uint8* Pixel = Bgra + (Y * Width + X) * 4;
							// 绿字为不透明像素，RGB 无需额外预乘；亮度足以在深浅宠物材质上辨认。
							Pixel[0] = 0;
							Pixel[1] = 255;
							Pixel[2] = 0;
							Pixel[3] = 255;
						}
					}
				}
			}
		}
	}
}
