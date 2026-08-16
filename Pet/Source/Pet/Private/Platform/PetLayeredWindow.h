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
 *   松开时未超阈值且按下时长 < 800ms → 单击（回调 OnClick）；按下时 ESC 已按住的有效单击
 *   优先回调 OnCloseRequested，不再触发普通单击
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

	/** 驱动宠物窗口的摄像机输入状态与光标清理。 */
	void Tick(float DeltaTime);

	/** 用 BGRA8 图片替换 R 键摄像机光标，热点取图片中心；传空指针回退为内置绘制光标。 */
	void SetCameraCursorImage(const uint8* BgraPixels, int32 Width, int32 Height);

	/** 单击宠物（§6.5，消息处理线程 = 游戏线程，直接调用）。 */
	TFunction<void()> OnClick;

	/** 按住 ESC 开始的有效单击，请求关闭宠物；优先于 OnClick。 */
	TFunction<void()> OnCloseRequested;

	/** 拖拽结束（§6.4，参数为窗口左上角屏幕坐标）。 */
	TFunction<void(int32 X, int32 Y)> OnDragEnd;

	/** R 加左键拖动产生的摄像机轨道增量，单位为屏幕像素。 */
	TFunction<void(float DeltaX, float DeltaY)> OnCameraRotate;

	/** R 加滚轮产生的缩放增量，正数表示滚轮向上。 */
	TFunction<void(float WheelDelta)> OnCameraZoom;

private:
	static LRESULT CALLBACK StaticWndProc(HWND Hwnd, UINT Msg, WPARAM WParam, LPARAM LParam);
	static LRESULT CALLBACK StaticLowLevelMouseProc(int32 Code, WPARAM WParam, LPARAM LParam);
	LRESULT HandleMessage(UINT Msg, WPARAM WParam, LPARAM LParam);
	void UpdateOnScreen();
	HCURSOR CreateCameraCursor();
	void HandleCameraWheel(float WheelDelta);
	bool IsOpaqueScreenPoint(const POINT& ScreenPoint) const;

	HWND WindowHandle = nullptr;
	HDC MemDC = nullptr;
	HBITMAP DibSection = nullptr;
	void* DibBits = nullptr; // 32bpp top-down，预乘 BGRA
	int32 Size = 0;
	POINT Pos{ 0, 0 };

	bool bDragging = false;
	bool bDragThresholdMet = false;
	bool bCloseGestureArmed = false; // 左键按下瞬间 ESC 已按住；只在本次有效单击中触发关闭
	POINT DragAnchorCursor{ 0, 0 }; // 按下时的屏幕光标位置
	POINT DragGrabOffset{ 0, 0 };   // 按下点相对窗口左上角的偏移
	uint64 PressTick = 0;           // 左键按下时刻（GetTickCount64，§6.5 单击时长判定）
	bool bCameraAdjusting = false;
	bool bSuppressClickUntilButtonUp = false;
	bool bWheelCameraCursorActive = false;
	POINT LastCameraCursor{ 0, 0 };
	HCURSOR CameraCursor = nullptr;
	TArray<uint8> CameraCursorImage; // 自定义光标的 BGRA8 源图，空则使用内置绘制样式
	int32 CameraCursorImageWidth = 0;
	int32 CameraCursorImageHeight = 0;
	HHOOK MouseHook = nullptr;
	uint64 WheelCameraCursorExpireTick = 0;
	static PetLayeredWindow* MouseHookOwner;

	int32 FrameCounter = 0;
};
