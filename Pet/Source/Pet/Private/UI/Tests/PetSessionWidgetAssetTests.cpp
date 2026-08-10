#include "Misc/AutomationTest.h"

#if WITH_EDITOR && WITH_AUTOMATION_TESTS

#include "Blueprint/WidgetTree.h"
#include "Components/ListView.h"
#include "UI/Editor/PetSessionWidgetAssetLibrary.h"
#include "UI/PetSessionPanelWidget.h"
#include "UI/PetSessionRowWidget.h"
#include "UObject/UnrealType.h"
#include "WidgetBlueprint.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FPetSessionWidgetAssetsTest,
	"Pet.UI.Assets.SessionWidgets",
	EAutomationTestFlags_ApplicationContextMask | EAutomationTestFlags::ProductFilter)

bool FPetSessionWidgetAssetsTest::RunTest(const FString& Parameters)
{
	UWidgetBlueprint* RowBlueprint = LoadObject<UWidgetBlueprint>(
		nullptr,
		TEXT("/Game/UI/WBP_PetSessionRow.WBP_PetSessionRow"));
	UWidgetBlueprint* PanelBlueprint = LoadObject<UWidgetBlueprint>(
		nullptr,
		TEXT("/Game/UI/WBP_PetSessionPanel.WBP_PetSessionPanel"));
	TestNotNull(TEXT("行 Widget Blueprint 资产可加载"), RowBlueprint);
	TestNotNull(TEXT("面板 Widget Blueprint 资产可加载"), PanelBlueprint);
	if (!RowBlueprint || !PanelBlueprint)
	{
		return false;
	}

	TestTrue(TEXT("行资产继承 UPetSessionRowWidget"),
		RowBlueprint->ParentClass == UPetSessionRowWidget::StaticClass());
	TestTrue(TEXT("面板资产继承 UPetSessionPanelWidget"),
		PanelBlueprint->ParentClass == UPetSessionPanelWidget::StaticClass());
	TestNotNull(TEXT("行资产具有生成类"), RowBlueprint->GeneratedClass.Get());
	TestNotNull(TEXT("面板资产具有生成类"), PanelBlueprint->GeneratedClass.Get());

	const TArray<FName> RowWidgetNames = {
		TEXT("Button_Row"),
		TEXT("Text_Title"),
		TEXT("Text_SessionId"),
		TEXT("ActiveBar"),
		TEXT("WorkingDots"),
		TEXT("UnreadBubble")};
	for (const FName WidgetName : RowWidgetNames)
	{
		TestNotNull(
			*FString::Printf(TEXT("行资产包含控件 %s"), *WidgetName.ToString()),
			RowBlueprint->WidgetTree ? RowBlueprint->WidgetTree->FindWidget(WidgetName) : nullptr);
	}

	UListView* SessionsList = PanelBlueprint->WidgetTree
		? PanelBlueprint->WidgetTree->FindWidget<UListView>(TEXT("ListView_Sessions"))
		: nullptr;
	TestNotNull(TEXT("面板资产包含 ListView_Sessions"), SessionsList);
	TestNotNull(TEXT("面板资产包含 EmptyState"),
		PanelBlueprint->WidgetTree ? PanelBlueprint->WidgetTree->FindWidget(TEXT("EmptyState")) : nullptr);
	if (SessionsList)
	{
		TestTrue(TEXT("ListView 条目类指向生成的会话行"),
			SessionsList->GetEntryWidgetClass() == RowBlueprint->GeneratedClass);
	}

	TestTrue(TEXT("行资产的三组动画结构完整"),
		UPetSessionWidgetAssetLibrary::ValidateStandardAnimations(RowBlueprint));
	TestTrue(TEXT("面板内容动画结构完整"),
		UPetSessionWidgetAssetLibrary::ValidateStandardAnimations(PanelBlueprint));

	UClass* PawnGeneratedClass = LoadClass<UObject>(
		nullptr,
		TEXT("/Game/Blueprints/BP_PetCapturePawn.BP_PetCapturePawn_C"));
	TestNotNull(TEXT("BP_PetCapturePawn 生成类可加载"), PawnGeneratedClass);
	if (PawnGeneratedClass)
	{
		const FSoftClassProperty* PanelClassProperty = FindFProperty<FSoftClassProperty>(
			PawnGeneratedClass,
			TEXT("SessionPanelWidgetClass"));
		TestNotNull(TEXT("Pawn 具有 SessionPanelWidgetClass 软类属性"), PanelClassProperty);
		if (PanelClassProperty)
		{
			const FSoftObjectPtr PanelClassValue = PanelClassProperty->GetPropertyValue_InContainer(
				PawnGeneratedClass->GetDefaultObject());
			TestEqual(
				TEXT("Pawn 默认软类指向 WBP_PetSessionPanel"),
				PanelClassValue.ToSoftObjectPath().ToString(),
				FString(TEXT("/Game/UI/WBP_PetSessionPanel.WBP_PetSessionPanel_C")));
		}
	}

	return true;
}

#endif
