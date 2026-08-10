# Slate 与 UMG 会话面板迁移方案

> 日期：2026-08-10  
> 适用环境：UE 5.8、Windows 11、Mac  
> 方案范围：迁移会话面板，并调整 UE 渲染进程的窗口启动方式。宠物本体、场景捕获、摄像机操作和 Bridge 会话协议保持不变。  
> 核心约束：项目代码不直接调用 Win32、AppKit 或其他原生 GUI 接口。

## 1. 结论

会话面板可以使用纯 Slate 与 UMG 实现，不需要在项目层增加任何 Windows 或 Mac 原生窗口补丁。

目标结构如下：

~~~text
PetLayeredWindow
  └─ 本次保持现状，继续负责宠物本体

APetCapturePawn
  ├─ 接收 Bridge 会话状态
  ├─ 直接更新 UPetSessionPanelWidget 的公开数据接口
  ├─ 接收 Widget 的会话选择委托
  └─ 持有 FPetSessionWindowHost
       └─ 只管理 SWindow 的创建、销毁、显隐、位置和窗口动画

UPetSessionPanelWidget
  ├─ UListView 会话列表
  ├─ 空状态与内容动画
  └─ UPetSessionRowWidget
       ├─ 激活与未激活样式
       ├─ 工作中三点动画
       └─ 新回复气泡动画
~~~

方案采用以下原则：

1. Slate 负责系统窗口、渲染和输入路由。
2. UMG 负责面板内容、列表和控件动画。
3. 不取得系统窗口句柄，不修改窗口原生样式，不调用原生定位或窗口区域接口。
4. Window Host 不进入会话数据链路，避免形成厚转发层。
5. Windows 和 Mac 共用同一套窗口与 Widget 实现。
6. 不修改 UE 源码，也不依赖自编译引擎。

实施前必须接受两个公开 Slate 接口带来的产品边界：

- 面板自行显示时不抢夺当前前台应用焦点；用户主动点击面板后，Windows 允许激活 KimiPet。
- 窗口按矩形外形和矩形命中区验收；UMG 可以绘制内部圆角，但不承诺透明圆角外部穿透。

## 2. 迁移目标与范围

### 2.1 必须保持的能力

1. 点击宠物打开或关闭会话面板。
2. 显示 Kimi Code CLI 最近会话，每个会话占一行。
3. 活跃会话与历史会话有明显视觉区别。
4. working 为 true 时显示三点动画。
5. unread 为 true 时显示新回复气泡动画。
6. 点击会话向 Bridge 发送准确的 session_id，然后播放关闭动画。
7. 面板打开和关闭包含淡入淡出与短距离滑动。
8. 面板置顶，不作为独立窗口出现在任务栏或窗口切换列表中。
9. 面板自行显示和更新时不抢夺当前前台应用焦点。
10. Windows 与 Mac 的多显示器、负坐标桌面和 DPI 缩放下仍能正确定位。
11. 不影响宠物拖拽、R 加左键旋转、R 加滚轮缩放和宠物透明区域输入。

### 2.2 明确调整的验收语义

#### 焦点

EWindowActivationPolicy::Never 只控制窗口显示时是否激活，不代表窗口永远不能激活。

本方案的焦点语义为：

- 程序自动打开、更新或移动面板时，不切走用户当前应用。
- 用户主动点击会话、按钮或其他可交互内容时，允许 KimiPet 被系统激活。
- 点击会话后会立即请求打开对应 TUI，因此不再要求点击过程始终保持原前台应用焦点。

如果未来重新要求“点击可交互内容但应用绝不激活”，必须单独评估平台原生能力；该要求不属于本纯 Slate 方案。

#### 窗口外形

本方案使用 EWindowTransparency::PerWindow 完成整个窗口的透明度动画，但不依赖逐像素透明。

因此：

- 操作系统窗口及命中区域按矩形处理。
- UMG 可以在矩形内部绘制圆角卡片、描边和内阴影。
- 不验收透明圆角之外的鼠标穿透。
- 不实现窗口外柔和阴影或第二个装饰窗口。

### 2.3 为后续互动预留的能力

- 会话搜索、筛选、置顶、重命名和右键菜单。
- 会话详情、任务进度、工具调用列表和错误状态。
- 多页面、设置页、确认弹窗和通知中心。
- UMG 编辑器内调整布局、样式与动画。
- 列表项复用和大量会话下的虚拟化。
- 需要文本输入时，由明确用户操作进入可激活的 Slate 交互流程。

### 2.4 本次不处理

- 不迁移宠物本体的逐像素透明分层窗口。
- 不改变 open_tui 等既有消息的载荷语义；sessions_snapshot 与 session_state 为本次迁移新增的消息。
- 不把 Bridge 的业务状态迁入 UMG。
- 不修改引擎源码。
- 不为会话面板新增 Windows 和 Mac 两套平台后端。
- 不解决整个项目现有的 Mac 编译问题。

最后一项需要特别说明：当前 PetLayeredWindow、PetControlClient 和部分 Pawn 代码仍包含 Windows 专用实现。会话面板做到平台无关，不代表整个项目已经可以直接在 Mac 打包；Mac 主工程基线需要单独完成。本方案要求会话面板本身不再增加新的平台障碍。

## 3. 调研结论

### 3.1 RenderOffScreen 与可见 SWindow 冲突

