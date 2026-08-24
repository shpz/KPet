# KPet bridge（转发器 + 通信协议）

KPet 桌面宠物的宿主集成层，对应 [`docs/KPet架构.md`](../docs/KPet架构.md) 的「宿主插件与转发器」与「进程间通信」两章。

本工程目前包含三部分：

- **协议包 `src/protocol/`**：消息信封与全部消息类型定义，供转发器、守护进程、渲染进程共享。校验/构造辅助供守护进程、渲染进程复用（含非法消息处理）。
- **转发器 `src/bridge/`**：宿主每发生一个事件拉起一次，读取 stdin 事件 JSON → 包装成 `host_event` 信封 → 写入事件管道 `\\.\pipe\KPet.H2D.<用户名>`；管道不存在则分离拉起守护进程（防并发风暴）；连接+写入超时 200ms，失败写本地暂存 `%TEMP%/kpet-events/`；任何情况以退出码 0 结束（失败放行）。
- **守护进程 `src/daemon/`**：维护会话与全局 `Idle`/`Working` 状态、管理渲染进程及控制管道。用户通过 `close_pet` 关闭后，以 `%TEMP%/kpet/pet.disabled` 抑制当前会话的后续拉起；下一次合法 `SessionStart` 自动恢复。

## 目录结构

```text
bridge/
  package.json / tsconfig.json / tsconfig.test.json
  src/
    protocol/            # 协议包
      types.ts           # 消息类型全集与全部 payload 定义
      envelope.ts        # 信封构造/校验、host_event 包装
      index.ts
    bridge/              # 转发器主程序
      main.ts            # 入口与核心流程（read stdin → wrap → 拉起/写管道 → 暂存 → exit 0）
      pipe.ts            # 命名管道探测与写入（node:net，200ms 超时）
      daemon.ts          # 守护进程分离拉起（KIMI_PLUGIN_ROOT 推导 + 锁文件防并发风暴）
      staging.ts         # 本地暂存 %TEMP%/kpet-events/（时间戳+随机文件名，可排序回收）
      user.ts            # 用户名获取与非法字符过滤（管道名段）
    daemon/              # 常驻守护进程、会话状态机、渲染进程与控制管道管理
    launcher/            # 单 exe 分发入口（--relay / --daemon / --kpet-recover / --stop 四模式）
      main.ts
  test/                  # node:test 单测 + 命名管道集成测试（Windows）
  packaging/
    kpet/
      deploy.sh          # 跨平台部署脚本（POSIX 入口：WSL 清单就位、安装指引前经 --stop 停旧守护进程）
      deploy.ps1         # 跨平台部署脚本（Windows 原生入口：Windows 清单恢复、安装指引前经 --stop 停旧守护进程）
      kimi.plugin.json   # 插件清单（12 个事件钩子，Windows 版直启 .\bin\kpetd.exe --relay）
      kimi.plugin.wsl.json  # WSL 版清单（command 走 bin/kpet-relay.sh）
      bin/
        kpet-relay.sh   # WSL 宿主 relay 启动脚本（interop 直启 Windows 侧 kpetd.exe，可选覆盖 KIMI_PLUGIN_ROOT_WIN）
```

## 构建

```bash
npm install        # 仅 devDependencies（typescript、@types/node），运行时零第三方依赖
npm run build      # tsc 编译到 dist/（ESM，NodeNext）
npm run build:exe  # bun 编译单 exe：bin/kpetd.exe（转发器/守护进程/恢复 worker 同体，按首参数分发）
```

产物：`dist/launcher/main.js`（单 exe 分发入口）、`dist/bridge/main.js`（转发器核心）、`dist/protocol/`（协议包，含 .d.ts）；`build:exe` 额外产出 `bin/kpetd.exe`。

## 打包（生成可安装的插件目录）

打包是整个产品的事（转发器 + 守护进程 + UE5 渲染进程），打包脚本已上移到仓库根 `tools/package.ts`（用法见其头注释，支持 `--skip-renderer` / `--renderer` / `--ue-config` / `--out` / `--zip`）：

```bash
# 在仓库根执行
npm run package
```

## 测试

```bash
npm test           # 编译 src + test 后运行 node --test
```

覆盖：信封构造/校验、`_raw` 原文透传、session_id 提取与字段防御、用户名非法字符过滤、暂存文件写入与可排序回收、非法输入放行、守护进程拉起锁的互斥与陈旧 TTL 接管、命名管道送达/兜底集成测试（Windows 命名管道，非 Windows 平台自动跳过）。

> `--test-force-exit`：Windows 命名管道上 `node:net` 的 Socket 销毁后句柄残留（close 事件不触发），测试进程等不到事件循环清空；生产代码无此问题（转发器显式 `process.exit(0)`），测试用该开关强制退出。

## 已知实现注意点

- **分帧**：`node:net` 的命名管道是字节流模式而非消息模式，因此转发器每条消息追加一个 `\n` 作帧分隔，守护进程端按行读取（JSON 文本流惯例，消息模式收端亦可容忍尾部空白）。
- **管道不存在判定**：`node:net` 对不存在的命名管道报告 `ENOENT` / `ECONNREFUSED`（`src/bridge/pipe.ts`）。
- **防并发风暴**：多个转发器同时发现管道不存在时，由 `%TEMP%/kpet/daemon.lock` 独占锁保证只拉一次；锁文件不主动删除，靠 mtime 超过 15s 视为陈旧接管（崩溃残留不阻塞拉起，`src/bridge/daemon.ts`）。
- **守护进程路径**：单 exe 合并后，bun --compile 产物下守护进程即当前可执行文件自身（`resolveDaemonPath` 直接返回 `argv[0]`）；开发模式（node/bun 直跑）仍优先 `KIMI_PLUGIN_ROOT/bin/kpetd.exe`（宿主注入），未设置时相对推导为 `cwd()/bin/kpetd.exe`（宿主保证钩子工作目录 = 插件根目录）。