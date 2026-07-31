#pragma once

#include "CoreMinimal.h"

#include "Windows/AllowWindowsPlatformTypes.h"
#include <Windows.h>
#include "Windows/HideWindowsPlatformTypes.h"

/**
 * 自建分层窗口：方案一的唯一上屏窗口。
 * - WS_EX_LAYERED + UpdateLayeredWindow：逐像素透明，透明像素自动鼠标穿透（Windows 文档化行为）
 * - WS_EX_TOPMOST / WS_EX_TOOLWINDOW / WS_EX_NOACTIVATE：置顶、不占任务栏、不抢焦点
 * - 左键按住超系统拖拽阈值后拖动窗口（spike 只验证拖拽，单击/手势消解不在此验证）
 */
class FLayeredPetWindow
{
public:
	FLayeredPetWindow() = default;
	~FLayeredPetWindow() { Destroy(); }

	bool Create(int32 InSize, int32 PosX, int32 PosY);
	void Destroy();

	/** 传入 BGRA8 直线（非预乘）像素，内部转预乘后上屏。Src 至少 Size*Size*4 字节，紧密排列。 */
	void Present(const uint8* SrcBGRA);

private:
	static LRESULT CALLBACK StaticWndProc(HWND Hwnd, UINT Msg, WPARAM WParam, LPARAM LParam);
	LRESULT HandleMessage(UINT Msg, WPARAM WParam, LPARAM LParam);
	void UpdateOnScreen();

	HWND WindowHandle = nullptr;
	HDC MemDC = nullptr;
	HBITMAP DibSection = nullptr;
	void* DibBits = nullptr; // 32bpp top-down，预乘 BGRA
	int32 Size = 0;
	POINT Pos{ 0, 0 };

	bool bDragging = false;
	bool bDragThresholdMet = false;
	POINT DragAnchorCursor{ 0, 0 }; // 按下时的屏幕光标位置
	POINT DragGrabOffset{ 0, 0 };   // 按下点相对窗口左上角的偏移

	int32 FrameCounter = 0;
};
