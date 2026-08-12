#pragma once

#include "CoreMinimal.h"

enum class EPetPointerReleaseAction : uint8
{
	None,
	Click,
	Close,
	Drag
};

namespace PetLayeredWindowInput
{
	inline EPetPointerReleaseAction ResolveReleaseAction(
		const bool bPointerActive,
		const bool bDragThresholdMet,
		const uint64 PressDurationMs,
		const bool bCloseGestureArmed)
	{
		if (!bPointerActive)
		{
			return EPetPointerReleaseAction::None;
		}
		if (bDragThresholdMet)
		{
			return EPetPointerReleaseAction::Drag;
		}
		if (PressDurationMs >= 800)
		{
			return EPetPointerReleaseAction::None;
		}
		return bCloseGestureArmed ? EPetPointerReleaseAction::Close : EPetPointerReleaseAction::Click;
	}
}
