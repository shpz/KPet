#pragma once

#include "CoreMinimal.h"

namespace PetWindowDpi
{
	/**
	 * 把 96 DPI 基准下的逻辑边长换算为当前显示器需要的物理像素边长。
	 * 非法缩放值回退为 100%，避免系统查询失败时创建零尺寸窗口。
	 */
	inline int32 LogicalToPhysicalSize(const int32 LogicalSize, const float DpiScale)
	{
		const int32 SafeLogicalSize = FMath::Max(1, LogicalSize);
		const float SafeDpiScale = FMath::IsFinite(DpiScale) && DpiScale > UE_SMALL_NUMBER
			? DpiScale
			: 1.0f;
		return FMath::Max(1, FMath::RoundToInt(SafeLogicalSize * SafeDpiScale));
	}
}
