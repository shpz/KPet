#include "UI/PetSessionPanelWidget.h"

#include "Pet.h"
#include "UI/PetSessionRowWidget.h"
#include "Animation/UMGSequenceTickManager.h"
#include "Animation/WidgetAnimation.h"
#include "Components/ListView.h"
#include "Components/Widget.h"

void UPetSessionPanelWidget::NativeConstruct()
{
	Super::NativeConstruct();

	if (ListView_Sessions)
	{
		if (!ListItemClickedHandle.IsValid())
		{
			// 行内 Button 处理点击时会直接通知 Item；列表本身的点击作为缺少 Button
			// 或点击行空白区域时的降级路径。
			ListItemClickedHandle = ListView_Sessions->OnItemClicked().AddUObject(
				this,
				&UPetSessionPanelWidget::HandleListItemClicked);
		}
	}
	else if (!bListBindingWarningLogged)
	{
		UE_LOG(LogPet, Warning, TEXT("会话面板缺少 BindWidgetOptional 控件 ListView_Sessions，数据仍会保留但不会显示列表"));
		bListBindingWarningLogged = true;
	}

	for (const TPair<FString, TObjectPtr<UPetSessionItem>>& Pair : SessionItemsById)
	{
		BindItem(Pair.Value.Get());
	}

	RefreshList();
	UpdateEmptyState();
	PlayPanelContentAnimation();
}

void UPetSessionPanelWidget::NativeDestruct()
{
	if (ListView_Sessions && ListItemClickedHandle.IsValid())
	{
		ListView_Sessions->OnItemClicked().Remove(ListItemClickedHandle);
	}
	ListItemClickedHandle.Reset();

	for (const TPair<FString, TObjectPtr<UPetSessionItem>>& Pair : SessionItemsById)
	{
		UnbindItem(Pair.Value.Get());
	}

	if (Anim_PanelEnter)
	{
		StopAnimation(Anim_PanelEnter);
	}

	Super::NativeDestruct();
}

void UPetSessionPanelWidget::ApplySnapshot(const TArray<FPetSessionInfo>& Sessions)
{
	TSet<FString> IncomingIds;
	IncomingIds.Reserve(Sessions.Num());

	TArray<TObjectPtr<UPetSessionItem>> NewOrder;
	NewOrder.Reserve(FMath::Min(Sessions.Num(), MaxSessionCount));
	bool bCapacityWarningLogged = false;

	for (const FPetSessionInfo& Session : Sessions)
	{
		if (Session.SessionId.IsEmpty())
		{
			UE_LOG(LogPet, Warning, TEXT("忽略没有 SessionId 的会话快照项"));
			continue;
		}

		if (IncomingIds.Contains(Session.SessionId))
		{
			UE_LOG(LogPet, Warning, TEXT("会话快照包含重复 SessionId=%s，忽略后续重复项"), *Session.SessionId);
			continue;
		}
		if (NewOrder.Num() >= MaxSessionCount)
		{
			if (!bCapacityWarningLogged)
			{
				UE_LOG(LogPet, Warning, TEXT("会话快照超过 %d 条，只保留最前面的最近会话"), MaxSessionCount);
				bCapacityWarningLogged = true;
			}
			continue;
		}
		IncomingIds.Add(Session.SessionId);

		bool bCreated = false;
		UPetSessionItem* Item = FindOrCreateSession(
			Session.SessionId,
			Session.Title,
			Session.Cwd,
			Session.bActive,
			Session.bWorking,
			Session.bUnread,
			bCreated);
		if (Item)
		{
			NewOrder.Add(Item);
		}
	}

	for (auto It = SessionItemsById.CreateIterator(); It; ++It)
	{
		if (!IncomingIds.Contains(It.Key()))
		{
			UnbindItem(It.Value().Get());
			It.RemoveCurrent();
		}
	}

	SessionItemOrder = MoveTemp(NewOrder);
	RefreshList();
	UpdateEmptyState();
}

