#include "UI/Editor/PetSessionWidgetAssetLibrary.h"

#if WITH_EDITOR

#include "Animation/WidgetAnimation.h"
#include "Animation/WidgetAnimationBinding.h"
#include "Channels/MovieSceneFloatChannel.h"
#include "Components/Widget.h"
#include "Engine/Blueprint.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "MovieScene.h"
#include "Sections/MovieSceneFloatSection.h"
#include "Tracks/MovieSceneFloatTrack.h"
#include "UObject/UnrealType.h"
#include "WidgetBlueprint.h"
#include "Blueprint/WidgetTree.h"

namespace
{
	struct FPetAnimationKey
	{
		int32 Frame = 0;
		float Value = 1.0f;
	};

	bool AddOpacityAnimation(
		UWidgetBlueprint& Blueprint,
		const FName AnimationName,
		const FName WidgetName,
		const TArray<FPetAnimationKey>& Keys)
	{
		if (!Blueprint.WidgetTree || Keys.Num() < 2)
		{
			return false;
		}

		UWidget* TargetWidget = Blueprint.WidgetTree->FindWidget(WidgetName);
		if (!TargetWidget)
		{
			UE_LOG(LogTemp, Error, TEXT("会话面板资产生成：动画 %s 找不到控件 %s"),
				*AnimationName.ToString(), *WidgetName.ToString());
			return false;
		}

		Blueprint.Animations.RemoveAll([AnimationName](const UWidgetAnimation* ExistingAnimation)
		{
			return ExistingAnimation && ExistingAnimation->GetFName() == AnimationName;
		});

		UWidgetAnimation* Animation = NewObject<UWidgetAnimation>(
			&Blueprint,
			AnimationName,
			RF_Transactional);
		if (!Animation)
		{
			return false;
		}

		Animation->SetDisplayLabel(AnimationName.ToString());
		Animation->MovieScene = NewObject<UMovieScene>(Animation, AnimationName, RF_Transactional);
		if (!Animation->MovieScene)
		{
			return false;
		}

		constexpr int32 FramesPerSecond = 60;
		const int32 LastFrame = Keys.Last().Frame;
		Animation->MovieScene->SetDisplayRate(FFrameRate(FramesPerSecond, 1));
		Animation->MovieScene->SetTickResolutionDirectly(FFrameRate(FramesPerSecond, 1));
		Animation->MovieScene->SetPlaybackRange(
			TRange<FFrameNumber>(FFrameNumber(0), FFrameNumber(LastFrame + 1)));

		const FGuid AnimationGuid = Animation->MovieScene->AddPossessable(
			TargetWidget->GetName(),
			TargetWidget->GetClass());
		if (!AnimationGuid.IsValid())
		{
			return false;
		}

		FWidgetAnimationBinding& WidgetBinding = Animation->AnimationBindings.AddDefaulted_GetRef();
		WidgetBinding.WidgetName = TargetWidget->GetFName();
		WidgetBinding.AnimationGuid = AnimationGuid;
		WidgetBinding.bIsRootWidget = Blueprint.WidgetTree->RootWidget == TargetWidget;

		UMovieSceneFloatTrack* OpacityTrack =
			Animation->MovieScene->AddTrack<UMovieSceneFloatTrack>(AnimationGuid);
		if (!OpacityTrack)
		{
			return false;
		}
		OpacityTrack->SetPropertyNameAndPath(TEXT("RenderOpacity"), TEXT("RenderOpacity"));

		UMovieSceneFloatSection* OpacitySection =
			Cast<UMovieSceneFloatSection>(OpacityTrack->CreateNewSection());
		if (!OpacitySection)
		{
			return false;
		}
		OpacityTrack->AddSection(*OpacitySection);
		OpacitySection->SetRange(
			TRange<FFrameNumber>(FFrameNumber(0), FFrameNumber(LastFrame + 1)));

		FMovieSceneFloatChannel& OpacityChannel = OpacitySection->GetChannel();
		for (const FPetAnimationKey& Key : Keys)
		{
			OpacityChannel.AddCubicKey(FFrameNumber(Key.Frame), Key.Value, RCTM_Auto);
		}

		Blueprint.Animations.Add(Animation);
		return true;
	}

	bool HasCompleteAnimation(const UWidgetBlueprint& Blueprint, const FName AnimationName)
	{
		const TObjectPtr<UWidgetAnimation>* FoundAnimation = Blueprint.Animations.FindByPredicate(
			[AnimationName](const UWidgetAnimation* Animation)
			{
				return Animation && Animation->GetFName() == AnimationName;
			});
		if (!FoundAnimation || !FoundAnimation->Get())
		{
			UE_LOG(LogTemp, Error, TEXT("会话面板资产校验：缺少动画 %s"), *AnimationName.ToString());
			return false;
		}

		const UWidgetAnimation* Animation = FoundAnimation->Get();
		const UMovieScene* MovieScene = Animation->GetMovieScene();
		const FGuid BoundGuid = Animation->GetBindings().IsEmpty()
			? FGuid()
			: Animation->GetBindings()[0].AnimationGuid;
		const bool bComplete = MovieScene &&
			!Animation->GetBindings().IsEmpty() &&
			MovieScene->GetPossessableCount() > 0 &&
			BoundGuid.IsValid() &&
			MovieScene->FindTrack<UMovieSceneFloatTrack>(BoundGuid) != nullptr;
		if (!bComplete)
		{
			UE_LOG(LogTemp, Error, TEXT("会话面板资产校验：动画 %s 缺少 MovieScene、控件绑定或属性轨道"),
				*AnimationName.ToString());
		}
		return bComplete;
	}
}

#endif

