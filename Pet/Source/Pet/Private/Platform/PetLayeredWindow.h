#pragma once

#include "CoreMinimal.h"

#include "Windows/AllowWindowsPlatformTypes.h"
#include <Windows.h>
#include "Windows/HideWindowsPlatformTypes.h"

/**
 * 自建分层窗口：方案一的唯一上屏窗口。
 * - WS_EX_LAYERED + UpdateLayeredWindow：逐像素透明，透明像素自动鼠标穿透（Windows 文档化行为）
 * - WS_EX_TOPMOST / WS_EX_TOOLWINDOW / WS_EX_NOACTIVATE：置顶、不占任务栏、不抢焦点
 * - 左键手势消解（§6.4/§6.5）：按下记录时间戳，位移超系统拖拽阈值 → 拖拽（松手回调 OnDragEnd）；
 *   松开时未超阈值且按下时长 < 800ms → 单击（回调 OnClick）
 */
class PetLayeredWindow
{
public:
	PetLayeredWindow() = default;
	~PetLayeredWindow() { Destroy(); }

	bool Create(int32 InSize, int32 PosX, int32 PosY);
	void Destroy();

	/** 窗口左上角在 Windows 虚拟桌面中的屏幕像素坐标；副屏位于主屏左侧或上方时可能为负数。 */
	FIntPoint GetScreenPosition() const { return FIntPoint(Pos.x, Pos.y); }

	/** 传入 scene capture 的 BGRA8 像素（RGB 已预乘、alpha 为反向不透明度）。内部取反 alpha，
	 *  并把 A=0 像素的 RGB 清零（恢复预乘契约，防 ULW 加性虚影）后上屏。Src 至少 Size*Size*4 字节，紧密排列。 */
	void Present(const uint8* SrcBGRA);

	/** 单击宠物（§6.5，消息处理线程 = 游戏线程，直接调用）。 */
	TFunction<void()> OnClick;

	/** 拖拽结束（§6.4，参数为窗口左上角屏幕坐标）。 */
	TFunction<void(int32 X, int32 Y)> OnDragEnd;

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
	uint64 PressTick = 0;           // 左键按下时刻（GetTickCount64，§6.5 单击时长判定）

	int32 FrameCounter = 0;
};
