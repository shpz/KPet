#include "Platform/PetLayeredWindow.h"
#include "Platform/PetLayeredWindowInput.h"
#include "Platform/PetPixelFont.h"
#include "Pet.h"

static const TCHAR* PetWindowClassName = TEXT("KPetLayeredWindow");
static constexpr UINT PetCameraWheelMessage = WM_APP + 51;
static constexpr UINT PetCameraRotateMessage = WM_APP + 52;
PetLayeredWindow* PetLayeredWindow::MouseHookOwner = nullptr;
PetLayeredWindow* PetLayeredWindow::KeyboardHookOwner = nullptr;

namespace
{
	/** 单调毫秒时间戳（替代 GetTickCount64；FPlatformTime 同为系统单调时钟，语义一致）。 */
	uint64 NowMilliseconds()
	{
		return static_cast<uint64>(FPlatformTime::ToMilliseconds64(FPlatformTime::Cycles64()));
	}
}

bool PetLayeredWindow::Create(int32 InSize, int32 PosX, int32 PosY)
{
	Size = InSize;
	Pos.x = PosX;
	Pos.y = PosY;

	HINSTANCE Instance = GetModuleHandle(nullptr);

	WNDCLASSEX Wc = {};
	Wc.cbSize = sizeof(Wc);
	Wc.lpfnWndProc = &PetLayeredWindow::StaticWndProc;
	Wc.hInstance = Instance;
	Wc.lpszClassName = PetWindowClassName;
	Wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
	if (!RegisterClassEx(&Wc))
	{
		DWORD Err = GetLastError();
		if (Err != ERROR_CLASS_ALREADY_EXISTS)
		{
			UE_LOG(LogPet, Error, TEXT("RegisterClassEx failed: %u"), Err);
			return false;
		}
	}

	const DWORD ExStyle = WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
	WindowHandle = CreateWindowEx(ExStyle, PetWindowClassName, TEXT("KPet"),
		WS_POPUP, Pos.x, Pos.y, Size, Size, nullptr, nullptr, Instance, this);
	if (!WindowHandle)
	{
		UE_LOG(LogPet, Error, TEXT("CreateWindowEx failed: %u"), GetLastError());
		return false;
	}

	// 32bpp 顶向下 DIB，UpdateLayeredWindow 要求预乘 alpha
	BITMAPINFO Bmi = {};
	Bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
	Bmi.bmiHeader.biWidth = Size;
	Bmi.bmiHeader.biHeight = -Size;
	Bmi.bmiHeader.biPlanes = 1;
	Bmi.bmiHeader.biBitCount = 32;
	Bmi.bmiHeader.biCompression = BI_RGB;

	HDC ScreenDC = GetDC(nullptr);
	DibSection = CreateDIBSection(ScreenDC, &Bmi, DIB_RGB_COLORS, &DibBits, nullptr, 0);
	MemDC = CreateCompatibleDC(ScreenDC);
	ReleaseDC(nullptr, ScreenDC);
	if (!DibSection || !MemDC)
	{
		UE_LOG(LogPet, Error, TEXT("CreateDIBSection/CreateCompatibleDC failed"));
		Destroy();
		return false;
	}
	SelectObject(MemDC, DibSection);
	FMemory::Memzero(DibBits, Size * Size * 4);

	ShowWindow(WindowHandle, SW_SHOWNOACTIVATE);
	// 立即上一帧全透明画面（DibBits 已清零）：否则首个有效 capture 帧上屏之前，
	// 窗口从未调用过 UpdateLayeredWindow，DWM 会把它显示为纯黑方块
	UpdateOnScreen();
	CameraCursor = CreateCameraCursor();
	MouseHookOwner = this;
	HMODULE HookModule = GetModuleHandle(TEXT("UnrealEditor-Pet.dll"));
	if (!HookModule)
	{
		HookModule = GetModuleHandle(nullptr);
	}
	MouseHook = SetWindowsHookEx(WH_MOUSE_LL, &PetLayeredWindow::StaticLowLevelMouseProc, HookModule, 0);
	if (!MouseHook)
	{
		UE_LOG(LogPet, Warning, TEXT("安装摄像机滚轮监听失败: %u，将回退为窗口滚轮消息"), GetLastError());
	}
	// Ctrl+, 设置面板快捷键：与 ESC/R 同款语义——低层键盘钩子只观察不拦截，
	// 仅当光标停在宠物不透明像素上时才触发（窗口是 WS_EX_NOACTIVATE，永远拿不到
	// 键盘焦点，无法用常规按键消息，也不用全局 RegisterHotKey 抢其它程序的按键）。
	KeyboardHookOwner = this;
	KeyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, &PetLayeredWindow::StaticLowLevelKeyboardProc, HookModule, 0);
	if (!KeyboardHook)
	{
		UE_LOG(LogPet, Warning, TEXT("安装 Ctrl+, 键盘监听失败: %u，设置面板快捷键不可用"), GetLastError());
	}
	UE_LOG(LogPet, Log, TEXT("Layered window created: %dx%d at (%d,%d)"), Size, Size, Pos.x, Pos.y);
	return true;
}

