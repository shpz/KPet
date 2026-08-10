#pragma once

#include "CoreMinimal.h"

/** Kimi Code CLI 会话列表中的单条记录。 */
struct FPetSessionInfo
{
	FString SessionId;
	FString Title;
	FString Cwd;
	bool bActive = false;
	bool bWorking = false;
	bool bUnread = false;
};
