#include "UI/PetSessionItem.h"
#include "UI/PetSessionPanelWidget.h"

#include "Misc/AutomationTest.h"
#include "UObject/SoftObjectPath.h"
#include "UObject/SoftObjectPtr.h"

#if WITH_AUTOMATION_TESTS

/**
 * 会话面板资源降级测试（方案 §13.1⑥）。
 *
 * 覆盖边界：APetCapturePawn::InitializeSessionPanel 为 private 且 CreateWidget 分支依赖
 * UWorld，无法在无世界的自动化测试中直接调用；此处按等价语义覆盖其前两条降级路径：
 * ① 软类未配置（IsNull）与指向无效资源的软类（LoadSynchronous 返回空），以及
 * ② 全部 BindWidgetOptional 控件缺失时公开数据/视觉接口的安全空转与数据保留。
 * CreateWidget 失败分支（需 UWorld）不在单元层覆盖范围内。
 */
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetSessionWidgetClassDegradationTest,
	"Pet.UI.SessionPanel.WidgetClassDegradation",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetSessionWidgetClassDegradationTest::RunTest(const FString& Parameters)
{
	// 未配置（默认构造）对应 Pawn 的 IsNull 分支：返回前不触碰 World，无 ensure。
	TSoftClassPtr<UPetSessionPanelWidget> Unconfigured;
	TestTrue(TEXT("未配置的软类 IsNull 为真"), Unconfigured.IsNull());

	// 指向无效资源路径的软类对应 Pawn 的 LoadSynchronous 失败分支：返回空且不崩溃。
	const FSoftClassPath InvalidPath(TEXT("/Game/UI/NotExist_Panel.NotExist_Panel_C"));
	TSoftClassPtr<UPetSessionPanelWidget> InvalidClass(InvalidPath);
	TestFalse(TEXT("无效路径软类 IsNull 为假"), InvalidClass.IsNull());
	const TSubclassOf<UPetSessionPanelWidget> Loaded = InvalidClass.LoadSynchronous();
	TestNull(TEXT("无效路径 LoadSynchronous 返回空且不触发 ensure"), Loaded);

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetSessionPanelUnboundControlsDegradationTest,
	"Pet.UI.SessionPanel.UnboundControlsDegradation",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetSessionPanelUnboundControlsDegradationTest::RunTest(const FString& Parameters)
{
	// NewObject 直接构造 C++ 基类不经过 WidgetTree，所有 BindWidgetOptional 控件
	//（ListView_Sessions/EmptyState/Anim_PanelEnter）均为空，等价于控件全部缺失的最坏情况。
	UPetSessionPanelWidget* Panel = NewObject<UPetSessionPanelWidget>();
	TestNotNull(TEXT("未绑定控件的会话 Panel 创建成功"), Panel);
	if (!Panel)
	{
		return false;
	}
	TestEqual(TEXT("初始会话数量为零"), Panel->GetSessionCount(), 0);

	// 快照：无 ListView/EmptyState 时数据仍完整保留在内存目录中。
	FPetSessionInfo First;
	First.SessionId = TEXT("session-a");
	First.Title = TEXT("A");
	First.bActive = true;

	FPetSessionInfo Second;
	Second.SessionId = TEXT("session-b");
	Second.Title = TEXT("B");
	Second.bUnread = true;

	TArray<FPetSessionInfo> Snapshot;
	Snapshot.Add(First);
	Snapshot.Add(Second);
	Panel->ApplySnapshot(Snapshot);

	TestEqual(TEXT("无控件绑定下快照数据仍保留"), Panel->GetSessionCount(), 2);
	TestNotNull(TEXT("无控件绑定下会话可查询"), Panel->FindSessionItem(TEXT("session-a")));
	TestEqual(TEXT("目录顺序保持快照顺序"),
		Panel->GetSessionItems()[1]->SessionId,
		FString(TEXT("session-b")));

	// 增量：两条重载与状态接口在无控件绑定下仍更新内存数据。
	FPetSessionInfo Increment = First;
	Increment.Title = TEXT("A 更新");
	Panel->AddOrUpdateSession(Increment);
	UPetSessionItem* ItemA = Panel->FindSessionItem(TEXT("session-a"));
	TestNotNull(TEXT("增量更新目标仍可查询"), ItemA);
	if (ItemA)
	{
		TestEqual(TEXT("增量更新原位更新标题"), ItemA->Title, FString(TEXT("A 更新")));
	}

	Panel->AddOrUpdateSession(TEXT("session-c"), TEXT("C"), TEXT("D:/workspace/c"), false);
	TestEqual(TEXT("轻量增量创建新会话"), Panel->GetSessionCount(), 3);

	Panel->UpdateSessionState(TEXT("session-b"), true, true);
	UPetSessionItem* ItemB = Panel->FindSessionItem(TEXT("session-b"));
	TestTrue(TEXT("无控件绑定下状态更新仍生效"),
		ItemB && ItemB->bWorking && ItemB->bUnread);

	Panel->SetSessionActive(TEXT("session-c"), false);
	UPetSessionItem* ItemC = Panel->FindSessionItem(TEXT("session-c"));
	TestTrue(TEXT("无控件绑定下激活状态仍更新"), ItemC && !ItemC->bActive);

	// 视觉接口：缺失动画/列表绑定时安全空转，不破坏数据。
	Panel->PlayPanelContentAnimation();
	Panel->ReplayVisibleRowAnimations();
	Panel->TickDetachedWindowAnimations(0.016f);
	TestEqual(TEXT("视觉接口空转不破坏数据"), Panel->GetSessionCount(), 3);

	// 移除与清空仍正确维护内存目录。
	Panel->RemoveSession(TEXT("session-a"));
	TestEqual(TEXT("无控件绑定下移除生效"), Panel->GetSessionCount(), 2);
	TestNull(TEXT("移除后不可查询"), Panel->FindSessionItem(TEXT("session-a")));

	Panel->ClearSessions();
	TestEqual(TEXT("无控件绑定下清空生效"), Panel->GetSessionCount(), 0);

	// 脏数据防御：空 SessionId 的快照项被忽略，不写入目录。
	FPetSessionInfo NoId;
	NoId.Title = TEXT("无 ID");
	TArray<FPetSessionInfo> Dirty;
	Dirty.Add(NoId);
	Panel->ApplySnapshot(Dirty);
	TestEqual(TEXT("空 SessionId 快照项被忽略"), Panel->GetSessionCount(), 0);

	return true;
}

#endif