void PetLayeredWindow::Destroy()
{
	if (MouseHook)
	{
		UnhookWindowsHookEx(MouseHook);
		MouseHook = nullptr;
	}
	if (MouseHookOwner == this)
	{
		MouseHookOwner = nullptr;
	}
	if (KeyboardHook)
	{
		UnhookWindowsHookEx(KeyboardHook);
		KeyboardHook = nullptr;
	}
	if (KeyboardHookOwner == this)
	{
		KeyboardHookOwner = nullptr;
	}
	if (GetCapture() == WindowHandle)
	{
		ReleaseCapture();
	}
	::SetCursor(LoadCursor(nullptr, IDC_ARROW));
	if (CameraCursor)
	{
		DestroyCursor(CameraCursor);
		CameraCursor = nullptr;
	}
	if (WindowHandle)
	{
		DestroyWindow(WindowHandle);
		WindowHandle = nullptr;
	}
	if (MemDC) { DeleteDC(MemDC); MemDC = nullptr; }
	if (DibSection) { DeleteObject(DibSection); DibSection = nullptr; DibBits = nullptr; }
}

void PetLayeredWindow::Tick(float)
{
	if (bCameraAdjusting && (GetAsyncKeyState('R') & 0x8000) == 0)
	{
		bSuppressClickUntilButtonUp = true;
		bCameraAdjusting = false;
		ReleaseCapture();
		::SetCursor(LoadCursor(nullptr, IDC_ARROW));
	}
	if (bWheelCameraCursorActive &&
		((GetAsyncKeyState('R') & 0x8000) == 0 || NowMilliseconds() >= WheelCameraCursorExpireTick))
	{
		bWheelCameraCursorActive = false;
		::SetCursor(LoadCursor(nullptr, IDC_ARROW));
	}
}

void PetLayeredWindow::SetFpsOverlayEnabled(bool bEnabled)
{
	if (bFpsOverlayEnabled == bEnabled)
	{
		return;
	}
	bFpsOverlayEnabled = bEnabled;
	// 值不变也强制重拼文本，保证开关切换后绘制文本与最新值一致。
	SetFpsValues(WorldFps, WebFps);
}

void PetLayeredWindow::SetFpsValues(int32 InWorldFps, int32 InWebFps)
{
	WorldFps = InWorldFps;
	WebFps = InWebFps;
	// WebFps<0 表示无上报（未知态），显示 "--"。
	FString Text = FString::Printf(
		TEXT("3D:%d UI:%s"),
		WorldFps,
		WebFps >= 0 ? *FString::FromInt(WebFps) : TEXT("--"));
	if (Text != FpsOverlayText)
	{
		FpsOverlayText = MoveTemp(Text);
	}
}

void PetLayeredWindow::DrawFpsOverlay()
{
	if (!DibBits || FpsOverlayText.IsEmpty())
	{
		return;
	}

	// 仅写入不透明绿字，不再铺设深色矩形底板，避免遮住宠物和与浅色主题冲突。
	PetPixelFont::DrawFpsOverlayTextToBgra(
		static_cast<uint8*>(DibBits),
		Size,
		Size,
		FpsOverlayText);
}