当前 Bridge 使用 RenderOffScreen 启动渲染进程。

UE 5.8 中，FSlateApplication::MakeWindow 在 RenderOffScreen 模式下不会创建真实平台窗口，而是给每个 SWindow 绑定一个普通 FGenericWindow，并只创建渲染视口。

这意味着：

- RenderOffScreen 不是“只隐藏默认游戏窗口”。
- 它会影响同一 SlateApplication 中后续创建的所有 SWindow。
- 会话面板即使成功 AddWindow，也没有真实 Windows 或 Mac 窗口可以显示。
- 该问题不能通过给会话面板补原生样式解决。

因此迁移的前置条件是移除 RenderOffScreen。

### 3.2 默认游戏窗口可以通过公开 Slate 接口隐藏

UGameEngine::CreateGameWindow 的关键顺序为：

1. 创建默认 SWindow。
2. AddWindow，但暂不显示。
3. 调用 SWindow::ShowWindow。
4. 立即调用 FSlateApplication::Tick。

项目默认模块在 GEngine 初始化之前已经加载，因此可以在 FPetModule::StartupModule 中提前注册 FSlateApplication::OnPreTick。

OnPreTick 发生在 Slate 当次绘制之前。启动守卫可以在该回调中发现默认游戏窗口，并调用 SWindow::HideWindow。

UGameEngine 首次 Tick 还会再次显示默认窗口，所以守卫必须覆盖这次显示；第二次隐藏完成后即可注销，不需要永久每帧运行。

整个过程只使用以下 UE 公开接口：

- FSlateApplication::OnPreTick
- FSlateApplication::GetTopLevelWindows
- SWindow::IsRegularWindow
- SWindow::IsVisible
- SWindow::HideWindow

不需要：

- GetNativeWindow
- GetOSWindowHandle
- ShowWindow
- HWND
- NSWindow
- 自定义 GameEngine

### 3.3 启动闪窗边界

公开 Slate 接口能够保证默认窗口在第一次 Slate 绘制之前被隐藏，但不能从接口语义上保证系统合成器从未观察到 ShowWindow 与 HideWindow 之间的极短可见状态。

本方案采用以下控制措施：

1. 使用 NOSPLASH 禁止 Windows 和 Mac 平台启动图。
2. 默认游戏窗口使用最小无边框窗口尺寸作为安全兜底。
3. OnPreTick 守卫在首个 Slate 绘制前隐藏窗口。
4. Windows 和 Mac 打包版本都进行启动录像验证。
5. 若仍有可感知闪窗，停止正式迁移并重新评估 UE 启动架构，不回退到项目层原生窗口调用。

### 3.4 UE 5.8 可直接使用的窗口能力

SWindow 和 FSlateApplication 已公开提供本方案所需能力：

- AddWindow 与 RequestDestroyWindow
- MoveWindowTo、ReshapeWindow 和 Resize
- ShowWindow 与 HideWindow
- SetOpacity
- IsPopupWindow
- IsTopmostWindow
- FocusWhenFirstShown
- ActivationPolicy
- SupportsTransparency
- GetWorkArea 与显示器配置变化通知

窗口创建、显隐、移动、尺寸、整体透明度和输入路由都应停留在这组接口内。

### 3.5 Windows 与 Mac 的平台映射

| 需求 | Windows | Mac | 本方案做法 |
|---|---|---|---|
| 普通窗口之上 | IsTopmostWindow 映射到置顶样式 | 窗口等级主要由 EWindowType 决定 | 使用 Notification 类型并同时设置 IsTopmostWindow |
| 不出现在窗口切换列表 | Popup 映射为工具窗口 | Popup 使用 Transient 与 IgnoresCycle | IsPopupWindow 为 true |
| 显示时不激活 | ActivationPolicy 映射为无激活显示 | ActivationPolicy 映射为只置前不激活 | ActivationPolicy 使用 Never |
| 鼠标输入 | Slate 正常路由 | Slate 正常路由 | AcceptsInput 保持默认 true |
| 整窗淡入淡出 | PerWindow | PerWindow | 只使用 PerWindow |

Mac 实现中，Normal 类型使用普通窗口等级；Notification 类型使用更高的通知窗口等级。因此会话面板不能继续使用原方案中的 EWindowType::Normal。

### 3.6 点击不激活的公开接口边界

Windows 显示窗口时，ActivationPolicy::Never 会走不激活显示。但是当用户点击一个当前未激活的窗口时，系统会发送 WM_MOUSEACTIVATE。

UE 5.8 的 Windows 消息处理会记录该消息，随后仍交给 DefWindowProc。公开 SWindow 没有“接受点击但永不激活”的跨平台参数。

因此不能把以下两句话视为等价：

- 面板显示时不抢焦点。
- 用户点击面板后仍不激活应用。

本方案只承诺第一条。

### 3.7 不能依赖逐像素透明

EWindowTransparency::PerPixel 受 ALPHA_BLENDED_WINDOWS 编译开关限制。UE 5.8 默认只在 Editor 或 Program 构建中开启，普通游戏发行目标不能把它作为交付能力。

本方案禁止：

- 把 Editor 中的 PerPixel 表现当作发行版依据。
- 假设 UMG 透明像素会自动穿透到桌面。
- 为了圆角调用 SetWindowRgn 或对应的 AppKit 接口。
- 创建第二个原生装饰窗口实现阴影。

### 3.8 源码核对位置

