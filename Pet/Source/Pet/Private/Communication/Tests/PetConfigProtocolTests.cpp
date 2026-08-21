#include "Communication/PetConfigProtocol.h"
#include "Dom/JsonObject.h"
#include "Misc/AutomationTest.h"

#if WITH_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetConfigProtocolParseSnapshotTest,
	"Pet.Communication.ConfigProtocol.ParseConfigSnapshot",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetConfigProtocolParseSnapshotTest::RunTest(const FString& Parameters)
{
	// 合法完整快照。
	{
		TSharedPtr<FJsonObject> Payload = MakeShared<FJsonObject>();
		Payload->SetStringField(TEXT("open_target"), TEXT("web"));
		Payload->SetStringField(TEXT("ui_theme"), TEXT("cute-pet"));
		Payload->SetBoolField(TEXT("fps_monitor"), true);
		Payload->SetStringField(TEXT("open_web_url"), TEXT("http://127.0.0.1:58627/"));

		FPetSettingsSnapshot Snapshot;
		TestTrue(TEXT("解析合法快照成功"), PetConfigProtocol::ParseConfigSnapshot(Payload, Snapshot));
		TestEqual(TEXT("open_target"), Snapshot.OpenTarget, FString(TEXT("web")));
		TestEqual(TEXT("ui_theme"), Snapshot.UiTheme, FString(TEXT("cute-pet")));
		TestEqual(TEXT("fps_monitor"), Snapshot.bFpsMonitor, true);
		TestEqual(TEXT("open_web_url"), Snapshot.OpenWebUrl, FString(TEXT("http://127.0.0.1:58627/")));
	}

	// 非法取值（open_target 只能是 cli/web）应失败。
	{
		TSharedPtr<FJsonObject> Payload = MakeShared<FJsonObject>();
		Payload->SetStringField(TEXT("open_target"), TEXT("terminal"));
		Payload->SetStringField(TEXT("ui_theme"), TEXT("dark-glass"));
		Payload->SetBoolField(TEXT("fps_monitor"), false);
		Payload->SetStringField(TEXT("open_web_url"), TEXT(""));

		FPetSettingsSnapshot Snapshot;
		TestFalse(TEXT("非法 open_target 应失败"), PetConfigProtocol::ParseConfigSnapshot(Payload, Snapshot));
	}

	// 未知 ui_theme 应失败（设置 WebUI 只认三主题）。
	{
		TSharedPtr<FJsonObject> Payload = MakeShared<FJsonObject>();
		Payload->SetStringField(TEXT("open_target"), TEXT("cli"));
		Payload->SetStringField(TEXT("ui_theme"), TEXT("neon"));
		Payload->SetBoolField(TEXT("fps_monitor"), false);
		Payload->SetStringField(TEXT("open_web_url"), TEXT(""));

		FPetSettingsSnapshot Snapshot;
		TestFalse(TEXT("未知 ui_theme 应失败"), PetConfigProtocol::ParseConfigSnapshot(Payload, Snapshot));
	}

	// 缺字段应失败。
	{
		TSharedPtr<FJsonObject> Payload = MakeShared<FJsonObject>();
		Payload->SetStringField(TEXT("open_target"), TEXT("cli"));

		FPetSettingsSnapshot Snapshot;
		TestFalse(TEXT("缺字段应失败"), PetConfigProtocol::ParseConfigSnapshot(Payload, Snapshot));
	}

	// 空载荷应失败。
	{
		FPetSettingsSnapshot Snapshot;
		TestFalse(TEXT("空 payload 应失败"), PetConfigProtocol::ParseConfigSnapshot(nullptr, Snapshot));
	}

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetConfigProtocolBuildUpdateConfigTest,
	"Pet.Communication.ConfigProtocol.BuildUpdateConfigPayload",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetConfigProtocolBuildUpdateConfigTest::RunTest(const FString& Parameters)
{
	// 单字段补丁只写该字段。
	{
		FPetConfigPatch Patch;
		Patch.OpenTarget = TEXT("web");
		const TSharedPtr<FJsonObject> Payload = PetConfigProtocol::BuildUpdateConfigPayload(Patch);
		TestNotNull(TEXT("payload 非空"), Payload.Get());
		if (Payload.IsValid())
		{
			TestEqual(TEXT("单字段 open_target"), Payload->GetStringField(TEXT("open_target")), FString(TEXT("web")));
			TestTrue(TEXT("未提供的字段不写入"), !Payload->HasField(TEXT("ui_theme")));
			TestTrue(TEXT("未提供的字段不写入 fps"), !Payload->HasField(TEXT("fps_monitor")));
		}
	}

	// 三字段全写。
	{
		FPetConfigPatch Patch;
		Patch.OpenTarget = TEXT("cli");
		Patch.UiTheme = TEXT("light-minimal");
		Patch.FpsMonitor = true;
		const TSharedPtr<FJsonObject> Payload = PetConfigProtocol::BuildUpdateConfigPayload(Patch);
		TestNotNull(TEXT("payload 非空"), Payload.Get());
		if (Payload.IsValid())
		{
			TestEqual(TEXT("open_target"), Payload->GetStringField(TEXT("open_target")), FString(TEXT("cli")));
			TestEqual(TEXT("ui_theme"), Payload->GetStringField(TEXT("ui_theme")), FString(TEXT("light-minimal")));
			TestEqual(TEXT("fps_monitor"), Payload->GetBoolField(TEXT("fps_monitor")), true);
		}
	}

	// 空补丁：payload 为空对象（守护进程会回 protocol_error）。
	{
		const TSharedPtr<FJsonObject> Payload = PetConfigProtocol::BuildUpdateConfigPayload(FPetConfigPatch());
		TestTrue(TEXT("空补丁产出空对象"), Payload.IsValid() && Payload->Values.Num() == 0);
	}

	return true;
}

#endif
