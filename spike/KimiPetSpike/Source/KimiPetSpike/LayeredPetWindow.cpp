#include "LayeredPetWindow.h"
#include "KimiPetSpike.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/FileManager.h"

static const TCHAR* SpikeWindowClassName = TEXT("KimiPetSpikeLayeredWindow");

bool FLayeredPetWindow::Create(int32 InSize, int32 PosX, int32 PosY)
{
	Size = InSize;
	Pos.x = PosX;
	Pos.y = PosY;

	HINSTANCE Instance = GetModuleHandle(nullptr);

	WNDCLASSEX Wc = {};
	Wc.cbSize = sizeof(Wc);
	Wc.lpfnWndProc = &FLayeredPetWindow::StaticWndProc;
	Wc.hInstance = Instance;
	Wc.lpszClassName = SpikeWindowClassName;
	Wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
	if (!RegisterClassEx(&Wc))
	{
		DWORD Err = GetLastError();
		if (Err != ERROR_CLASS_ALREADY_EXISTS)
		{
			UE_LOG(LogKimiPetSpike, Error, TEXT("RegisterClassEx failed: %u"), Err);
			return false;
		}
	}

	const DWORD ExStyle = WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
	WindowHandle = CreateWindowEx(ExStyle, SpikeWindowClassName, TEXT("KimiPetSpike"),
		WS_POPUP, Pos.x, Pos.y, Size, Size, nullptr, nullptr, Instance, this);
	if (!WindowHandle)
	{
		UE_LOG(LogKimiPetSpike, Error, TEXT("CreateWindowEx failed: %u"), GetLastError());
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
		UE_LOG(LogKimiPetSpike, Error, TEXT("CreateDIBSection/CreateCompatibleDC failed"));
		Destroy();
		return false;
	}
	SelectObject(MemDC, DibSection);
	FMemory::Memzero(DibBits, Size * Size * 4);

	ShowWindow(WindowHandle, SW_SHOWNOACTIVATE);
	UE_LOG(LogKimiPetSpike, Log, TEXT("Layered window created: %dx%d at (%d,%d)"), Size, Size, Pos.x, Pos.y);
	return true;
}

void FLayeredPetWindow::Destroy()
{
	if (WindowHandle)
	{
		DestroyWindow(WindowHandle);
		WindowHandle = nullptr;
	}
	if (MemDC) { DeleteDC(MemDC); MemDC = nullptr; }
	if (DibSection) { DeleteObject(DibSection); DibSection = nullptr; DibBits = nullptr; }
}

void FLayeredPetWindow::Present(const uint8* SrcBGRA)
{
	if (!WindowHandle || !DibBits)
	{
		return;
	}

	const int32 NumPixels = Size * Size;
	++FrameCounter;

	// 诊断：第 300 帧（渲染稳定后）在像素转换之前落盘原始 RT 像素
	if (FrameCounter == 300)
	{
		FString Dir = FPaths::ProjectSavedDir() / TEXT("Diag");
		IFileManager::Get().MakeDirectory(*Dir, true);
		auto SavePPM = [&](const TCHAR* Name, int Channel)
		{
			FString Content = FString::Printf(TEXT("P3\n%d %d\n255\n"), Size, Size);
			for (int32 i = 0; i < NumPixels; ++i)
			{
				const uint8 V = SrcBGRA[i * 4 + Channel];
				Content += FString::Printf(TEXT("%d %d %d "), V, V, V);
			}
			FFileHelper::SaveStringToFile(Content, *(Dir / Name));
		};
		SavePPM(TEXT("rt_r.ppm"), 2);
		SavePPM(TEXT("rt_g.ppm"), 1);
		SavePPM(TEXT("rt_b.ppm"), 0);
		SavePPM(TEXT("rt_a.ppm"), 3);
		UE_LOG(LogKimiPetSpike, Log, TEXT("Diag frames dumped to %s"), *Dir);
	}

	// RT 像素语义（UE 源码取证：scene color alpha = 1-不透明度，RGB 已按不透明度预乘）：
	// - alpha 取反得到真实不透明度；RGB 已是预乘，直接拷贝，不再二次预乘。
	// 同时统计修正后的 alpha 分布作为"背景全透明"的客观证据。
	uint8* Dst = static_cast<uint8*>(DibBits);
	int32 AlphaZero = 0, AlphaFull = 0, AlphaMid = 0;
	uint8 MaxRgbAmongTransparent = 0;
	for (int32 i = 0; i < NumPixels; ++i)
	{
		const uint8 B = SrcBGRA[i * 4 + 0];
		const uint8 G = SrcBGRA[i * 4 + 1];
		const uint8 R = SrcBGRA[i * 4 + 2];
		const uint8 A = (uint8)(255 - SrcBGRA[i * 4 + 3]); // 反转 -> 真实不透明度
		Dst[i * 4 + 0] = B;
		Dst[i * 4 + 1] = G;
		Dst[i * 4 + 2] = R;
		Dst[i * 4 + 3] = A;

		if (A == 0)
		{
			++AlphaZero;
			MaxRgbAmongTransparent = FMath::Max3(MaxRgbAmongTransparent, R, FMath::Max(G, B));
		}
		else if (A == 255) { ++AlphaFull; }
		else { ++AlphaMid; }
	}

	if (FrameCounter % 60 == 1)
	{
		UE_LOG(LogKimiPetSpike, Log, TEXT("Frame %d alpha stats(fixed): a==0: %d (%.1f%%), a==255: %d, mid: %d, maxRGB(a=0): %d"),
			FrameCounter, AlphaZero, 100.0 * AlphaZero / NumPixels, AlphaFull, AlphaMid, MaxRgbAmongTransparent);
	}

	UpdateOnScreen();
}

