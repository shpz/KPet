#include "UI/PetSessionItem.h"
#include "UI/PetSessionPanelWidget.h"

#include "Misc/AutomationTest.h"

#if WITH_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetSessionItemInPlaceUpdateTest,
	"Pet.UI.SessionItem.InPlaceUpdate",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetSessionItemInPlaceUpdateTest::RunTest(const FString& Parameters)
{
	UPetSessionItem* Item = NewObject<UPetSessionItem>();
	TestNotNull(TEXT("会话 Item 创建成功"), Item);
	if (!Item)
	{
		return false;
	}

	int32 ChangedCount = 0;
	Item->OnChanged.AddLambda([&ChangedCount](UPetSessionItem*)
	{
		++ChangedCount;
	});

	FPetSessionInfo Initial;
	Initial.SessionId = TEXT("session-a");
	Initial.Title = TEXT("第一次会话");
	Initial.Cwd = TEXT("D:/workspace/a");
	Initial.bActive = true;
	Initial.bWorking = true;
	Initial.bUnread = false;
	Item->InitializeFromSession(Initial);

	UPetSessionItem* StablePointer = Item;
	FPetSessionInfo Updated = Initial;
	Updated.Title = TEXT("更新后的会话");
	Updated.bWorking = false;
	Updated.bUnread = true;
	Item->UpdateFromSession(Updated);

	TestTrue(TEXT("更新保持 UObject 原位身份"), StablePointer == Item);
	TestEqual(TEXT("SessionId 保持不变"), Item->SessionId, FString(TEXT("session-a")));
	TestEqual(TEXT("标题原位更新"), Item->Title, FString(TEXT("更新后的会话")));
	TestFalse(TEXT("working 原位更新"), Item->bWorking);
	TestTrue(TEXT("unread 原位更新"), Item->bUnread);
	TestEqual(TEXT("两次快照更新各触发一次变更通知"), ChangedCount, 2);

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetSessionPanelSnapshotMergeTest,
	"Pet.UI.SessionPanel.SnapshotMerge",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetSessionPanelSnapshotMergeTest::RunTest(const FString& Parameters)
{
	UPetSessionPanelWidget* Panel = NewObject<UPetSessionPanelWidget>();
	TestNotNull(TEXT("会话 Panel 创建成功"), Panel);
	if (!Panel)
	{
		return false;
	}

	FPetSessionInfo First;
	First.SessionId = TEXT("session-a");
	First.Title = TEXT("A");
	First.bActive = true;

	FPetSessionInfo Second;
	Second.SessionId = TEXT("session-b");
	Second.Title = TEXT("B");
	Second.bUnread = true;

	TArray<FPetSessionInfo> InitialSnapshot;
	InitialSnapshot.Add(First);
	InitialSnapshot.Add(Second);
	Panel->ApplySnapshot(InitialSnapshot);

	UPetSessionItem* StableSecond = Panel->FindSessionItem(TEXT("session-b"));
	TestNotNull(TEXT("快照创建第二个 Item"), StableSecond);
	TestEqual(TEXT("初始快照包含两个会话"), Panel->GetSessionCount(), 2);

	FPetSessionInfo UpdatedSecond = Second;
	UpdatedSecond.Title = TEXT("B 更新");
	UpdatedSecond.bUnread = false;

	FPetSessionInfo Third;
	Third.SessionId = TEXT("session-c");
	Third.Title = TEXT("C");

	TArray<FPetSessionInfo> UpdatedSnapshot;
	UpdatedSnapshot.Add(UpdatedSecond);
	UpdatedSnapshot.Add(Third);
	Panel->ApplySnapshot(UpdatedSnapshot);

	TestEqual(TEXT("快照合并后会话数量正确"), Panel->GetSessionCount(), 2);
	TestTrue(TEXT("相同 SessionId 复用原 Item"), StableSecond == Panel->FindSessionItem(TEXT("session-b")));
	TestNull(TEXT("快照移除缺失会话"), Panel->FindSessionItem(TEXT("session-a")));
	TestEqual(TEXT("复用 Item 的标题已更新"), StableSecond->Title, FString(TEXT("B 更新")));
	TestFalse(TEXT("复用 Item 的未读状态已更新"), StableSecond->bUnread);
	TestNotNull(TEXT("快照新增第三个 Item"), Panel->FindSessionItem(TEXT("session-c")));

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetSessionPanelIncrementalUpdateTest,
	"Pet.UI.SessionPanel.IncrementalUpdate",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetSessionPanelIncrementalUpdateTest::RunTest(const FString& Parameters)
{
	UPetSessionPanelWidget* Panel = NewObject<UPetSessionPanelWidget>();
	TestNotNull(TEXT("会话 Panel 创建成功"), Panel);
	if (!Panel)
	{
		return false;
	}

	Panel->AddOrUpdateSession(TEXT("session-a"), TEXT("A"), TEXT("D:/workspace/a"), true);
	UPetSessionItem* StableItem = Panel->FindSessionItem(TEXT("session-a"));
	TestNotNull(TEXT("首次增量创建 Item"), StableItem);
	TestEqual(TEXT("首次增量计数为一"), Panel->GetSessionCount(), 1);

	Panel->UpdateSessionState(TEXT("session-a"), true, true);
	TestTrue(TEXT("增量状态更新为 working"), StableItem->bWorking);
	TestTrue(TEXT("增量状态更新为 unread"), StableItem->bUnread);
	TestTrue(TEXT("增量更新保持 Item 身份"), StableItem == Panel->FindSessionItem(TEXT("session-a")));

	Panel->SetSessionActive(TEXT("session-a"), false);
	TestFalse(TEXT("历史会话变为非激活"), StableItem->bActive);
	TestFalse(TEXT("非激活会话停止 working"), StableItem->bWorking);
	StableItem->SetWorking(true);
	TestFalse(TEXT("非激活 Item 拒绝矛盾的 working 状态"), StableItem->bWorking);
	Panel->SetSessionActive(TEXT("session-a"), false);
	TestFalse(TEXT("重复 inactive 事件保持状态稳定"), StableItem->bWorking);

	Panel->RemoveSession(TEXT("session-a"));
	TestEqual(TEXT("移除后会话数量为零"), Panel->GetSessionCount(), 0);
	TestNull(TEXT("移除后映射为空"), Panel->FindSessionItem(TEXT("session-a")));

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetSessionPanelRecencyAndInvariantTest,
	"Pet.UI.SessionPanel.RecencyAndInvariant",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetSessionPanelRecencyAndInvariantTest::RunTest(const FString& Parameters)
{
	UPetSessionPanelWidget* Panel = NewObject<UPetSessionPanelWidget>();
	TestNotNull(TEXT("会话 Panel 创建成功"), Panel);
	if (!Panel)
	{
		return false;
	}

	FPetSessionInfo RecentHistory;
	RecentHistory.SessionId = TEXT("history-recent");
	RecentHistory.Title = TEXT("最近历史");

	FPetSessionInfo ResumedHistory;
	ResumedHistory.SessionId = TEXT("history-resumed");
	ResumedHistory.Title = TEXT("恢复目标");
	ResumedHistory.bActive = false;
	ResumedHistory.bWorking = true; // 非法快照组合，Item 必须归一化。

	Panel->ApplySnapshot({RecentHistory, ResumedHistory});
	UPetSessionItem* ResumedItem = Panel->FindSessionItem(TEXT("history-resumed"));
	TestTrue(TEXT("非活跃快照不会保留 working"), ResumedItem && !ResumedItem->bWorking);

	Panel->UpdateSessionState(TEXT("history-resumed"), true, false);
	TestTrue(TEXT("历史项收到 session_state 后恢复为活跃会话"), ResumedItem && ResumedItem->bActive);
	TestTrue(TEXT("恢复后的会话显示 working"), ResumedItem && ResumedItem->bWorking);
	TestEqual(TEXT("产生新活动的会话移动到列表首项"),
		Panel->GetSessionItems()[0]->SessionId,
		FString(TEXT("history-resumed")));

	Panel->AddOrUpdateSession(TEXT("session-new"), TEXT("新会话"), TEXT("D:/workspace/new"), true);
	TestEqual(TEXT("session_start 新会话插入列表首项"),
		Panel->GetSessionItems()[0]->SessionId,
		FString(TEXT("session-new")));

	Panel->SetSessionActive(TEXT("unknown-ended"), false);
	TestNull(TEXT("未知 session_end 不创建幽灵历史行"), Panel->FindSessionItem(TEXT("unknown-ended")));

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetSessionPanelCatalogCapacityTest,
	"Pet.UI.SessionPanel.CatalogCapacity",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetSessionPanelCatalogCapacityTest::RunTest(const FString& Parameters)
{
	UPetSessionPanelWidget* Panel = NewObject<UPetSessionPanelWidget>();
	TestNotNull(TEXT("会话 Panel 创建成功"), Panel);
	if (!Panel)
	{
		return false;
	}

	TArray<FPetSessionInfo> Sessions;
	Sessions.Reserve(50);
	for (int32 Index = 0; Index < 50; ++Index)
	{
		FPetSessionInfo& Session = Sessions.AddDefaulted_GetRef();
		Session.SessionId = FString::Printf(TEXT("session-%02d"), Index);
		Session.Title = FString::Printf(TEXT("会话 %02d"), Index);
		Session.Cwd = FString::Printf(TEXT("D:/workspace/%02d"), Index);
		Session.bActive = Index < 2;
		Session.bWorking = Index == 0;
		Session.bUnread = Index == 1;
	}

	Panel->ApplySnapshot({});
	TestEqual(TEXT("空快照保留 0 条会话"), Panel->GetSessionCount(), 0);
	for (const int32 ExpectedCount : {1, 8, 50})
	{
		TArray<FPetSessionInfo> SizedSnapshot;
		SizedSnapshot.Reserve(ExpectedCount);
		for (int32 Index = 0; Index < ExpectedCount; ++Index)
		{
			SizedSnapshot.Add(Sessions[Index]);
		}
		Panel->ApplySnapshot(SizedSnapshot);
		TestEqual(
			FString::Printf(TEXT("快照完整保留 %d 条会话"), ExpectedCount),
			Panel->GetSessionCount(),
			ExpectedCount);
	}

	TestEqual(TEXT("完整保留 50 条会话目录数据"), Panel->GetSessionCount(), 50);
	TestEqual(TEXT("目录顺序首项不变"), Panel->GetSessionItems()[0]->SessionId, FString(TEXT("session-00")));
	TestEqual(TEXT("目录顺序末项不变"), Panel->GetSessionItems()[49]->SessionId, FString(TEXT("session-49")));
	UPetSessionItem* StableMiddleItem = Panel->FindSessionItem(TEXT("session-25"));
	TestNotNull(TEXT("中间目录项可查询"), StableMiddleItem);

	Sessions[25].Title = TEXT("会话 25 已更新");
	Sessions[25].bUnread = true;
	Panel->ApplySnapshot(Sessions);
	TestTrue(TEXT("50 条快照更新仍复用中间 Item"),
		StableMiddleItem == Panel->FindSessionItem(TEXT("session-25")));
	TestEqual(TEXT("50 条快照中的标题可原位更新"),
		StableMiddleItem->Title,
		FString(TEXT("会话 25 已更新")));
	TestTrue(TEXT("50 条快照中的未读状态可原位更新"), StableMiddleItem->bUnread);

	FPetSessionInfo NewSession;
	NewSession.SessionId = TEXT("session-new");
	NewSession.Title = TEXT("新会话");
	NewSession.bActive = true;
	Panel->AddOrUpdateSession(NewSession);
	TestEqual(TEXT("增量新增后仍严格限制为 50 条"),
		Panel->GetSessionCount(),
		UPetSessionPanelWidget::MaxSessionCount);
	TestEqual(TEXT("增量新增会话位于列表首项"),
		Panel->GetSessionItems()[0]->SessionId,
		FString(TEXT("session-new")));
	TestNull(TEXT("超出上限时淘汰列表末尾的最旧会话"), Panel->FindSessionItem(TEXT("session-49")));

	TArray<FPetSessionInfo> OversizedSnapshot = Sessions;
	for (int32 Index = 50; Index < 55; ++Index)
	{
		FPetSessionInfo& Session = OversizedSnapshot.AddDefaulted_GetRef();
		Session.SessionId = FString::Printf(TEXT("session-%02d"), Index);
		Session.Title = FString::Printf(TEXT("会话 %02d"), Index);
	}
	Panel->ApplySnapshot(OversizedSnapshot);
	TestEqual(TEXT("超大快照也严格限制为 50 条"),
		Panel->GetSessionCount(),
		UPetSessionPanelWidget::MaxSessionCount);
	TestNull(TEXT("超大快照末尾超限项不进入目录"), Panel->FindSessionItem(TEXT("session-54")));

	return true;
}

#endif
