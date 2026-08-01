# KimiPet bridge（转发器 + 通信协议）

KimiPet 桌面宠物的宿主集成层，对应 `docs/MVP设计.md` §3（宿主集成）/ §4（进程间通信协议）。

本工程目前包含两部分：

- **协议包 `src/protocol/`**：消息信封与全部消息类型定义（§4.2 / §4.3），供转发器、守护进程、渲染进程共享。校验/构造辅助供守护进程、渲染进程复用（如 §4.4 的非法消息处理）。
- **转发器 `src/bridge/`**：`kimi-pet-bridge`（§3.3）。宿主每发生一个事件拉起一次，读取 stdin 事件 JSON → 包装成 `host_event` 信封 → 写入事件管道 `\\.\pipe\KimiPet.H2D.<用户名>`；管道不存在则分离拉起守护进程 `kimi-petd.exe`（防并发风暴）；连接+写入超时 200ms，失败写本地暂存 `%TEMP%/kimi-pet-events/`；任何情况以退出码 0 结束（失败放行，§2.2 D4）。

> 守护进程（`kimi-petd`）不在本任务范围，由后续任务实现。

## 目录结构

```text
bridge/
  package.json / tsconfig.json / tsconfig.test.json
  src/
    protocol/            # 协议包（§4）
      types.ts           # 消息类型全集与全部 payload 定义（§4.3）
      envelope.ts        # 信封构造/校验、host_event 包装（§4.2）
      index.ts
    bridge/              # 转发器主程序（§3.3）
      main.ts            # 入口与核心流程（read stdin → wrap → 拉起/写管道 → 暂存 → exit 0）
      pipe.ts            # 命名管道探测与写入（node:net，200ms 超时）
      daemon.ts          # 守护进程分离拉起（KIMI_PLUGIN_ROOT 推导 + 锁文件防并发风暴）
      staging.ts         # 本地暂存 %TEMP%/kimi-pet-events/（时间戳+随机文件名，可排序回收）
      user.ts            # 用户名获取与非法字符过滤（管道名段）
  test/                  # node:test 单测 + 命名管道集成测试（Windows）
  packaging/
    kimi-pet/
      kimi.plugin.json   # 插件清单（§3.2，12 个事件钩子）
```

## 构建

```bash
npm install        # 仅 devDependencies（typescript、@types/node），运行时零第三方依赖
npm run build      # tsc 编译到 dist/（ESM，NodeNext）
```

产物：`dist/bridge/main.js`（转发器入口）、`dist/protocol/`（协议包，含 .d.ts）。

## 打包（生成可安装的插件目录）

打包是整个产品的事（转发器 + 守护进程 + UE5 渲染进程），打包脚本已上移到仓库根 `scripts/package.ts`（用法见其头注释，支持 `--skip-renderer` / `--renderer` / `--ue-config` / `--out` / `--zip`）：

```bash
# 在仓库根执行
npm run package
```

## 测试

```bash
npm test           # 编译 src + test 后运行 node --test
```

覆盖：信封构造/校验（§4.2/§4.4）、`_raw` 原文透传、session_id 提取与字段防御（§3.4）、用户名非法字符过滤（§4.1）、暂存文件写入与可排序回收（§3.3）、非法输入放行（§2.2 D4）、守护进程拉起锁的互斥与陈旧 TTL 接管、命名管道送达/兜底集成测试（Windows 命名管道，非 Windows 平台自动跳过）。

> `--test-force-exit`：Windows 命名管道上 `node:net` 的 Socket 销毁后句柄残留（close 事件不触发），测试进程等不到事件循环清空；生产代码无此问题（转发器显式 `process.exit(0)`），测试用该开关强制退出。

## 已知实现注意点

- **分帧**：`node:net` 的命名管道是字节流模式而非文档假设的"消息模式"（§4.1），因此转发器每条消息追加一个 `\n` 作帧分隔，守护进程端按行读取（JSON 文本流惯例，消息模式收端亦可容忍尾部空白）。
- **管道不存在判定**：`node:net` 对不存在的命名管道报告 `ENOENT` / `ECONNREFUSED`（`src/bridge/pipe.ts`）。
- **防并发风暴**：多个转发器同时发现管道不存在时，由 `%TEMP%/kimi-pet/daemon.lock` 独占锁保证只拉一次；锁文件不主动删除，靠 mtime 超过 15s 视为陈旧接管（崩溃残留不阻塞拉起，`src/bridge/daemon.ts`）。
- **守护进程路径**：优先 `KIMI_PLUGIN_ROOT/bin/kimi-petd.exe`（宿主注入，§3.1）；未设置时相对推导为 `cwd()/bin/kimi-petd.exe`（宿主保证钩子工作目录 = 插件根目录）。
