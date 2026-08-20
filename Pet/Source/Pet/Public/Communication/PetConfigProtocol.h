#pragma once

#include "CoreMinimal.h"
#include "Communication/PetSessionTypes.h"

class FJsonObject;

/**
 * config_snapshot / update_config 的无平台 JSON 解析与组装。
 *
 * 纯逻辑函数不触碰管道与平台 API，供 FPetControlClient 与自动化测试共同使用
 *（与 PetWorkStateLogic、PetSessionWindowHostLayout 先例一致）。
 */
namespace PetConfigProtocol
{
	/**
	 * 解析 config_snapshot 的 payload。字段缺失、类型非法或取值非法时返回 false，
	 * 调用方按协议记日志并忽略本条。
	 */
	bool ParseConfigSnapshot(
		const TSharedPtr<FJsonObject>& Payload,
		FPetSettingsSnapshot& OutSnapshot);

	/**
	 * 组装 update_config 的 payload：只写入补丁中已提供的字段，缺省字段不出现。
	 */
	TSharedPtr<FJsonObject> BuildUpdateConfigPayload(const FPetConfigPatch& Patch);
}
