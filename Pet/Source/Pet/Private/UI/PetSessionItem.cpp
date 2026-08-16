#include "UI/PetSessionItem.h"

void UPetSessionItem::InitializeFromSession(const FPetSessionInfo& Session)
{
	UpdateFromSession(Session);
}

void UPetSessionItem::UpdateFromSession(const FPetSessionInfo& Session)
{
	SetSessionData(
		Session.SessionId,
		Session.Title,
		Session.Cwd,
		Session.bActive,
		Session.bWorking,
		Session.bUnread);
}

void UPetSessionItem::SetSessionData(
	const FString& InSessionId,
	const FString& InTitle,
	const FString& InCwd,
	bool bInActive,
	bool bInWorking,
	bool bInUnread)
{
	// working 是 active 会话的子状态。快照字段异常或消息乱序时也不能让
	// 历史会话呈现为“灰色但仍在工作”的矛盾状态。
	const bool bNextWorking = bInActive && bInWorking;
	const bool bChanged =
		SessionId != InSessionId ||
		Title != InTitle ||
		Cwd != InCwd ||
		bActive != bInActive ||
		bWorking != bNextWorking ||
		bUnread != bInUnread;

	if (!bChanged)
	{
		return;
	}

	SessionId = InSessionId;
	Title = InTitle;
	Cwd = InCwd;
	bActive = bInActive;
	bWorking = bNextWorking;
	bUnread = bInUnread;

	OnChanged.Broadcast(this);
}

void UPetSessionItem::SetActive(bool bInActive)
{
	const bool bNextWorking = bInActive ? bWorking : false;
	if (bActive == bInActive && bWorking == bNextWorking)
	{
		return;
	}

	bActive = bInActive;
	// 已结束的会话不应继续显示工作中动画；即使它原本已经是 inactive，也要修正
	// 乱序 session_state 可能留下的 working 状态。未读仍由 Bridge 或点击行为决定。
	bWorking = bNextWorking;

	OnChanged.Broadcast(this);
}

void UPetSessionItem::SetWorking(bool bInWorking)
{
	const bool bNextWorking = bActive && bInWorking;
	if (bWorking == bNextWorking)
	{
		return;
	}

	bWorking = bNextWorking;
	OnChanged.Broadcast(this);
}

void UPetSessionItem::SetUnread(bool bInUnread)
{
	if (bUnread == bInUnread)
	{
		return;
	}

	bUnread = bInUnread;
	OnChanged.Broadcast(this);
}

void UPetSessionItem::NotifySelected()
{
	if (!HasSessionId())
	{
		return;
	}

	OnSelected.Broadcast(this);
}