本次结论基于 UE 5.8 以下实现：

~~~text
Engine/Source/Runtime/Slate/Private/Framework/Application/SlateApplication.cpp
  FSlateApplication::MakeWindow
  FSlateApplication::TickAndDrawWidgets

Engine/Source/Runtime/Engine/Private/GameEngine.cpp
  UGameEngine::CreateGameWindow
  UGameEngine::Init
  UGameEngine::Tick

Engine/Source/Runtime/ApplicationCore/Public/GenericPlatform/GenericWindowDefinition.h
  ALPHA_BLENDED_WINDOWS
  EWindowActivationPolicy

Engine/Source/Runtime/ApplicationCore/Private/Windows/WindowsWindow.cpp
  FWindowsWindow::Show
  窗口样式创建

Engine/Source/Runtime/ApplicationCore/Private/Windows/WindowsApplication.cpp
  WM_MOUSEACTIVATE 处理

Engine/Source/Runtime/ApplicationCore/Private/Mac/MacWindow.cpp
  窗口等级与显示策略

Engine/Source/Runtime/ApplicationCore/Private/Mac/CocoaWindow.cpp
  Notification 窗口的主窗口与键盘窗口资格

Engine/Source/Runtime/ApplicationCore/Private/Mac/CocoaTextView.cpp
  acceptsFirstMouse
~~~

## 4. 目标架构

### 4.1 数据流

~~~text
Bridge 消息
   │
   ├─ sessions_snapshot
   ├─ session_start 与 session_end
   └─ session_state
   │
APetCapturePawn
   │
   ├─────────────── 更新会话数据 ───────────────┐
   │                                             ▼
   │                              UPetSessionPanelWidget
   │                                             │
   │                                      更新 UListView
   │                                             ▼
   │                               UPetSessionRowWidget
   │                                             │
   └── 接收 OnSessionSelected ◀──────────────────┘
                 │
                 ▼
       FPetControlClient::SendOpenTui

APetCapturePawn
   │
   └─ 仅把显隐与锚点命令交给 FPetSessionWindowHost
                                      │
                                      ▼
                                   SWindow
~~~

会话数据不经过 Window Host。

### 4.2 职责边界

| 组件 | 职责 | 禁止承担的职责 |
|---|---|---|
| APetCapturePawn | 接收协议回调、持有 Widget、调用 Widget 公开数据接口、处理选择结果 | 不直接操作 ListView 或行控件 |
| FPetSessionWindowHost | SWindow 生命周期、显隐、锚点、尺寸和外层动画 | 不保存会话数据，不创建视图模型，不转发逐条状态 |
| UPetSessionPanelWidget | 快照与增量更新、列表、空状态和内容动画 | 不访问命名管道，不操作 SWindow |
| UPetSessionRowWidget | 单行展示、状态动画和点击事件 | 不决定业务状态，不操作窗口 |
| UPetSessionItem | UListView 所需的单条 UObject 数据 | 不持有窗口、Pawn 或网络对象 |
| FPetControlClient | 协议收发 | 不依赖 Slate 或 UMG |

### 4.3 防止转发层变厚的约束

FPetSessionWindowHost 只允许提供窗口级接口：

- Create
- Destroy
- Toggle
- Close
- TickWindowAnimation
- UpdateAnchor
- IsVisible

Host 不得增加以下接口：

- ApplySnapshot
- AddOrUpdateSession
- SetSessionActive
- UpdateSessionState
- OnSessionSelected

这些数据和事件属于 Widget 与 Pawn 之间的直接协作。

## 5. UE 启动窗口方案

### 5.1 启动参数

Bridge 启动渲染进程时必须移除 RenderOffScreen。

推荐的最小参数为：

~~~text
-NOSPLASH
-windowed
-ResX=16
-ResY=16
~~~

其中：

- NOSPLASH 阻止 Windows 和 Mac 平台启动图。
- 最小分辨率只用于降低默认游戏窗口异常可见时的影响。
- 实际宠物 SceneCapture 的分辨率和渲染目标不依赖该窗口尺寸。

正式参数以阶段 0 打包验证结果为准，但不得重新加入 RenderOffScreen。

### 5.2 启动窗口守卫

在 FPetModule 中实现短生命周期的纯 Slate 启动守卫：

1. StartupModule 确认非 Editor 且 FSlateApplication 已初始化。
2. 记录模块加载时已经存在的顶层 SWindow。
3. 绑定 OnPreTick。
4. 在后续顶层窗口中识别新建的常规游戏窗口，保存为弱引用。
5. 如果目标窗口可见，调用 SWindow::HideWindow。
6. GEngine 和 GameViewport 可用后，用 GameViewport::GetWindow 校准目标引用。
7. 覆盖 UGameEngine 首次 Tick 的再次显示并第二次隐藏。
8. 确认引擎不会再次自动显示后，立即解绑 OnPreTick。
9. ShutdownModule 中无条件移除仍然有效的委托句柄。

识别窗口时不能依赖系统标题枚举或系统窗口句柄。会话窗口使用 Notification 与 Popup，不属于常规游戏窗口，不会被启动守卫误隐藏。

### 5.3 SceneCapture 验证

项目已有验证表明，隐藏默认游戏窗口后 SceneCapture 和纹理读回可以继续工作。本次改动仍必须重新验证：