UObject* UPetSessionWidgetAssetLibrary::GetWidgetTree(UObject* WidgetBlueprintObject)
{
#if WITH_EDITOR
	UWidgetBlueprint* Blueprint = Cast<UWidgetBlueprint>(WidgetBlueprintObject);
	return Blueprint ? Blueprint->WidgetTree.Get() : nullptr;
#else
	return nullptr;
#endif
}

bool UPetSessionWidgetAssetLibrary::SetRootWidget(UObject* WidgetBlueprintObject, UObject* RootWidgetObject)
{
#if WITH_EDITOR
	UWidgetBlueprint* Blueprint = Cast<UWidgetBlueprint>(WidgetBlueprintObject);
	UWidget* RootWidget = Cast<UWidget>(RootWidgetObject);
	if (!Blueprint || !Blueprint->WidgetTree || !RootWidget || RootWidget->GetOuter() != Blueprint->WidgetTree)
	{
		return false;
	}

	Blueprint->Modify();
	Blueprint->WidgetTree->Modify();
	Blueprint->WidgetTree->RootWidget = RootWidget;
	return true;
#else
	return false;
#endif
}

bool UPetSessionWidgetAssetLibrary::ConfigurePawnSessionPanelClass(
	UObject* PawnBlueprintObject,
	UObject* PanelBlueprintObject)
{
#if WITH_EDITOR
	UBlueprint* PawnBlueprint = Cast<UBlueprint>(PawnBlueprintObject);
	UWidgetBlueprint* PanelBlueprint = Cast<UWidgetBlueprint>(PanelBlueprintObject);
	if (!PawnBlueprint || !PawnBlueprint->GeneratedClass ||
		!PanelBlueprint || !PanelBlueprint->GeneratedClass)
	{
		UE_LOG(LogTemp, Error, TEXT("会话面板资产生成：Pawn 或 Panel Blueprint 没有生成类"));
		return false;
	}

	UObject* PawnDefaultObject = PawnBlueprint->GeneratedClass->GetDefaultObject();
	FSoftClassProperty* SessionPanelClassProperty = FindFProperty<FSoftClassProperty>(
		PawnBlueprint->GeneratedClass,
		TEXT("SessionPanelWidgetClass"));
	if (!PawnDefaultObject || !SessionPanelClassProperty)
	{
		UE_LOG(LogTemp, Error, TEXT("会话面板资产生成：Pawn CDO 缺少软类属性 SessionPanelWidgetClass"));
		return false;
	}

	PawnBlueprint->Modify();
	PawnDefaultObject->Modify();
	SessionPanelClassProperty->SetPropertyValue_InContainer(
		PawnDefaultObject,
		FSoftObjectPtr(PanelBlueprint->GeneratedClass));
	FBlueprintEditorUtils::MarkBlueprintAsModified(PawnBlueprint);
	return true;
#else
	return false;
#endif
}

bool UPetSessionWidgetAssetLibrary::AddStandardAnimations(UObject* WidgetBlueprintObject)
{
#if WITH_EDITOR
	UWidgetBlueprint* Blueprint = Cast<UWidgetBlueprint>(WidgetBlueprintObject);
	if (!Blueprint || !Blueprint->WidgetTree)
	{
		UE_LOG(LogTemp, Error, TEXT("会话面板资产生成：参数不是有效的 Widget Blueprint"));
		return false;
	}

	Blueprint->Modify();
	bool bSucceeded = false;
	if (Blueprint->WidgetTree->FindWidget(TEXT("ListView_Sessions")))
	{
		bSucceeded = AddOpacityAnimation(
			*Blueprint,
			TEXT("Anim_PanelEnter"),
			TEXT("Border_Root"),
			{{0, 0.65f}, {12, 1.0f}});
	}
	else if (Blueprint->WidgetTree->FindWidget(TEXT("Button_Row")))
	{
		bSucceeded =
			AddOpacityAnimation(
				*Blueprint,
				TEXT("Anim_WorkingDots"),
				TEXT("WorkingDots"),
				{{0, 0.35f}, {24, 1.0f}, {48, 0.35f}}) &&
			AddOpacityAnimation(
				*Blueprint,
				TEXT("Anim_UnreadBubble"),
				TEXT("UnreadBubble"),
				{{0, 0.60f}, {30, 1.0f}, {60, 0.60f}}) &&
			AddOpacityAnimation(
				*Blueprint,
				TEXT("Anim_RowEnter"),
				TEXT("Button_Row"),
				{{0, 0.0f}, {12, 1.0f}});
	}
	else
	{
		UE_LOG(LogTemp, Error, TEXT("会话面板资产生成：无法识别 Blueprint 类型"));
		return false;
	}

	if (bSucceeded)
	{
		FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	}
	return bSucceeded;
#else
	return false;
#endif
}

bool UPetSessionWidgetAssetLibrary::ValidateStandardAnimations(UObject* WidgetBlueprintObject)
{
#if WITH_EDITOR
	const UWidgetBlueprint* Blueprint = Cast<UWidgetBlueprint>(WidgetBlueprintObject);
	if (!Blueprint || !Blueprint->WidgetTree)
	{
		return false;
	}

	if (Blueprint->WidgetTree->FindWidget(TEXT("ListView_Sessions")))
	{
		return HasCompleteAnimation(*Blueprint, TEXT("Anim_PanelEnter"));
	}
	if (Blueprint->WidgetTree->FindWidget(TEXT("Button_Row")))
	{
		return HasCompleteAnimation(*Blueprint, TEXT("Anim_WorkingDots")) &&
			HasCompleteAnimation(*Blueprint, TEXT("Anim_UnreadBubble")) &&
			HasCompleteAnimation(*Blueprint, TEXT("Anim_RowEnter"));
	}
	return false;
#else
	return false;
#endif
}
