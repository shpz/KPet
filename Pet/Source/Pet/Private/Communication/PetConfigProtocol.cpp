#include "Communication/PetConfigProtocol.h"

#include "Dom/JsonObject.h"

namespace
{
	/** alloy：合法取值白名单检查，避免把守护进程的非法值透传给设置 WebUI。 */
	bool IsOpenTarget(const FString& Value)
	{
		return Value == TEXT("cli") || Value == TEXT("web");
	}

	bool IsUiTheme(const FString& Value)
	{
		return Value == TEXT("dark-glass") || Value == TEXT("light-minimal") || Value == TEXT("cute-pet");
	}
}

namespace PetConfigProtocol
{
	bool ParseConfigSnapshot(
		const TSharedPtr<FJsonObject>& Payload,
		FPetSettingsSnapshot& OutSnapshot)
	{
		if (!Payload.IsValid())
		{
			return false;
		}

		FPetSettingsSnapshot Snapshot;
		if (!Payload->TryGetStringField(TEXT("open_target"), Snapshot.OpenTarget) ||
			!IsOpenTarget(Snapshot.OpenTarget))
		{
			return false;
		}
		if (!Payload->TryGetStringField(TEXT("ui_theme"), Snapshot.UiTheme) ||
			!IsUiTheme(Snapshot.UiTheme))
		{
			return false;
		}
		if (!Payload->TryGetBoolField(TEXT("fps_monitor"), Snapshot.bFpsMonitor))
		{
			return false;
		}
		if (!Payload->TryGetStringField(TEXT("open_web_url"), Snapshot.OpenWebUrl))
		{
			return false;
		}

		OutSnapshot = MoveTemp(Snapshot);
		return true;
	}

	TSharedPtr<FJsonObject> BuildUpdateConfigPayload(const FPetConfigPatch& Patch)
	{
		TSharedPtr<FJsonObject> Payload = MakeShared<FJsonObject>();
		if (Patch.OpenTarget.IsSet())
		{
			Payload->SetStringField(TEXT("open_target"), Patch.OpenTarget.GetValue());
		}
		if (Patch.UiTheme.IsSet())
		{
			Payload->SetStringField(TEXT("ui_theme"), Patch.UiTheme.GetValue());
		}
		if (Patch.FpsMonitor.IsSet())
		{
			Payload->SetBoolField(TEXT("fps_monitor"), Patch.FpsMonitor.GetValue());
		}
		return Payload;
	}
}