- 宠物捕获帧持续更新。
- GPU 读回没有停止。
- 分层宠物窗口继续刷新。
- 会话 SWindow 显示后两个渲染路径可以同时工作。

## 6. Slate 窗口设计

### 6.1 推荐创建参数

窗口由 FPetSessionWindowHost 在游戏线程创建：

~~~cpp
const FVector2f PanelDesignSize(360.0f, 234.0f);

SAssignNew(SessionWindow, SWindow)
    .Type(EWindowType::Notification)
    .Title(FText::FromString(TEXT("KimiPet 会话")))
    .IsPopupWindow(true)
    .AutoCenter(EAutoCenter::None)
    .IsTopmostWindow(true)
    .UseOSWindowBorder(false)
    .CreateTitleBar(false)
    .HasCloseButton(false)
    .SupportsMinimize(false)
    .SupportsMaximize(false)
    .SupportsTransparency(EWindowTransparency::PerWindow)
    .InitialOpacity(0.0f)
    .SizingRule(ESizingRule::FixedSize)
    .FocusWhenFirstShown(false)
    .ActivationPolicy(EWindowActivationPolicy::Never)
    .AdjustInitialSizeAndPositionForDPIScale(true)
    .ClientSize(PanelDesignSize);

SessionWindow->SetContent(SessionPanelWidget->TakeWidget());
FSlateApplication::Get().AddWindow(SessionWindow.ToSharedRef(), false);
SessionWindow->MoveWindowTo(InitialPositionInSlateScreen);
~~~

创建规则：

- 先设置内容和委托，再显示窗口。
- AddWindow 使用 false，避免未完成的内容提前出现。
- 不调用 GetNativeWindow 或 GetOSWindowHandle。
- 不补任何 Windows 或 Mac 样式。
- 不把会话窗口作为宠物原生窗口的子窗口。

### 6.2 窗口类型选择

必须同时使用：

- EWindowType::Notification
- IsPopupWindow 为 true
- IsTopmostWindow 为 true
- ActivationPolicy 为 Never
- FocusWhenFirstShown 为 false

原因：

- Windows 通过 IsTopmostWindow 获得置顶行为。
- Mac 通过 Notification 类型获得高于普通窗口的窗口等级。
- Popup 在 Windows 不创建独立任务栏按钮，在 Mac 不加入普通窗口循环。
- Never 保证显示时不主动激活。

### 6.3 外形、透明与命中

正式发行版只使用 PerWindow：

1. UMG 根背景填满整个矩形窗口。
2. Host 使用 SWindow::SetOpacity 控制整窗淡入淡出。
3. UMG 可以在内部绘制圆角卡片，但窗口命中区保持矩形。
4. 关闭动画结束后立即 HideWindow，避免透明窗口继续挡住桌面。
5. 不创建窗口区域，不做透明像素命中测试。

### 6.4 位置跟随与坐标契约

Host 接收统一的 Slate 屏幕坐标，不直接理解 Windows 物理像素或 Mac 坐标系：

~~~cpp
void UpdateAnchor(const FSlateRect& PetBoundsInSlateScreen);
~~~

坐标转换规则：

1. 当前 Windows PetLayeredWindow 的位置在进入 Host 前，通过 UE 的 FDisplayMetrics 和 FPlatformApplicationMisc 转换到 Slate 屏幕坐标。
2. 未来 Mac 宠物窗口实现也必须提供相同的 Slate 屏幕坐标契约。
3. Host 使用 FSlateApplication 的工作区信息决定目标显示器。
4. Host 只调用 SWindow::MoveWindowTo、Resize 或 ReshapeWindow。
5. 不调用 SetWindowPos 或 AppKit 对应接口。
6. 布局计算提取为无平台依赖的纯函数，并覆盖负坐标与跨 DPI 单元测试。

定位规则保持当前产品行为：

1. 默认放在宠物右侧，间距为 10 个 Slate 屏幕单位。
2. 右侧空间不足且左侧更宽时改放左侧。
3. X 和 Y 都约束在目标显示器工作区内。
4. 宠物拖动、面板高度变化、显示器变化或 DPI 变化时重新计算。
5. 目标位置变化不足一个屏幕单位时不移动窗口。
6. 窗口完全隐藏时不需要持续更新位置。

禁止在同一计算中混用以下单位：

- 宠物原生物理像素
- UMG 设计尺寸
- Slate 屏幕坐标
- DPI 缩放后的窗口尺寸

转换只允许发生在坐标契约边界，并需要用命名明确的局部变量表示。

### 6.5 打开与关闭动画

动画分为两层：

- Host 使用 SetOpacity 和 MoveWindowTo 完成整窗淡入淡出与短距离滑动。
- UMG 负责行出现、工作三点和新回复气泡等内容动画。

Host 只维护窗口级四态：

~~~text
Hidden → Opening → Visible → Closing → Hidden
~~~

规则：

- Opening 期间再次点击宠物，从当前进度反向进入 Closing。
- Closing 期间再次点击宠物，从当前进度反向进入 Opening。
- 关闭动画结束后调用 HideWindow。
- 点击会话先广播选择结果，再进入 Closing。
- 窗口动画不携带任何会话数据。

### 6.6 焦点与未来文本输入

当前版本不实现“被动模式”和“输入模式”的原生样式切换。

未来加入搜索、重命名或输入法时：