void UPetSessionPanelWidget::AddOrUpdateSession(const FPetSessionInfo& Session)
{
	if (Session.SessionId.IsEmpty())
	{
		UE_LOG(LogPet, Warning, TEXT("忽略没有 SessionId 的会话增量"));
		return;
	}

	bool bCreated = false;
	UPetSessionItem* Item = FindOrCreateSession(
		Session.SessionId,
		Session.Title,
		Session.Cwd,
		Session.bActive,
		Session.bWorking,
		Session.bUnread,
		bCreated);
	if (!Item)
	{
		return;
	}

	const bool bOrderChanged = MoveSessionToFront(Item);
	const bool bTrimmed = TrimToSessionLimit();
	if (bOrderChanged || bTrimmed)
	{
		RefreshList();
	}
	UpdateEmptyState();
}

void UPetSessionPanelWidget::AddOrUpdateSession(
	const FString& SessionId,
	const FString& Title,
	const FString& Cwd,
	bool bActive)
{
	if (SessionId.IsEmpty())
	{
		UE_LOG(LogPet, Warning, TEXT("忽略没有 SessionId 的会话增量"));
		return;
	}

	if (UPetSessionItem* ExistingItem = FindSessionItem(SessionId))
	{
		ExistingItem->SetSessionData(
			SessionId,
			Title.IsEmpty() ? ExistingItem->Title : Title,
			Cwd.IsEmpty() ? ExistingItem->Cwd : Cwd,
			bActive,
			ExistingItem->bWorking,
			ExistingItem->bUnread);
		if (MoveSessionToFront(ExistingItem))
		{
			RefreshList();
		}
		return;
	}

	bool bCreated = false;
	UPetSessionItem* Item = FindOrCreateSession(
		SessionId,
		Title,
		Cwd,
		bActive,
		false,
		false,
		bCreated);
	if (Item && bCreated)
	{
		MoveSessionToFront(Item);
		TrimToSessionLimit();
		RefreshList();
		UpdateEmptyState();
	}
}

void UPetSessionPanelWidget::RemoveSession(const FString& SessionId)
{
	if (SessionId.IsEmpty())
	{
		return;
	}

	TObjectPtr<UPetSessionItem>* Found = SessionItemsById.Find(SessionId);
	if (!Found)
	{
		return;
	}

	UPetSessionItem* Item = Found->Get();
	if (ListView_Sessions && Item)
	{
		ListView_Sessions->RemoveItem(Item);
	}
	SessionItemOrder.RemoveAll([Item](const TObjectPtr<UPetSessionItem>& Candidate)
	{
		return Candidate.Get() == Item;
	});
	UnbindItem(Item);
	SessionItemsById.Remove(SessionId);

	UpdateEmptyState();
}

void UPetSessionPanelWidget::ClearSessions()
{
	if (ListView_Sessions)
	{
		ListView_Sessions->ClearListItems();
	}

	for (const TPair<FString, TObjectPtr<UPetSessionItem>>& Pair : SessionItemsById)
	{
		UnbindItem(Pair.Value.Get());
	}

	SessionItemsById.Reset();
	SessionItemOrder.Reset();
	UpdateEmptyState();
}

void UPetSessionPanelWidget::SetSessionActive(const FString& SessionId, bool bActive)
{
	if (SessionId.IsEmpty())
	{
		return;
	}

	UPetSessionItem* Item = FindSessionItem(SessionId);
	if (!Item)
	{
		// session_end 可能是守护进程接管后的首个事件。未知的结束事件不应
		// 制造只有原始 SessionId 的“幽灵历史行”。
		if (!bActive)
		{
			return;
		}

		bool bCreated = false;
		Item = FindOrCreateSession(SessionId, FString(), FString(), bActive, false, false, bCreated);
		if (Item && bCreated)
		{
			MoveSessionToFront(Item);
			TrimToSessionLimit();
			RefreshList();
			UpdateEmptyState();
		}
		return;
	}

	Item->SetActive(bActive);
	if (MoveSessionToFront(Item))
	{
		RefreshList();
	}
}