void FLayeredPetWindow::UpdateOnScreen()
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

LRESULT CALLBACK FLayeredPetWindow::StaticWndProc(HWND Hwnd, UINT Msg, WPARAM WParam, LPARAM LParam)
{
	FLayeredPetWindow* Self = nullptr;
	if (Msg == WM_NCCREATE)
	{
		CREATESTRUCT* Cs = reinterpret_cast<CREATESTRUCT*>(LParam);
		Self = static_cast<FLayeredPetWindow*>(Cs->lpCreateParams);
		SetWindowLongPtr(Hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(Self));
		Self->WindowHandle = Hwnd;
	}
	else
	{
		Self = reinterpret_cast<FLayeredPetWindow*>(GetWindowLongPtr(Hwnd, GWLP_USERDATA));
	}

	if (Self)
	{
		return Self->HandleMessage(Msg, WParam, LParam);
	}
	return DefWindowProc(Hwnd, Msg, WParam, LParam);
}

LRESULT FLayeredPetWindow::HandleMessage(UINT Msg, WPARAM WParam, LPARAM LParam)
{
	switch (Msg)
	{
	case WM_LBUTTONDOWN:
	{
		// 只有不透明像素会收到此消息（透明像素系统自动穿透），记录锚点等待超阈值
		// 客户区坐标 == 相对窗口左上（WS_POPUP 无边框）
		const int32 ClientX = static_cast<int32>(static_cast<short>(LOWORD(LParam)));
		const int32 ClientY = static_cast<int32>(static_cast<short>(HIWORD(LParam)));
		bDragging = true;
		bDragThresholdMet = false;
		SetCapture(WindowHandle);
		DragAnchorCursor.x = ClientX + Pos.x;
		DragAnchorCursor.y = ClientY + Pos.y;
		DragGrabOffset.x = ClientX;
		DragGrabOffset.y = ClientY;
		return 0;
	}
	case WM_MOUSEMOVE:
	{
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
		if (bDragging)
		{
			bDragging = false;
			ReleaseCapture();
		}
		return 0;
	}
	case WM_SETCURSOR:
	{
		// 光标悬停在不透明像素（HTCLIENT）时，钉死为箭头并返回 TRUE 吃掉消息。
		// 否则 DefWindowProc 会把 WM_SETCURSOR 沿父链转发给 UE/Slate 的窗口，
		// Slate 按自己的悬停状态反复 SetCursor 成别的光标，与本类光标来回打架 -> 肉眼闪烁。
		if (LOWORD(LParam) == HTCLIENT)
		{
			::SetCursor(LoadCursor(nullptr, IDC_ARROW));
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