1. 由明确的用户操作进入输入流程。
2. 使用 Slate 自身焦点和窗口激活能力。
3. 如果 Notification 窗口不适合键盘输入，创建正常的可激活 Slate 交互窗口。
4. 不动态增删 Windows 样式。
5. 不调用 AppKit 激活接口。
6. 不使用全局键盘 Hook 模拟 UMG 输入。

### 6.7 Mac Dock 与应用切换器

Popup 可以控制会话窗口本身不进入普通窗口循环，但 Mac Dock 图标属于应用级行为，不是单个 SWindow 属性。

如果产品要求 KimiPet 不出现在 Dock 或 Command 加 Tab 中，应通过 UE 打包使用的 Info.plist 声明代理应用属性，例如 LSUIElement。该配置属于平台打包配置，不在运行时调用 AppKit。

此项应作为 Mac 应用打包任务处理，不能塞进 FPetSessionWindowHost。

## 7. UMG 结构设计

### 7.1 UPetSessionItem

继承 UObject，字段使用 BlueprintReadOnly：

- SessionId
- Title
- Cwd
- bActive
- bWorking
- bUnread

对象由 Panel Widget 持有，并按 SessionId 原位更新。不能在每个状态消息到达时销毁并重建全部对象，否则 UListView 的条目复用、选中状态和动画会抖动。

### 7.2 UPetSessionPanelWidget

继承 UUserWidget，负责：

- 绑定 UListView。
- 应用全量快照和增量会话更新。
- 维护 SessionId 到 UPetSessionItem 的映射。
- 处理空状态和列表滚动。
- 暴露 OnSessionSelected 委托。
- 播放面板内容动画。

公开数据接口：

~~~cpp
void ApplySnapshot(const TArray<FPetSessionInfo>& Sessions);
void AddOrUpdateSession(const FPetSessionInfo& Session);
void RemoveSession(const FString& SessionId);
void SetSessionActive(const FString& SessionId, bool bActive);
void UpdateSessionState(const FString& SessionId, bool bWorking, bool bUnread);
~~~

Panel Widget 不管理 SWindow，也不访问 Bridge 或命名管道。

### 7.3 UPetSessionRowWidget

继承 UUserWidget 并实现 IUserObjectListEntry，负责：

- 在 NativeOnListItemObjectSet 中绑定当前 UPetSessionItem。
- 更新标题、短会话 ID、激活颜色和强调条。
- 根据 bWorking 启停三点动画。
- 根据 bUnread 启停气泡动画。
- 点击按钮时只广播当前 SessionId。
- 条目被复用或释放时停止旧动画并清理旧绑定。

### 7.4 Blueprint 资源

新增：

~~~text
Content/UI/WBP_PetSessionPanel.uasset
Content/UI/WBP_PetSessionRow.uasset
~~~

建议层级：

~~~text
WBP_PetSessionPanel
  Border_Root
    VerticalBox
      Header
      ListView_Sessions
      EmptyState

WBP_PetSessionRow
  Button_Row
    Overlay
      ActiveBar
      Text_Title
      WorkingDots
      UnreadBubble
~~~

动画命名：

- Anim_WorkingDots
- Anim_UnreadBubble
- Anim_RowEnter

### 7.5 资源类配置

在 BP_PetCapturePawn 上增加 TSoftClassPtr 形式的 Panel Widget 类属性，默认指向 WBP_PetSessionPanel。

要求：

- Pawn 用 UPROPERTY 持有创建后的 Widget。
- 打包验证软引用已经被 Cook。
- 资源缺失时记录明确错误并保持宠物本体可用。
- 不在 C++ 中硬编码资源路径。
- 不复用面向场景内 WidgetComponent 的 UPetMainWidget。

### 7.6 选择与未读状态

- UMG 选中态只是视图状态，不覆盖 Bridge 的 active、working 或 unread。
- 点击条目后立即把本地 bUnread 设为 false，提供即时反馈。
- Bridge 返回 session_state 后再次校准。
- 断线重连由 sessions_snapshot 恢复。
- 历史未激活会话仍允许点击并发送完整 SessionId。

## 8. Window Host 接口

推荐接口：

~~~cpp
class FPetSessionWindowHost
{
public:
    bool Create(UPetSessionPanelWidget* PanelWidget);
    void Destroy();

    void Toggle();
    void Close();
    void TickWindowAnimation(float DeltaTime);
    void UpdateAnchor(const FSlateRect& PetBoundsInSlateScreen);

    bool IsVisible() const;

private:
    TSharedPtr<SWindow> SessionWindow;
};
~~~

接口约束：

- Host 不创建或保存会话 Item。
- Host 不提供任何会话增量更新方法。
- Host 不解释 Bridge 消息。
- Host 不把 Widget 点击再次包装成自己的委托。
- Host 不暴露系统窗口句柄。
- 所有公开方法只允许在游戏线程调用。

Pawn 的接线方式：

1. Bridge 回调直接调用 Panel Widget 的公开数据接口。
2. Panel Widget 的 OnSessionSelected 直接绑定 Pawn。
3. Pawn 调用 FPetControlClient::SendOpenTui。
4. Pawn 同时通知 Host 关闭窗口。

如果未来控制管道改为后台线程直接回调，必须先投递到游戏线程。

## 9. 生命周期与内存管理

### 9.1 创建顺序