void UPetSessionPanelWidget::UpdateSessionState(const FString& SessionId, bool bWorking, bool bUnread)
{
	if (SessionId.IsEmpty())
	{
		return;
	}

	UPetSessionItem* Item = FindSessionItem(SessionId);
	if (!Item)
	{
		bool bCreated = false;
		Item = FindOrCreateSession(SessionId, FString(), FString(), true, bWorking, bUnread, bCreated);
		if (Item && bCreated)
		{
			MoveSessionToFront(Item);
			TrimToSessionLimit();
			RefreshList();
			UpdateEmptyState();
		}
		return;
	}

	// session_state 只由守护进程的活跃会话产生。若该会话此前只存在于
	// 历史目录中，这条消息同时意味着它已恢复活跃。
	Item->SetSessionData(
		Item->SessionId,
		Item->Title,
		Item->Cwd,
		true,
		bWorking,
		bUnread);
	if (MoveSessionToFront(Item))
	{
		RefreshList();
	}
}

void UPetSessionPanelWidget::PlayPanelContentAnimation()
{
	if (Anim_PanelEnter)
	{
		StopAnimation(Anim_PanelEnter);
		FlushAnimations();
		PlayAnimation(Anim_PanelEnter, 0.0f, 1, EUMGSequencePlayMode::Forward, 1.0f);
		return;
	}

	if (!bContentAnimationWarningLogged)
	{
		UE_LOG(LogPet, Verbose, TEXT("会话面板未绑定可选动画 Anim_PanelEnter，保持静态显示"));
		bContentAnimationWarningLogged = true;
	}
}

void UPetSessionPanelWidget::ReplayVisibleRowAnimations()
{
	if (!ListView_Sessions)
	{
		return;
	}

	for (UUserWidget* EntryWidget : ListView_Sessions->GetDisplayedEntryWidgets())
	{
		if (UPetSessionRowWidget* SessionRow = Cast<UPetSessionRowWidget>(EntryWidget))
		{
			SessionRow->ReplayPresentationAnimations();
		}
	}
}

void UPetSessionPanelWidget::TickDetachedWindowAnimations(const float DeltaTime)
{
	if (AnimationTickManager && IsAnyAnimationPlaying() && DeltaTime > 0.0f)
	{
		UUMGSequenceTickManager* TickManager = AnimationTickManager;
		TickManager->RemoveWidget(this);
		TickActionsAndAnimation(DeltaTime);
		TickManager->ForceFlush();
		InvalidateLayoutAndVolatility();
	}

	if (!ListView_Sessions)
	{
		return;
	}

	for (UUserWidget* EntryWidget : ListView_Sessions->GetDisplayedEntryWidgets())
	{
		if (UPetSessionRowWidget* SessionRow = Cast<UPetSessionRowWidget>(EntryWidget))
		{
			SessionRow->TickDetachedWindowAnimations(DeltaTime);
		}
	}
}

UPetSessionItem* UPetSessionPanelWidget::FindSessionItem(const FString& SessionId) const
{
	const TObjectPtr<UPetSessionItem>* Found = SessionItemsById.Find(SessionId);
	return Found ? Found->Get() : nullptr;
}

UPetSessionItem* UPetSessionPanelWidget::FindOrCreateSession(
	const FString& SessionId,
	const FString& Title,
	const FString& Cwd,
	bool bActive,
	bool bWorking,
	bool bUnread,
	bool& bCreated)
{
	bCreated = false;
	if (SessionId.IsEmpty())
	{
		return nullptr;
	}

	if (UPetSessionItem* ExistingItem = FindSessionItem(SessionId))
	{
		ExistingItem->SetSessionData(
			SessionId,
			Title,
			Cwd,
			bActive,
			bWorking,
			bUnread);
		return ExistingItem;
	}

	UPetSessionItem* NewItem = NewObject<UPetSessionItem>(this);
	if (!NewItem)
	{
		UE_LOG(LogPet, Error, TEXT("无法创建会话 UObject，SessionId=%s"), *SessionId);
		return nullptr;
	}

	NewItem->SetSessionData(SessionId, Title, Cwd, bActive, bWorking, bUnread);
	BindItem(NewItem);
	SessionItemsById.Add(SessionId, NewItem);
	bCreated = true;
	return NewItem;
}

