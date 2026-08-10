#pragma once

#include "CoreMinimal.h"
#include "UI/PetSessionRowWidget.h"

#include "PetSessionRowWidgetTests.generated.h"

/**
 * 暴露受保护条目接口的测试替身，用于在没有 UListView 的环境下模拟列表复用。
 * 注意：未 Initialize 的 UserWidget 其 BindWidgetOptional 控件与动画均为 nullptr，
 * 测试只断言无控件环境下可验证的层面（委托绑定关系、视觉透明度、不崩溃）。
 */
UCLASS()
class UPetSessionRowWidgetTestable : public UPetSessionRowWidget
{
	GENERATED_BODY()

public:
	/** 模拟 UListView 把条目对象设置到该行。 */
	void TestSetListItem(UObject* ListItemObject) { NativeOnListItemObjectSet(ListItemObject); }

	/** 模拟 UListView 把条目移出可视区后释放该行。 */
	void TestReleaseEntry() { NativeOnEntryReleased(); }
};