1. Pawn BeginPlay 加载并创建 UPetSessionPanelWidget。
2. Pawn 用 UPROPERTY 形式的 Transient 引用持有 Widget。
3. Pawn 绑定 OnSessionSelected。
4. Host 确认 FSlateApplication 已初始化且不是 RenderOffScreen。
5. Host 创建隐藏的 Notification SWindow。
6. 调用 TakeWidget 并设置为 SWindow 内容。
7. 调用 AddWindow，参数为 false。
8. 使用 Slate 接口设置初始位置与大小。
9. 数据和选择委托就绪后才允许 Toggle。

创建过程不得取得原生句柄。

### 9.2 销毁顺序

1. 停止 Bridge 到 Pawn 的回调。
2. 解除 Panel Widget 到 Pawn 的选择委托。
3. 停止 Host 窗口动画。
4. 把 SWindow 内容替换为 SNullWidget，断开 Slate 对 UMG 的持有。
5. 调用 FSlateApplication::RequestDestroyWindow。
6. 释放 TSharedPtr<SWindow>。
7. 最后清空 Pawn 持有的 UPROPERTY Widget 引用。

必须在 Pawn EndPlay 主动执行，不能等待 GC 才拆除 SObjectWidget。

## 10. 文件调整计划

### 10.1 新增

~~~text
Pet/Source/Pet/Public/UI/PetSessionItem.h
Pet/Source/Pet/Private/UI/PetSessionItem.cpp
Pet/Source/Pet/Public/UI/PetSessionPanelWidget.h
Pet/Source/Pet/Private/UI/PetSessionPanelWidget.cpp
Pet/Source/Pet/Public/UI/PetSessionRowWidget.h
Pet/Source/Pet/Private/UI/PetSessionRowWidget.cpp
Pet/Source/Pet/Private/UI/PetSessionWindowHost.h
Pet/Source/Pet/Private/UI/PetSessionWindowHost.cpp
Pet/Content/UI/WBP_PetSessionPanel.uasset
Pet/Content/UI/WBP_PetSessionRow.uasset
~~~

Window Host 放在 UI 目录，不放在 Windows 或 Platform 目录，明确它是跨平台 Slate 组件。

### 10.2 修改

~~~text
bridge/src/daemon/renderer.ts
  移除 RenderOffScreen，加入 NOSPLASH 和最小窗口参数

bridge/src/daemon/app.ts
bridge/src/daemon/state.ts
bridge/src/protocol/types.ts
  新增 sessions_snapshot 与 session_state 消息的生成、解析与下发

bridge/src/daemon/session-catalog.ts（新增）
bridge/test/session-catalog.test.ts（新增）
  读取 Kimi Code CLI 落盘会话目录（session_index.jsonl 与 state.json），
  合并活跃会话后生成 sessions_snapshot

Pet/Pet.uproject
  模块 LoadingPhase 改为 PreLoadingScreen，供 §5.2 启动守卫在 Slate 初始化后及时注册

Pet/Source/Pet/Pet.Build.cs
  仅 Editor 目标新增 MovieScene、MovieSceneTracks、UMGEditor、UnrealEd，
  服务 UI/Editor 资产生成库，运行时与 Shipping 不链接

Pet/Source/Pet/Public/Pet.h
Pet/Source/Pet/Private/Pet.cpp
  用临时 Slate OnPreTick 守卫替换 Win32 隐藏窗口逻辑

Pet/Source/Pet/Private/Communication/PetControlClient.h
Pet/Source/Pet/Private/Communication/PetControlClient.cpp
  新增 sessions_snapshot、session_start、session_end、session_state
  四条会话消息解析，SendOpenTui 携带 SessionId

Pet/Source/Pet/Private/Player/PetCapturePawn.cpp
Pet/Source/Pet/Public/Player/PetCapturePawn.h
  创建 Widget 与 Host，建立直接数据和选择接线

Pet/Source/Pet/Private/Platform/PetLayeredWindow.h
Pet/Source/Pet/Private/Platform/PetLayeredWindow.cpp
  R 加左键旋转、R 加滚轮缩放等摄像机操作（需求来自 docs/宠物操作.md，
  属宠物本体 Windows 层附带实现，Mac 基线任务另计）

Pet/Source/Pet/Private/UI/Editor/PetSessionWidgetAssetLibrary.h
Pet/Source/Pet/Private/UI/Editor/PetSessionWidgetAssetLibrary.cpp（新增）
  供资产生成脚本写入动画与控件绑定的正式 C++ API

Pet/Source/Pet/Private/UI/Tests/（新增）
  PetSessionPanelWidgetTests、PetSessionWidgetAssetTests、
  PetSessionWindowHostTests 三个自动化测试

Pet/Content/Blueprints/BP_PetCapturePawn.uasset
tools/verify-pet-operations.ps1
tools/mock-daemon.mjs
  新增 --verification-mode 验证模式
tools/create-session-widget-assets.py（新增）
docs/MVP设计.md
~~~

Pet.Build.cs 的运行时依赖仍为 UMG、Slate 和 SlateCore，不做新增；仅 Editor 目标追加 MovieScene、MovieSceneTracks、UMGEditor 和 UnrealEd，运行时与 Shipping 构建不链接。

### 10.3 最终删除

完成并验证迁移后删除：

~~~text
Pet/Source/Pet/Private/Platform/PetSessionPanel.h
Pet/Source/Pet/Private/Platform/PetSessionPanel.cpp
~~~

