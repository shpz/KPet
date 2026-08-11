#include "FunctionLibrary/PetHelperLibrary.h"

#include "Camera/CameraTypes.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "RHI.h"
#include "SceneView.h"

bool UPetHelperLibrary::ProjectWorldToPetCapture(
	USceneCaptureComponent2D* SceneCapture,
	FVector WorldLocation,
	FVector2D& PixelPosition)
{
	PixelPosition = FVector2D::ZeroVector;

	if (!IsValid(SceneCapture) || !IsValid(SceneCapture->TextureTarget))
	{
		return false;
	}

	const FIntPoint TargetSize(
		SceneCapture->TextureTarget->SizeX,
		SceneCapture->TextureTarget->SizeY);
	if (TargetSize.X <= 0 || TargetSize.Y <= 0)
	{
		return false;
	}

	FMinimalViewInfo ViewInfo;
	SceneCapture->GetCameraView(0.0f, ViewInfo);

	// 直接构造 SceneCapture 的视图矩阵，不能借用 PlayerController 的视口矩阵。
	const FMatrix ViewRotationMatrix = FInverseRotationMatrix(ViewInfo.Rotation) * FMatrix(
		FPlane(0, 0, 1, 0),
		FPlane(1, 0, 0, 0),
		FPlane(0, 1, 0, 0),
		FPlane(0, 0, 0, 1));
	const FMatrix ViewMatrix = FTranslationMatrix(-ViewInfo.Location) * ViewRotationMatrix;

	const FMatrix ProjectionMatrix = AdjustProjectionMatrixForRHI(
		SceneCapture->bUseCustomProjectionMatrix
			? SceneCapture->CustomProjectionMatrix
			: ViewInfo.CalculateProjectionMatrix());
	const FMatrix ViewProjectionMatrix = ViewMatrix * ProjectionMatrix;

	return FSceneView::ProjectWorldToScreen(
		WorldLocation,
		FIntRect(FIntPoint::ZeroValue, TargetSize),
		ViewProjectionMatrix,
		PixelPosition);
}
