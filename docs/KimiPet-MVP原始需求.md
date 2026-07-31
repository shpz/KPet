# Kimi Pet

主要运行平台为 Win11，宿主为 Kimi Code CLI，游戏引擎选型为 UE5.8。

采用 Kimi Code Plugin + UE5 Shipping 独立进程的双层架构。

Plugin 使用 Hook 或者其他什么消息机制负责监听宿主消息，独立进程负责根据消息渲染宠物。

## PET 设计

初始形象为 3D 打印的那个蓝色球，要包含 Idle、Working 2个状态。

所有状态点击都能打开对应的 Kimi Code TUI。

Idle 是空闲状态，眨眼、东张西望，主要交互是可以控制位置和旋转。

Working 是工作状态，敲电脑，主要交互是鼠标滑过电脑屏幕会显示正在运行的任务，任务完成了弹出消息气泡。