void UPetSessionPanelWidget::BindItem(UPetSessionItem* Item)
{
	if (!Item)
	{
		return;
	}

	// 数据可能在 Widget Construct 前就已到达；NativeConstruct 会再次遍历已有对象，
	// 先移除旧绑定以保证重复 Construct 不会重复广播。
	Item->OnSelected.RemoveAll(this);
	Item->OnSelected.AddUObject(this, &UPetSessionPanelWidget::HandleItemSelected);
}

void UPetSessionPanelWidget::UnbindItem(UPetSessionItem* Item)
{
	if (!Item)
	{
		return;
	}

	Item->OnSelected.RemoveAll(this);
}

void UPetSessionPanelWidget::HandleItemSelected(UPetSessionItem* Item)
{
	if (!Item || Item->SessionId.IsEmpty())
	{
		return;
	}

	if (ListView_Sessions)
	{
		ListView_Sessions->SetSelectedItem(Item);
	}

	OnSessionSelected.Broadcast(Item->SessionId);
	OnSessionSelectedBlueprint.Broadcast(Item->SessionId);
}

void UPetSessionPanelWidget::HandleListItemClicked(UObject* ItemObject)
{
	UPetSessionItem* Item = Cast<UPetSessionItem>(ItemObject);
	if (!Item)
	{
		return;
	}
	if (ListView_Sessions)
	{
		// 生成的会话行以覆盖整行的 Button_Row 处理点击。Button 与
		// UListView 的点击冒泡可能在同一输入中都触发，必须只保留一条选择链路。
		if (const UPetSessionRowWidget* EntryWidget =
			ListView_Sessions->GetEntryWidgetFromItem<UPetSessionRowWidget>(Item);
			EntryWidget && EntryWidget->HasDedicatedClickHandler())
		{
			return;
		}
	}

	// 没有覆盖完整行的 Button 时，使用 UListView 自身点击作为安全降级路径。
	Item->SetUnread(false);
	Item->NotifySelected();
}

void UPetSessionPanelWidget::RefreshList()
{
	if (!ListView_Sessions)
	{
		return;
	}

	TArray<UObject*> Items;
	Items.Reserve(SessionItemOrder.Num());
	for (const TObjectPtr<UPetSessionItem>& Item : SessionItemOrder)
	{
		if (Item)
		{
			Items.Add(Item.Get());
		}
	}
	ListView_Sessions->SetListItems(Items);
}

void UPetSessionPanelWidget::UpdateEmptyState()
{
	if (!EmptyState)
	{
		if (!bEmptyStateWarningLogged)
		{
			UE_LOG(LogPet, Verbose, TEXT("会话面板未绑定可选空状态控件 EmptyState，空列表仍可正常运行"));
			bEmptyStateWarningLogged = true;
		}
		return;
	}

	EmptyState->SetVisibility(SessionItemOrder.IsEmpty() ? ESlateVisibility::Visible : ESlateVisibility::Collapsed);
}

bool UPetSessionPanelWidget::MoveSessionToFront(UPetSessionItem* Item)
{
	if (!Item)
	{
		return false;
	}

	const int32 ExistingIndex = SessionItemOrder.IndexOfByKey(Item);
	if (ExistingIndex == 0)
	{
		return false;
	}
	if (ExistingIndex != INDEX_NONE)
	{
		SessionItemOrder.RemoveAt(ExistingIndex);
	}
	SessionItemOrder.Insert(Item, 0);
	return true;
}

bool UPetSessionPanelWidget::TrimToSessionLimit()
{
	bool bTrimmed = false;
	while (SessionItemOrder.Num() > MaxSessionCount)
	{
		UPetSessionItem* RemovedItem = SessionItemOrder.Pop().Get();
		if (RemovedItem)
		{
			UnbindItem(RemovedItem);
			SessionItemsById.Remove(RemovedItem->SessionId);
		}
		bTrimmed = true;
	}
	return bTrimmed;
}
