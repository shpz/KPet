#pragma once

#include "CoreMinimal.h"
#include "PetWorkState.generated.h"

/** 守护进程权威下发的宠物工作状态。 */
UENUM(BlueprintType)
enum class EPetWorkState : uint8
{
	Idle UMETA(DisplayName = "Idle"),
	Working UMETA(DisplayName = "Working")
};

/** 协议状态应用结果，用于区分非法值、重复快照和真实状态切换。 */
enum class EPetWorkStateApplyResult : uint8
{
	Invalid,
	Unchanged,
	Changed
};

namespace PetWorkStateLogic
{
	inline EPetWorkStateApplyResult ApplyProtocolValue(const FString& State, EPetWorkState& InOutState)
	{
		EPetWorkState NewState;
		if (State == TEXT("Idle"))
		{
			NewState = EPetWorkState::Idle;
		}
		else if (State == TEXT("Working"))
		{
			NewState = EPetWorkState::Working;
		}
		else
		{
			return EPetWorkStateApplyResult::Invalid;
		}

		if (InOutState == NewState)
		{
			return EPetWorkStateApplyResult::Unchanged;
		}
		InOutState = NewState;
		return EPetWorkStateApplyResult::Changed;
	}
}
