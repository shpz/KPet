#include "UI/Tests/PetSessionRowWidgetTests.h"

#include "UI/PetSessionItem.h"

#include "Components/Button.h"
#include "Misc/AutomationTest.h"

#if WITH_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetSessionRowReuseCleanupTest,
	"Pet.UI.SessionRow.ReuseCleanup",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetSessionRowReuseCleanupTest::RunTest(const FString& Parameters)
{
	UPetSessionRowWidgetTestable* Row = NewObject<UPetSessionRowWidgetTestable>();
	TestNotNull(TEXT("会话行创建成功"), Row);
	if (!Row)
	{
		return false;
	}

	UPetSessionItem* ItemA = NewObject<UPetSessionItem>();
	UPetSessionItem* ItemB = NewObject<UPetSessionItem>();
	TestNotNull(TEXT("Item A 创建成功"), ItemA);
	TestNotNull(TEXT("Item B 创建成功"), ItemB);
	if (!ItemA || !ItemB)
	{
		return false;
	}

	FPetSessionInfo InfoA;
	InfoA.SessionId = TEXT("session-a");
	InfoA.Title = TEXT("会话 A");
	InfoA.bActive = false;

	FPetSessionInfo InfoB;
	InfoB.SessionId = TEXT("session-b");
	InfoB.Title = TEXT("会话 B");
	InfoB.bActive = true;

	ItemA->InitializeFromSession(InfoA);
	ItemB->InitializeFromSession(InfoB);

	TestFalse(TEXT("绑定前 Item A 无变更监听者"), ItemA->OnChanged.IsBound());

	// 模拟 UListView 滚动前把第一行绑定到 Item A。
	Row->TestSetListItem(ItemA);
	TestTrue(TEXT("绑定后行持有 Item A"), Row->GetBoundSessionItem() == ItemA);
	TestTrue(TEXT("绑定后 Item A 变更委托已订阅"), ItemA->OnChanged.IsBound());
	// 无 ActiveBar 时行透明度按非激活会话回退为 0.72，证明 RefreshFromItem 已生效。
	TestTrue(
		TEXT("绑定非激活 Item A 后行透明度降为 0.72"),
		FMath::IsNearlyEqual(Row->GetRenderOpacity(), 0.72f));

	// 模拟列表滚动把同一行复用给 Item B：旧委托必须解除、视觉状态重置。
	Row->TestSetListItem(ItemB);
	TestTrue(TEXT("复用后行持有 Item B"), Row->GetBoundSessionItem() == ItemB);
	TestFalse(TEXT("复用后旧 Item A 变更委托已解除"), ItemA->OnChanged.IsBound());
	TestTrue(TEXT("复用后 Item B 变更委托已订阅"), ItemB->OnChanged.IsBound());
	TestTrue(
		TEXT("复用后行反映 Item B 的激活透明度"),
		FMath::IsNearlyEqual(Row->GetRenderOpacity(), 1.0f));

	// 再修改旧 Item A 不应串到已复用给 Item B 的行：行不响应、不崩溃。
	ItemA->SetActive(true);
	ItemA->SetWorking(true);
	ItemA->SetUnread(true);
	ItemA->UpdateFromSession(InfoA);
	TestTrue(
		TEXT("修改旧 Item A 后行透明度不受影响"),
		FMath::IsNearlyEqual(Row->GetRenderOpacity(), 1.0f));

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetSessionRowEntryReleasedCleanupTest,
	"Pet.UI.SessionRow.EntryReleasedCleanup",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetSessionRowEntryReleasedCleanupTest::RunTest(const FString& Parameters)
{
	UPetSessionRowWidgetTestable* Row = NewObject<UPetSessionRowWidgetTestable>();
	TestNotNull(TEXT("会话行创建成功"), Row);
	if (!Row)
	{
		return false;
	}

	UPetSessionItem* Item = NewObject<UPetSessionItem>();
	TestNotNull(TEXT("条目创建成功"), Item);
	if (!Item)
	{
		return false;
	}

	FPetSessionInfo Info;
	Info.SessionId = TEXT("session-a");
	Info.Title = TEXT("会话 A");
	Info.bActive = true;
	Item->InitializeFromSession(Info);

	Row->TestSetListItem(Item);
	TestTrue(TEXT("绑定后行持有条目"), Row->GetBoundSessionItem() == Item);
	TestTrue(TEXT("绑定后条目变更委托已订阅"), Item->OnChanged.IsBound());

	// 模拟列表把条目移出可视区后释放该行。
	Row->TestReleaseEntry();
	TestNull(TEXT("释放后行不再持有条目"), Row->GetBoundSessionItem());
	TestFalse(TEXT("释放后条目变更委托已解除"), Item->OnChanged.IsBound());
	TestTrue(
		TEXT("释放后视觉状态重置为不透明"),
		FMath::IsNearlyEqual(Row->GetRenderOpacity(), 1.0f));

	// 释放后修改条目不应再触发行：行不响应、不崩溃。
	Item->SetActive(false);
	Item->SetWorking(true);
	Item->SetUnread(true);
	TestTrue(
		TEXT("修改已释放条目后行透明度保持重置值"),
		FMath::IsNearlyEqual(Row->GetRenderOpacity(), 1.0f));

	// 行释放后仍可重新绑定（模拟再次滚入可视区），证明清理不残留。
	Row->TestSetListItem(Item);
	TestTrue(TEXT("重新绑定后行重新持有条目"), Row->GetBoundSessionItem() == Item);
	TestTrue(TEXT("重新绑定后条目变更委托重新订阅"), Item->OnChanged.IsBound());

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetSessionRowClickRoutingTest,
	"Pet.UI.SessionRow.ClickRouting",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetSessionRowClickRoutingTest::RunTest(const FString& Parameters)
{
	UPetSessionRowWidgetTestable* Row = NewObject<UPetSessionRowWidgetTestable>();
	TestNotNull(TEXT("会话行创建成功"), Row);
	if (!Row)
	{
		return false;
	}

	TestFalse(TEXT("缺少 Button_Row 时由 ListView 提供点击降级"), Row->HasDedicatedClickHandler());
	UButton* Button = NewObject<UButton>(Row);
	TestNotNull(TEXT("测试按钮创建成功"), Button);
	Row->TestSetDedicatedButton(Button);
	TestTrue(TEXT("存在 Button_Row 时行独占点击，ListView 不应重复广播"), Row->HasDedicatedClickHandler());

	return true;
}

#endif
