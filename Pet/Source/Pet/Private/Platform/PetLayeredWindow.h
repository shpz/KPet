#pragma once

#include "CoreMinimal.h"

#include "Windows/AllowWindowsPlatformTypes.h"
#include <Windows.h>
#include "Windows/HideWindowsPlatformTypes.h"

/**
 * 自建分层窗口：方案一的唯一上屏窗口。
 * - WS_EX_LAYERED + UpdateLayeredWindow：逐像素透明，透明像素自动鼠标穿透（Windows 文档化行为）
 * - WS_EX_TOPMOST / WS_EX_TOOLWINDOW / WS_EX_NOACTIVATE：置顶、不占任务栏、不抢焦点
 * - 左键手势消解：按下记录时间戳，位移超系统拖拽阈值 → 拖拽（松手回调 OnDragEnd）；
 *   松开时未超阈值且按下时长 < 800ms → 单击（回调 OnClick）；按下时 ESC 已按住的有效单击
 *   优先回调 OnCloseRequested，不再触发普通单击
 */
class PetLayeredWindow
{
public:
	PetLayeredWindow() = default;
	~PetLayeredWindow() { Destroy(); }

	bool Create(int32 InSize, int32 PosX, int32 PosY);
	/** DPI 改变后重建同尺寸 DIB，并保持拖拽锚点不跳变。 */
	bool Resize(int32 InSize);
	void Destroy();

	/** 窗口左上角在 Windows 虚拟桌面中的屏幕像素坐标；副屏位于主屏左侧或上方时可能为负数。 */
	FIntPoint GetScreenPosition() const { return FIntPoint(Pos.x, Pos.y); }
	/** 当前窗口与 DIB 的物理像素边长。 */
	int32 GetPixelSize() const { return Size; }

	/** 传入 scene capture 的 BGRA8 像素（RGB 已预乘、alpha 为反向不透明度）。内部取反 alpha，
	 *  并把 A=0 像素的 RGB 清零（恢复预乘契约，防 ULW 加性虚影）后上屏。
	 *  SourceSize 必须等于当前物理边长，SourceRowPitchPixels 允许包含 RHI 行填充。 */
	void Present(const uint8* SrcBGRA, int32 SourceSize, int32 SourceRowPitchPixels);

	/** 驱动宠物窗口的摄像机输入状态与光标清理。 */
	void Tick(float DeltaTime);

	/** 用 BGRA8 图片替换 R 键摄像机光标，热点取图片中心；传空指针回退为内置绘制光标。 */
	void SetCameraCursorImage(const uint8* BgraPixels, int32 Width, int32 Height);

	/** 单击宠物（消息处理线程 = 游戏线程，直接调用）。 */
	TFunction<void()> OnClick;

	/** 按住 ESC 开始的有效单击，请求关闭宠物；优先于 OnClick。 */
	TFunction<void()> OnCloseRequested;

	/** 光标停在宠物不透明像素上时按下 Ctrl+, 触发（WH_KEYBOARD_LL 观察，不拦截按键），
	 *  用于切换设置面板。与 ESC/R 同一语义：只在「人正指着宠物」时响应，非全局热键。 */
	TFunction<void()> OnHotKey;

	/** 拖拽结束（参数为窗口左上角屏幕坐标）。 */
	TFunction<void(int32 X, int32 Y)> OnDragEnd;

	/** R 加左键拖动产生的摄像机轨道增量，单位为屏幕像素。 */
	TFunction<void(float DeltaX, float DeltaY)> OnCameraRotate;

	/** R 加滚轮产生的缩放增量，正数表示滚轮向上。 */
	TFunction<void(float WheelDelta)> OnCameraZoom;

	/** 收到每显示器 DPI 变化时回调新的 DPI 缩放；Pawn 据此同步重建 RT 与本窗口。 */
	TFunction<void(float DpiScale)> OnDpiScaleChanged;

	/** 开关 FPS 叠加层；开启后在 Present 上屏路径画到 DIB 右上角。 */
	void SetFpsOverlayEnabled(bool bEnabled);

	/** 更新叠加层数值；WebFps 传 -1 表示未知（显示 "--"，如页面未上报）。 */
	void SetFpsValues(int32 WorldFps, int32 WebFps);

private:
	static LRESULT CALLBACK StaticWndProc(HWND Hwnd, UINT Msg, WPARAM WParam, LPARAM LParam);
	static LRESULT CALLBACK StaticLowLevelMouseProc(int32 Code, WPARAM WParam, LPARAM LParam);
	static LRESULT CALLBACK StaticLowLevelKeyboardProc(int32 Code, WPARAM WParam, LPARAM LParam);
	LRESULT HandleMessage(UINT Msg, WPARAM WParam, LPARAM LParam);
	void UpdateOnScreen();
	void DrawFpsOverlay();
	HCURSOR CreateCameraCursor();
	void HandleCameraWheel(float WheelDelta);
	bool IsOpaqueScreenPoint(const POINT& ScreenPoint) const;
	bool ReplaceDibSurface(int32 InSize);

	HWND WindowHandle = nullptr;
	HDC MemDC = nullptr;
	HBITMAP DibSection = nullptr;
	void* DibBits = nullptr; // 32bpp top-down，预乘 BGRA
	int32 Size = 0;
	POINT Pos{ 0, 0 };
	POINT SuggestedDpiPosition{ 0, 0 };
	bool bHasSuggestedDpiPosition = false;

	bool bDragging = false;
	bool bDragThresholdMet = false;
	bool bCloseGestureArmed = false; // 左键按下瞬间 ESC 已按住；只在本次有效单击中触发关闭
	POINT DragAnchorCursor{ 0, 0 }; // 按下时的屏幕光标位置
	POINT DragGrabOffset{ 0, 0 };   // 按下点相对窗口左上角的偏移
	uint64 PressTick = 0;           // 左键按下时刻（单调毫秒时间戳，单击时长判定）
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
	HHOOK KeyboardHook = nullptr;
	static PetLayeredWindow* KeyboardHookOwner;
	bool bSettingsChordDown = false; // Ctrl+, 按住期间只触发一次，键松开才复位

	// ---- FPS 叠加层（值变化时重建文本，Present 时逐像素画入 DIB） ----
	bool bFpsOverlayEnabled = false;
	int32 WorldFps = 0;
	int32 WebFps = -1;
	FString FpsOverlayText; // 拼好的 "3D:120 UI:30" 文本，避免每帧重建

	int32 FrameCounter = 0;
};
