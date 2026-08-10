#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"

#include "Communication/PetSessionTypes.h"

#include "PetSessionItem.generated.h"

class UPetSessionItem;

/** 单条会话数据发生变化时触发。 */
DECLARE_MULTICAST_DELEGATE_OneParam(FPetSessionItemChangedNative, UPetSessionItem* /* Item */);

/** 用户选择该会话时触发。 */
DECLARE_MULTICAST_DELEGATE_OneParam(FPetSessionItemSelectedNative, UPetSessionItem* /* Item */);

/**
 * UListView 使用的单条会话对象。
 *
 * 对象由 UPetSessionPanelWidget 持有，并在会话状态变化时原位更新。这样列表条目
 * 复用时仍然能够保留对象身份、选中状态和动画状态，不需要反复创建 UObject。
 */
UCLASS(BlueprintType)
class PET_API UPetSessionItem : public UObject
{
	GENERATED_BODY()

public:
	/** 使用通信层的会话记录初始化或更新该对象。 */
	void InitializeFromSession(const FPetSessionInfo& Session);
	void UpdateFromSession(const FPetSessionInfo& Session);

	/** 不依赖通信层头文件的更新接口，便于增量状态事件使用。 */
	void SetSessionData(
		const FString& InSessionId,
		const FString& InTitle,
		const FString& InCwd,
		bool bInActive,
		bool bInWorking,
		bool bInUnread);

	void SetActive(bool bInActive);
	void SetWorking(bool bInWorking);
	void SetUnread(bool bInUnread);

	/** 由会话行在点击时调用，Panel 会将其转发为公开的选择事件。 */
	void NotifySelected();

	/** 当前对象是否具备可用于选择和映射的会话标识。 */
	bool HasSessionId() const { return !SessionId.IsEmpty(); }

	/** 数据变更通知，Row 可以据此在不替换对象的情况下刷新自身。 */
	FPetSessionItemChangedNative OnChanged;

	/** 选择通知，Panel 直接绑定该委托，不经过 Window Host。 */
	FPetSessionItemSelectedNative OnSelected;

	UPROPERTY(BlueprintReadOnly, Category = "会话")
	FString SessionId;

	UPROPERTY(BlueprintReadOnly, Category = "会话")
	FString Title;

	UPROPERTY(BlueprintReadOnly, Category = "会话")
	FString Cwd;

	UPROPERTY(BlueprintReadOnly, Category = "会话")
	bool bActive = false;

	UPROPERTY(BlueprintReadOnly, Category = "会话")
	bool bWorking = false;

	UPROPERTY(BlueprintReadOnly, Category = "会话")
	bool bUnread = false;
};