迁移期间可以保留旧实现用于视觉对照，但必须通过单一开关保证只有一个面板创建窗口。新实现通过全部验收后立即删除旧 GDI 面板，不长期维护双后端。

## 11. 分阶段实施与成本

### 阶段 0：纯 Slate 窗口与启动验证

目标是先消除最大技术风险，不接真实会话数据。

1. 移除 RenderOffScreen，改用 NOSPLASH 和最小窗口参数。
2. 用 OnPreTick 和 SWindow::HideWindow 隐藏默认游戏窗口。
3. 创建一个 Notification SWindow，承载只有一个按钮的测试 UMG。
4. 验证 SceneCapture、纹理读回和宠物窗口持续更新。
5. 验证 Windows 置顶、任务栏、显示不激活、点击输入和整体透明度。
6. 验证 Mac 置顶、窗口循环、显示不激活和首次点击。
7. 对 Windows 与 Mac 打包版本进行启动录像，检查是否有可感知闪窗。
8. 确认新代码不包含原生 GUI 接口。

预计成本为 1 到 2 人日。

只有阶段 0 在打包版本通过，才进入正式迁移。Editor 表现不能作为通过依据。如果当前 Mac 主工程尚不能编译，可先用最小运行时目标验证 SWindow 行为，但最终仍需回到完整 Mac 打包版本复验。

### 阶段 1：C++ 与 UMG 骨架

1. 新增 Item、Panel Widget 和 Row Widget。
2. 新建两个 UMG Blueprint 资源。
3. 新增薄 Window Host。
4. 使用三条固定数据验证列表项复用、点击委托和窗口动画。

预计成本为 2 到 3 人日。

### 阶段 2：接入现有会话状态

1. 把 sessions_snapshot 直接接入 Panel Widget。
2. 接入 session_start、session_end 和 session_state。
3. 点击条目继续走 SendOpenTui。
4. 对齐当前激活颜色、工作三点和未读气泡。

预计成本为 1 到 2 人日。

### 阶段 3：跨平台布局与边界

1. 完成窗口快速反向开关状态机。
2. 完成多显示器左右翻转和工作区约束。
3. 验证 100%、125%、150% 和 200% DPI。
4. 验证 0 条、1 条、8 条和 50 条会话。
5. 验证 Windows 与 Mac 打包版本。
6. 验证宠物拖动和摄像机操作不受影响。

预计成本为 2 到 3 人日。

### 阶段 4：切换与清理

1. 自动化和人工验收全部通过后启用新面板。
2. 删除旧 GDI PetSessionPanel。
3. 移除旧面板专用 GDI 资源与窗口类。
4. 更新 MVP 设计和运行验证脚本。
5. 执行 UE 编译、打包版本运行验证和 Bridge 全测。

预计总成本约为 6 到 10 人日。该估算不包含：

- 宠物本体跨平台改造。
- Mac 签名、公证和分发配置。
- 大规模 UMG 视觉资源迭代。
- 修改 UE 引擎或创建 Program 目标。

## 12. 验收标准

| 验收项 | 通过条件 |
|---|---|
| 启动窗口 | Windows 与 Mac 打包版本无可感知启动图或默认游戏黑窗 |
| SceneCapture | 隐藏默认游戏窗口后捕获、读回和宠物刷新持续工作 |
| 点击宠物 | 面板开始打开动画，不启动终端 |
| 会话列表 | 真实 CLI 会话逐行显示，标题和短 ID 正确 |
| 活跃状态 | 活跃与历史会话不依赖文字也能明显区分 |
| 工作动画 | working 为 true 时三点循环，变为 false 后立即停止 |
| 新回复 | unread 为 true 时气泡循环，点击后即时消失 |
| 会话跳转 | open_tui 携带被点击行的完整 session_id |
| 开关动画 | 打开、关闭和快速反向操作无闪烁或卡死 |
| 滚动 | 50 条数据可滚动，列表项复用后状态不串行 |
| 自动显示焦点 | 面板显示、更新和移动不夺走当前前台应用焦点 |
| 主动点击焦点 | Windows 允许点击后激活 KimiPet，不再验收点击全过程不激活 |
| 任务切换 | Windows 面板无独立任务栏与 Alt 加 Tab 项，Mac 面板不进入普通窗口循环 |
| 置顶 | Windows 与 Mac 面板都位于普通应用窗口上方 |
| 窗口外形 | 矩形窗口和矩形命中区，无透明圆角穿透要求 |
| 多显示器 | 负坐标、副屏和不同 DPI 下位置、尺寸和点击一致 |
| 生命周期 | 反复 100 次开关无窗口资源持续增长，退出无 Slate 或 GC 警告 |
| 项目层原生接口 | Window Host 与新 UI 文件中没有 Windows.h、AppKit、GetOSWindowHandle 或原生窗口调用 |
| 打包版本 | Development 与 Shipping 打包版本行为符合以上约束 |
| 回归 | 宠物拖动、R 加左键旋转、R 加滚轮缩放全部通过 |

## 13. 自动化与验证

### 13.1 C++ 自动化测试

- 会话快照合并与增量更新。
- UListView 条目复用后的状态清理。
- Window Host 四态动画状态机。
- 左右翻转、工作区约束和负坐标布局纯函数。
- 不同 DPI 下的坐标转换。
- Widget 类缺失或加载失败时安全降级。

### 13.2 Bridge 测试

