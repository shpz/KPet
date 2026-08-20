#pragma once

#include "CoreMinimal.h"
#include "Misc/Optional.h"

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

/**
 * 守护进程全量配置快照（config_snapshot，payload 与 bridge/src/protocol/types.ts 的
 * ConfigSnapshotPayload 一致）。hello 握手推送 snapshots 时带一条，每次 update_config
 * 生效后回推一条；渲染进程据此对齐本地设置与 WebUI。
 */
struct FPetSettingsSnapshot
{
	/** 打开会话目标：cli / web。 */
	FString OpenTarget = TEXT("cli");

	/** 面板主题：dark-glass / light-minimal / cute-pet。 */
	FString UiTheme = TEXT("dark-glass");

	/** 是否显示 FPS 监控叠加层并启停 WebUI 上报。 */
	bool bFpsMonitor = false;

	/** open_target=web 时的目标地址模板。 */
	FString OpenWebUrl;
};

/**
 * 设置 WebUI 下发的部分配置补丁（update_config，payload 与 UpdateConfigPayload 一致）。
 * 字段缺省表示本次不修改；至少需一个字段，否则守护进程回 protocol_error。
 */
struct FPetConfigPatch
{
	TOptional<FString> OpenTarget;
	TOptional<FString> UiTheme;
	TOptional<bool> FpsMonitor;
};