void PetLayeredWindow::Present(const uint8* SrcBGRA)
{
	if (!WindowHandle || !DibBits)
	{
		return;
	}

	const int32 NumPixels = Size * Size;
	++FrameCounter;

	// RT 像素语义（UE 源码取证：scene color alpha = 1-不透明度，RGB 已按不透明度预乘）：
	// - alpha 取反得到真实不透明度；RGB 已是预乘，直接拷贝，不再二次预乘。
	// - 但 A=0（全透明）像素的 RGB 并不保证为 0：tonemapper 无条件叠加量化抖动
	//   （PostProcessTonemap.usf，8bit 输出幅度 ±1/255），bloom 也会把辉光加进背景。
	//   UpdateLayeredWindow 是预乘语义：A=0 时 Dest = Src + Dest，非零 RGB 会被加性
	//   叠到桌面上 -> 背景淡淡虚影。因此 A==0 的像素 RGB 一律清零，恢复预乘契约。
	// 统计基于源像素（清零前），maxRGB(a=0)>0 即为上述污染的客观证据。
	uint8* Dst = static_cast<uint8*>(DibBits);
	int32 AlphaZero = 0, AlphaFull = 0, AlphaMid = 0;
	uint8 MaxRgbAmongTransparent = 0;
	for (int32 i = 0; i < NumPixels; ++i)
	{
		const uint8 B = SrcBGRA[i * 4 + 0];
		const uint8 G = SrcBGRA[i * 4 + 1];
		const uint8 R = SrcBGRA[i * 4 + 2];
		const uint8 A = (uint8)(255 - SrcBGRA[i * 4 + 3]); // 反转 -> 真实不透明度

		if (A == 0)
		{
			++AlphaZero;
			MaxRgbAmongTransparent = FMath::Max3(MaxRgbAmongTransparent, R, FMath::Max(G, B));
			// 全透明像素强制 RGB=0（见上方注释），避免被 ULW 加性混合到桌面
			Dst[i * 4 + 0] = 0;
			Dst[i * 4 + 1] = 0;
			Dst[i * 4 + 2] = 0;
			Dst[i * 4 + 3] = 0;
			continue;
		}

		Dst[i * 4 + 0] = B;
		Dst[i * 4 + 1] = G;
		Dst[i * 4 + 2] = R;
		Dst[i * 4 + 3] = A;

		if (A == 255) { ++AlphaFull; }
		else { ++AlphaMid; }
	}

	if (FrameCounter % 60 == 1)
	{
		UE_LOG(LogPet, Verbose, TEXT("Frame %d alpha stats(fixed): a==0: %d (%.1f%%), a==255: %d, mid: %d, maxRGB(a=0): %d"),
			FrameCounter, AlphaZero, 100.0 * AlphaZero / NumPixels, AlphaFull, AlphaMid, MaxRgbAmongTransparent);
	}

	// FPS 叠加层：值未变化时文本缓存复用，仅在 Present（DIB 已整帧重写）后上屏。
	if (bFpsOverlayEnabled)
	{
		DrawFpsOverlay();
	}

	UpdateOnScreen();
}

void PetLayeredWindow::UpdateOnScreen()
{
	POINT DstPos = Pos;
	SIZE WinSize = { Size, Size };
	POINT SrcPos = { 0, 0 };
	BLENDFUNCTION Blend = {};
	Blend.BlendOp = AC_SRC_OVER;
	Blend.SourceConstantAlpha = 255;
	Blend.AlphaFormat = AC_SRC_ALPHA;

	HDC ScreenDC = GetDC(nullptr);
	UpdateLayeredWindow(WindowHandle, ScreenDC, &DstPos, &WinSize, MemDC, &SrcPos, 0, &Blend, ULW_ALPHA);
	ReleaseDC(nullptr, ScreenDC);
}