- renderer 启动参数不包含 RenderOffScreen。
- renderer 启动参数包含 NOSPLASH。
- open_tui 仍携带完整 session_id。
- 现有会话目录与状态测试全部通过。

### 13.3 端到端验证

tools/verify-pet-operations.ps1 继续承担 Windows 端到端验证：

- 启动模拟守护进程与 UE。
- 点击宠物打开和关闭面板。
- 截图比较工作三点与气泡动画。
- 点击第一行并确认模拟守护进程收到准确 SessionId。
- 验证摄像机旋转、缩放和光标。

该 PowerShell 脚本不是 Mac 验收替代品。Mac 必须有单独的打包运行清单或 CI 测试。

外部脚本无法稳定验证的内容，包括启动瞬间闪窗、焦点切换和 UMG 动画轨道，应保留录像、截图和人工检查记录。

### 13.4 静态边界检查

在新增 Host 与 UI 文件上执行静态搜索，禁止出现：

~~~text
Windows.h
HWND
WS_EX_
SetWindowPos
SetWindowRgn
GetOSWindowHandle
NSWindow
AppKit
~~~

该检查只约束本次新增会话面板实现。宠物本体当前已有的 Windows 代码属于另一项跨平台任务。

## 14. 风险与处理

| 风险 | 影响 | 处理方式 |
|---|---|---|
| 默认游戏窗口在系统合成器中短暂可见 | 启动时出现小黑窗 | NOSPLASH、最小窗口、OnPreTick 首绘制前隐藏，阶段 0 双平台录像 |
| RenderOffScreen 被重新加入 | 会话 SWindow 没有真实平台窗口 | Bridge 测试断言启动参数不包含该选项，Host 创建时输出明确错误 |
| 把 Never 理解成点击永不激活 | 焦点验收反复失败 | 文档和验收明确区分自动显示与用户主动点击 |
| Mac Normal 窗口不够置顶 | 面板被普通应用遮挡 | 固定使用 Notification 类型，Mac 打包回归 |
| UE 后续版本改变 Notification 映射 | Mac 置顶行为回归 | 引擎升级清单加入窗口等级与焦点验证 |
| 混用物理像素和 Slate 屏幕坐标 | 跨屏漂移或点击错位 | 统一 Host 坐标契约，转换集中在边界，布局函数自动化 |
| Editor 的透明表现掩盖发行版限制 | 打包后出现矩形背景差异 | 只使用 PerWindow，强制验收打包版本 |
| UListView 条目复用导致动画串行 | 错误行显示工作或未读 | 设置和释放条目时停止动画并解除旧绑定 |
| stale 会话超时被守护进程回收 | 面板残留已被回收的会话行 | 回收时下发 session_end{reason:'stale'}，面板据此移除残留行 |
| Widget 被 GC | 面板随机失效或崩溃 | Pawn 用 UPROPERTY 持有，按规定顺序拆除 Slate 内容 |
| 两个置顶窗口 Z 序交换 | 面板偶尔被宠物遮挡 | 打开面板时调用 Slate BringToFront，只在必要时执行 |
| UMG 资源缺失 | 面板无法创建 | 明确日志并保持宠物本体可用，迁移期允许关闭新面板开关 |
| Mac 主工程尚不能编译 | 无法完成完整双平台验收 | 将主工程 Mac 基线列为前置任务，不用平台原生面板绕过 |
| Window Host 逐步吸收业务逻辑 | 出现厚转发层 | 接口审查禁止任何会话数据方法和选择转发委托 |

## 15. 已确定的设计决策

1. 会话面板项目代码不直接调用 Win32、AppKit 或其他原生 GUI 接口。
2. 移除 RenderOffScreen，使用公开 Slate 接口隐藏默认游戏窗口。
3. 使用 Notification Popup SWindow 承载 UMG。
4. 面板自动显示时不抢焦点；Windows 用户主动点击后允许激活应用。
5. 窗口按矩形外形和矩形命中区验收，不实现透明圆角穿透。
6. UMG Blueprint 负责布局和控件动画，C++ 负责数据、窗口和生命周期。
7. Window Host 只管理窗口，不转发会话数据和选择事件。
8. 面板宽度默认 360，最多同时显示八行，更多会话使用 UListView 滚动。
9. 阶段 0 必须验证 Windows 与 Mac 打包版本，不能只验证 Editor。
10. 新实现通过验收后删除旧 GDI 面板，不长期维护双后端。

## 16. 推荐执行结论

在上述焦点与矩形窗口边界下，会话面板的纯 Slate 与 UMG 路线成立。

推荐首先实施阶段 0。阶段 0 的目标不是制作正式界面，而是一次性回答四个问题：

1. 移除 RenderOffScreen 后，默认游戏窗口能否无感隐藏。
2. 隐藏默认窗口后，宠物 SceneCapture 能否持续运行。
3. Notification SWindow 在 Windows 与 Mac 上能否满足置顶、任务切换和显示不激活。
4. 项目能否在不取得原生窗口句柄的情况下完成全部面板交互。

四项全部通过后再投入 UMG 正式制作，可以把最大的不确定性控制在 1 到 2 人日内。

这条路线比继续扩展 GDI 面板更适合后续复杂互动，也避免了 UMG 离屏渲染、GPU 到 CPU 读回、手工输入注入、双平台原生窗口后端和厚数据转发层。