LRESULT CALLBACK PetLayeredWindow::StaticWndProc(HWND Hwnd, UINT Msg, WPARAM WParam, LPARAM LParam)
{
	PetLayeredWindow* Self = nullptr;
	if (Msg == WM_NCCREATE)
	{
		CREATESTRUCT* Cs = reinterpret_cast<CREATESTRUCT*>(LParam);
		Self = static_cast<PetLayeredWindow*>(Cs->lpCreateParams);
		SetWindowLongPtr(Hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(Self));
		Self->WindowHandle = Hwnd;
	}
	else
	{
		Self = reinterpret_cast<PetLayeredWindow*>(GetWindowLongPtr(Hwnd, GWLP_USERDATA));
	}

	if (Self)
	{
		return Self->HandleMessage(Msg, WParam, LParam);
	}
	return DefWindowProc(Hwnd, Msg, WParam, LParam);
}

LRESULT PetLayeredWindow::HandleMessage(UINT Msg, WPARAM WParam, LPARAM LParam)
{
	switch (Msg)
	{
	case WM_NCHITTEST:
	{
		POINT ScreenPoint = {
			static_cast<LONG>(static_cast<short>(LOWORD(LParam))),
			static_cast<LONG>(static_cast<short>(HIWORD(LParam)))
		};
		return IsOpaqueScreenPoint(ScreenPoint) ? HTCLIENT : HTTRANSPARENT;
	}
	case WM_LBUTTONDOWN:
	{
		// 只有不透明像素会收到此消息（透明像素系统自动穿透），记录锚点等待超阈值
		// 客户区坐标 == 相对窗口左上（WS_POPUP 无边框）
		const int32 ClientX = static_cast<int32>(static_cast<short>(LOWORD(LParam)));
		const int32 ClientY = static_cast<int32>(static_cast<short>(HIWORD(LParam)));
		bSuppressClickUntilButtonUp = false;
		// 修饰键语义固定在按下瞬间，避免用户先普通按下、再补按 ESC 造成意外关闭。
		// 既有 R 摄像机手势优先；只有不处于摄像机手势时，ESC 才武装关闭单击。
		const bool bCameraModifierDown = (GetAsyncKeyState('R') & 0x8000) != 0;
		bCloseGestureArmed = !bCameraModifierDown && (GetAsyncKeyState(VK_ESCAPE) & 0x8000) != 0;
		if (bCameraModifierDown)
		{
			bCameraAdjusting = true;
			bDragging = false;
			bDragThresholdMet = false;
			PressTick = 0;
			bSuppressClickUntilButtonUp = true;
			SetCapture(WindowHandle);
			GetCursorPos(&LastCameraCursor);
			::SetCursor(CameraCursor ? CameraCursor : LoadCursor(nullptr, IDC_CROSS));
			return 0;
		}
		bDragging = true;
		bDragThresholdMet = false;
		PressTick = NowMilliseconds(); // §6.5-1：按下只记录时间戳与锚点，不做任何动作
		SetCapture(WindowHandle);
		DragAnchorCursor.x = ClientX + Pos.x;
		DragAnchorCursor.y = ClientY + Pos.y;
		DragGrabOffset.x = ClientX;
		DragGrabOffset.y = ClientY;
		return 0;
	}
	case WM_MOUSEMOVE:
	{
		if (bDragging && !bCloseGestureArmed && (GetAsyncKeyState('R') & 0x8000) != 0)
		{
			bDragging = false;
			bCameraAdjusting = true;
			bDragThresholdMet = false;
			PressTick = 0;
			bSuppressClickUntilButtonUp = true;
			GetCursorPos(&LastCameraCursor);
			::SetCursor(CameraCursor ? CameraCursor : LoadCursor(nullptr, IDC_CROSS));
			return 0;
		}
		if (bCameraAdjusting)
		{
			if ((GetAsyncKeyState('R') & 0x8000) == 0)
			{
				bSuppressClickUntilButtonUp = true;
				bCameraAdjusting = false;
				ReleaseCapture();
				::SetCursor(LoadCursor(nullptr, IDC_ARROW));
				return 0;
			}
			POINT Cursor;
			GetCursorPos(&Cursor);
			const int32 DeltaX = Cursor.x - LastCameraCursor.x;
			const int32 DeltaY = Cursor.y - LastCameraCursor.y;
			LastCameraCursor = Cursor;
			if ((DeltaX != 0 || DeltaY != 0) && OnCameraRotate)
			{
				OnCameraRotate(static_cast<float>(DeltaX), static_cast<float>(DeltaY));
			}
			::SetCursor(CameraCursor ? CameraCursor : LoadCursor(nullptr, IDC_CROSS));
			return 0;
		}
		if (bDragging)
		{
			POINT Cursor;
			GetCursorPos(&Cursor);
			if (!bDragThresholdMet)
			{
				const int32 ThresholdX = GetSystemMetrics(SM_CXDRAG);
				const int32 ThresholdY = GetSystemMetrics(SM_CYDRAG);
				if (FMath::Abs(Cursor.x - DragAnchorCursor.x) >= ThresholdX ||
					FMath::Abs(Cursor.y - DragAnchorCursor.y) >= ThresholdY)
				{
					bDragThresholdMet = true;
				}
			}
			if (bDragThresholdMet)
			{
				Pos.x = Cursor.x - DragGrabOffset.x;
				Pos.y = Cursor.y - DragGrabOffset.y;
				// 立即移动（不等下一帧 Present），保证渲染停顿时窗口仍可拖动
				SetWindowPos(WindowHandle, nullptr, Pos.x, Pos.y, 0, 0,
					SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
			}
		}
		return 0;
	}
	case WM_LBUTTONUP:
	{
		if (bCameraAdjusting)
		{
			bCameraAdjusting = false;
			bCloseGestureArmed = false;
			ReleaseCapture();
			bSuppressClickUntilButtonUp = false;
			::SetCursor(LoadCursor(nullptr, IDC_ARROW));
			return 0;
		}
		if (bSuppressClickUntilButtonUp)
		{
			bSuppressClickUntilButtonUp = false;
			bDragging = false;
			bCloseGestureArmed = false;
			if (GetCapture() == WindowHandle)
			{
				ReleaseCapture();
			}
			return 0;
		}
		const uint64 PressDurationMs = bDragging ? NowMilliseconds() - PressTick : MAX_uint64;
		const EPetPointerReleaseAction ReleaseAction = PetLayeredWindowInput::ResolveReleaseAction(
			bDragging,
			bDragThresholdMet,
			PressDurationMs,
			bCloseGestureArmed);
		bCloseGestureArmed = false;
		if (bDragging)
		{
			bDragging = false;
			ReleaseCapture();
			bSuppressClickUntilButtonUp = false;
		}
		// §6.5 单击判定：位移未超阈值（未进入拖拽）且按下时长 < 800ms → 单击；否则拖拽结束上报位置
		if (ReleaseAction == EPetPointerReleaseAction::Close)
		{
			if (OnCloseRequested)
			{
				OnCloseRequested();
			}
		}
		else if (ReleaseAction == EPetPointerReleaseAction::Click)
		{
			if (OnClick)
			{
				OnClick();
			}
		}
		else if (ReleaseAction == EPetPointerReleaseAction::Drag)
		{
			if (OnDragEnd)
			{
				OnDragEnd(Pos.x, Pos.y);
			}
		}
		// 长按（>800ms 无位移）：MVP 不绑定功能，松开不触发点击（§6.5-4）
		return 0;
	}
	case WM_MOUSEWHEEL:
	{
		POINT Cursor = {};
		GetCursorPos(&Cursor);
		if (!MouseHook && (GetAsyncKeyState('R') & 0x8000) != 0 && IsOpaqueScreenPoint(Cursor))
		{
			HandleCameraWheel(static_cast<float>(GET_WHEEL_DELTA_WPARAM(WParam)) / static_cast<float>(WHEEL_DELTA));
			return 0;
		}
		return DefWindowProc(WindowHandle, Msg, WParam, LParam);
	}
	case PetCameraWheelMessage:
	{
		const int16 RawDelta = static_cast<int16>(LOWORD(WParam));
		HandleCameraWheel(static_cast<float>(RawDelta) / static_cast<float>(WHEEL_DELTA));
		return 0;
	}
	case PetCameraRotateMessage:
	{
		// 锁屏后的自动化桌面不会更新 GetAsyncKeyState。与滚轮回归消息相同，
		// 该消息只复用已经存在的摄像机回调，不改变正常 R 加拖动输入路径。
		const int16 DeltaX = static_cast<int16>(LOWORD(WParam));
		const int16 DeltaY = static_cast<int16>(HIWORD(WParam));
		if ((DeltaX != 0 || DeltaY != 0) && OnCameraRotate)
		{
			OnCameraRotate(static_cast<float>(DeltaX), static_cast<float>(DeltaY));
		}
		bWheelCameraCursorActive = true;
		WheelCameraCursorExpireTick = NowMilliseconds() + 250;
		::SetCursor(CameraCursor ? CameraCursor : LoadCursor(nullptr, IDC_CROSS));
		return 0;
	}
	case WM_CANCELMODE:
	case WM_CAPTURECHANGED:
	{
		const bool bWasInteracting = bCameraAdjusting || bDragging;
		bCameraAdjusting = false;
		bDragging = false;
		bCloseGestureArmed = false;
		if (bWasInteracting)
		{
			bSuppressClickUntilButtonUp = true;
		}
		::SetCursor(LoadCursor(nullptr, IDC_ARROW));
		return 0;
	}
	case WM_SETCURSOR:
	{
		// 光标悬停在不透明像素（HTCLIENT）时，钉死为箭头并返回 TRUE 吃掉消息。
		// 否则 DefWindowProc 会把 WM_SETCURSOR 沿父链转发给 UE/Slate 的窗口，
		// Slate 按自己的悬停状态反复 SetCursor 成别的光标，与本类光标来回打架 -> 肉眼闪烁。
		if (LOWORD(LParam) == HTCLIENT)
		{
			const bool bCameraCursor = bCameraAdjusting || bWheelCameraCursorActive || ((GetAsyncKeyState('R') & 0x8000) != 0);
			::SetCursor(bCameraCursor ? (CameraCursor ? CameraCursor : LoadCursor(nullptr, IDC_CROSS)) : LoadCursor(nullptr, IDC_ARROW));
			return (LRESULT)1; // TRUE（UE 头文件环境里 TRUE 宏可能已被隐藏）
		}
		return DefWindowProc(WindowHandle, Msg, WParam, LParam);
	}
	case WM_DISPLAYCHANGE:
	case WM_DWMCOMPOSITIONCHANGED:
	{
		// 桌面合成器/DPI 变化后重贴最后一帧
		UpdateOnScreen();
		return 0;
	}
	default:
		return DefWindowProc(WindowHandle, Msg, WParam, LParam);
	}
}

LRESULT CALLBACK PetLayeredWindow::StaticLowLevelMouseProc(int32 Code, WPARAM WParam, LPARAM LParam)
{
	PetLayeredWindow* Owner = MouseHookOwner;
	if (Code >= 0 && Owner && Owner->WindowHandle && WParam == WM_MOUSEWHEEL &&
		(GetAsyncKeyState('R') & 0x8000) != 0)
	{
		const MSLLHOOKSTRUCT* MouseInfo = reinterpret_cast<const MSLLHOOKSTRUCT*>(LParam);
		if (MouseInfo && Owner->IsOpaqueScreenPoint(MouseInfo->pt))
		{
			const int16 Delta = static_cast<int16>(HIWORD(MouseInfo->mouseData));
			PostMessageW(Owner->WindowHandle, PetCameraWheelMessage, MAKEWPARAM(static_cast<uint16>(Delta), 0), 0);
		}
	}
	return CallNextHookEx(Owner ? Owner->MouseHook : nullptr, Code, WParam, LParam);
}

LRESULT CALLBACK PetLayeredWindow::StaticLowLevelKeyboardProc(int32 Code, WPARAM WParam, LPARAM LParam)
{
	PetLayeredWindow* Owner = KeyboardHookOwner;
	if (Code >= 0 && Owner && Owner->WindowHandle && (WParam == WM_KEYDOWN || WParam == WM_SYSKEYDOWN))
	{
		const KBDLLHOOKSTRUCT* KeyInfo = reinterpret_cast<const KBDLLHOOKSTRUCT*>(LParam);
		if (KeyInfo && KeyInfo->vkCode == VK_OEM_COMMA && (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0)
		{
			// 与 ESC/R 同一触发域：光标正指着宠物本体（不透明像素）才响应。
			// 按住连发只触发一次，与原先 MOD_NOREPEAT 行为对齐。
			POINT Cursor{};
			if (!Owner->bSettingsChordDown && GetCursorPos(&Cursor) && Owner->IsOpaqueScreenPoint(Cursor) && Owner->OnHotKey)
			{
				Owner->OnHotKey();
			}
			Owner->bSettingsChordDown = true;
		}
	}
	else if (Code >= 0 && Owner && (WParam == WM_KEYUP || WParam == WM_SYSKEYUP))
	{
		const KBDLLHOOKSTRUCT* KeyInfo = reinterpret_cast<const KBDLLHOOKSTRUCT*>(LParam);
		if (KeyInfo && KeyInfo->vkCode == VK_OEM_COMMA)
		{
			Owner->bSettingsChordDown = false;
		}
	}
	return CallNextHookEx(Owner ? Owner->KeyboardHook : nullptr, Code, WParam, LParam);
}

bool PetLayeredWindow::IsOpaqueScreenPoint(const POINT& ScreenPoint) const
{
	if (!WindowHandle || !DibBits || !IsWindowVisible(WindowHandle))
	{
		return false;
	}

	const int32 X = ScreenPoint.x - Pos.x;
	const int32 Y = ScreenPoint.y - Pos.y;
	if (X < 0 || X >= Size || Y < 0 || Y >= Size)
	{
		return false;
	}

	const uint8* Pixels = static_cast<const uint8*>(DibBits);
	return Pixels[(Y * Size + X) * 4 + 3] >= 16;
}

void PetLayeredWindow::HandleCameraWheel(float WheelDelta)
{
	if (FMath::IsNearlyZero(WheelDelta))
	{
		return;
	}
	if (OnCameraZoom)
	{
		OnCameraZoom(WheelDelta);
	}
	bWheelCameraCursorActive = true;
	WheelCameraCursorExpireTick = NowMilliseconds() + 250;
	::SetCursor(CameraCursor ? CameraCursor : LoadCursor(nullptr, IDC_CROSS));
}

void PetLayeredWindow::SetCameraCursorImage(const uint8* BgraPixels, int32 Width, int32 Height)
{
	if (BgraPixels && Width > 0 && Height > 0)
	{
		CameraCursorImage.SetNumUninitialized(Width * Height * 4);
		FMemory::Memcpy(CameraCursorImage.GetData(), BgraPixels, CameraCursorImage.Num());
		CameraCursorImageWidth = Width;
		CameraCursorImageHeight = Height;
	}
	else
	{
		CameraCursorImage.Reset();
		CameraCursorImageWidth = 0;
		CameraCursorImageHeight = 0;
	}
	if (CameraCursor)
	{
		DestroyCursor(CameraCursor);
		CameraCursor = nullptr;
	}
	CameraCursor = CreateCameraCursor();
}

HCURSOR PetLayeredWindow::CreateCameraCursor()
{
	constexpr int32 CursorSize = 32;
	BITMAPV5HEADER Header = {};
	Header.bV5Size = sizeof(Header);
	Header.bV5Width = CursorSize;
	Header.bV5Height = -CursorSize;
	Header.bV5Planes = 1;
	Header.bV5BitCount = 32;
	Header.bV5Compression = BI_BITFIELDS;
	Header.bV5RedMask = 0x00FF0000;
	Header.bV5GreenMask = 0x0000FF00;
	Header.bV5BlueMask = 0x000000FF;
	Header.bV5AlphaMask = 0xFF000000;

	void* ColorBits = nullptr;
	HDC ScreenDC = GetDC(nullptr);
	HBITMAP ColorBitmap = CreateDIBSection(ScreenDC, reinterpret_cast<BITMAPINFO*>(&Header), DIB_RGB_COLORS, &ColorBits, nullptr, 0);
	ReleaseDC(nullptr, ScreenDC);
	uint32 MaskBits[CursorSize] = {};
	HBITMAP MaskBitmap = CreateBitmap(CursorSize, CursorSize, 1, 1, MaskBits);
	if (!ColorBitmap || !MaskBitmap || !ColorBits)
	{
		if (ColorBitmap) DeleteObject(ColorBitmap);
		if (MaskBitmap) DeleteObject(MaskBitmap);
		return nullptr;
	}

	uint32* Pixels = static_cast<uint32*>(ColorBits);
	FMemory::Memzero(Pixels, CursorSize * CursorSize * sizeof(uint32));
	FIntPoint Hotspot(5, 9);
	if (CameraCursorImageWidth > 0 && CameraCursorImageHeight > 0 &&
		CameraCursorImage.Num() >= CameraCursorImageWidth * CameraCursorImageHeight * 4)
	{
		// 最近邻采样到光标尺寸；UE 纹理的 BGRA 字节序与 DIB 像素（0xAARRGGBB）一致，直接拷贝。
		for (int32 Y = 0; Y < CursorSize; ++Y)
		{
			const int32 SrcY = Y * CameraCursorImageHeight / CursorSize;
			for (int32 X = 0; X < CursorSize; ++X)
			{
				const int32 SrcX = X * CameraCursorImageWidth / CursorSize;
				FMemory::Memcpy(
					&Pixels[Y * CursorSize + X],
					&CameraCursorImage[(SrcY * CameraCursorImageWidth + SrcX) * 4],
					sizeof(uint32));
			}
		}
		Hotspot = FIntPoint(CursorSize / 2, CursorSize / 2);
	}
	else
	{
		auto PutPixel = [Pixels](int32 X, int32 Y, uint32 Color)
		{
			if (X >= 0 && X < CursorSize && Y >= 0 && Y < CursorSize)
			{
				Pixels[Y * CursorSize + X] = Color;
			}
		};
		// 白色相机机身、蓝色镜头与深色描边，热点位于左上取景角。
		for (int32 Y = 9; Y <= 23; ++Y)
		{
			for (int32 X = 5; X <= 25; ++X)
			{
				const bool bBorder = X == 5 || X == 25 || Y == 9 || Y == 23;
				PutPixel(X, Y, bBorder ? 0xFF172033 : 0xFFF4F7FC);
			}
		}
		for (int32 Y = 6; Y <= 10; ++Y)
		{
			for (int32 X = 9; X <= 16; ++X)
			{
				PutPixel(X, Y, 0xFFF4F7FC);
			}
		}
		for (int32 Y = 12; Y <= 20; ++Y)
		{
			for (int32 X = 12; X <= 20; ++X)
			{
				const int32 Dx = X - 16;
				const int32 Dy = Y - 16;
				if (Dx * Dx + Dy * Dy <= 16)
				{
					PutPixel(X, Y, 0xFF4BB0FF);
				}
			}
		}
		for (int32 Y = 12; Y <= 20; ++Y)
		{
			const int32 HalfWidth = (Y <= 16) ? Y - 11 : 21 - Y;
			for (int32 X = 26; X <= 26 + HalfWidth; ++X)
			{
				PutPixel(X, Y, 0xFFF4F7FC);
			}
		}
	}

	ICONINFO Info = {};
	Info.fIcon = 0;
	Info.xHotspot = Hotspot.X;
	Info.yHotspot = Hotspot.Y;
	Info.hbmMask = MaskBitmap;
	Info.hbmColor = ColorBitmap;
	HCURSOR Result = CreateIconIndirect(&Info);
	DeleteObject(ColorBitmap);
	DeleteObject(MaskBitmap);
	return Result;
}
