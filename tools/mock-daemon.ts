/**
 * mock-daemon：控制管道（\\.\pipe\KPet.PET.<用户名>）上的模拟守护进程。
 * 用于在真实守护进程缺位时联调渲染进程（UE 侧 Pet 工程）：
 * - 收 hello / heartbeat / open_tui / pet_moved / protocol_error 等并打印
 * - 收到 hello 回 hello，并下发三条会话演示数据及初始 pet_state:Idle
 * - 此后每 10 秒交替下发 Working/Idle 和逐会话工作状态（验证状态与三点动画）
 * - Ctrl+C 退出；退出后重启可验证渲染进程断线重连（每 5 秒重连）
 *
 * 消息约定与 bridge/ 完全一致：UTF-8 JSON + '\n' 行分帧；未知类型忽略（向前兼容）。
 * 用法：node --experimental-strip-types tools/mock-daemon.ts
 */
import * as net from "node:net";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

const PIPE_USER_REPLACEMENT = "_";
const INVALID_PIPE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
const PIPE_USER_FALLBACK = "default";

function sanitizePipeUser(username: string): string {
  const cleaned = username.replace(INVALID_PIPE_CHARS, PIPE_USER_REPLACEMENT).trim();
  return cleaned.length > 0 ? cleaned : PIPE_USER_FALLBACK;
}

function getUserName(): string {
  try {
    const name = os.userInfo().username;
    if (name && name.length > 0) return name;
  } catch {
    // 回退环境变量
  }
  return process.env.USERNAME ?? process.env.USER ?? PIPE_USER_FALLBACK;
}

const PIPE_NAME = `\\\\.\\pipe\\KPet.PET.${sanitizePipeUser(getUserName())}`;
const ts = (): string => new Date().toISOString();
const verificationMode = process.argv.includes("--verification-mode");

// 联调选项：--send-shutdown-after <秒> 或 --send-shutdown-after=<秒>：连接建立后 N 秒下发 shutdown，
// 验证渲染进程收到后退出（计时从渲染进程连上开始）
let shutdownAfterSec = 0;
const shutdownArgIdx = process.argv.indexOf("--send-shutdown-after");
if (shutdownArgIdx >= 0) {
  shutdownAfterSec = Number(process.argv[shutdownArgIdx + 1]) || 0;
} else {
  const arg = process.argv.find((a) => a.startsWith("--send-shutdown-after="));
  if (arg) shutdownAfterSec = Number(arg.split("=")[1]) || 0;
}
let shutdownTimer: ReturnType<typeof setTimeout> | null = null;

/** 会话目录条目（sessions_snapshot 的 payload.sessions 元素）。 */
interface SessionInfo {
  session_id: string;
  title: string;
  cwd: string;
  active: boolean;
  working: boolean;
  unread: boolean;
  updated_at: number;
}

/** 守护进程侧设置配置（update_config 的合并目标 / config_snapshot 的全量来源，字段同 bridge config.ts）。 */
interface MockConfig {
  open_target: "cli" | "web";
  open_web_url: string;
  ui_theme: "dark-glass" | "light-minimal" | "cute-pet";
  fps_monitor: boolean;
}

/** config_snapshot / update_config 的合法取值白名单（与 PetConfigProtocol.cpp 一致）。 */
const OPEN_TARGETS: readonly string[] = ["cli", "web"];
const UI_THEMES: readonly string[] = ["dark-glass", "light-minimal", "cute-pet"];

/** mock 初始配置（open_web_url 用空串即可：协议只校验其是字符串，open_target=cli 时设置页不展示）。 */
let config: MockConfig = {
  open_target: "cli",
  open_web_url: "",
  ui_theme: "dark-glass",
  fps_monitor: false,
};

/** 向指定客户端回推全量 config_snapshot（真实守护进程在握手收尾与每次 update_config 后下发）。 */
function pushConfigSnapshot(socket: net.Socket): void {
  send(socket, "config_snapshot", {
    open_target: config.open_target,
    open_web_url: config.open_web_url,
    ui_theme: config.ui_theme,
    fps_monitor: config.fps_monitor,
  });
  console.log(
    `[${ts()}] 已回推 config_snapshot: open_target=${config.open_target} ui_theme=${config.ui_theme} fps_monitor=${config.fps_monitor}`,
  );
}

/** 收到的消息信封。 */
interface IncomingMessage {
  type?: string;
  session_id?: string;
  payload?: Record<string, any>;
}

let client: net.Socket | null = null; // 当前连接的渲染进程（单连接）
let verificationStateTimer: ReturnType<typeof setTimeout> | null = null;
let verificationShutdownTimer: ReturnType<typeof setTimeout> | null = null;

const server = net.createServer((socket) => {
  if (client) {
    console.log(`[${ts()}] 已有连接，拒绝新连接`);
    socket.destroy();
    return;
  }
  client = socket;
  console.log(`[${ts()}] 渲染进程已连接`);
  if (shutdownAfterSec > 0 && !shutdownTimer) {
    shutdownTimer = setTimeout(() => {
      if (client) {
        send(client, "shutdown", { reason: "user" });
        console.log(`[${ts()}] 已下发 shutdown (reason=user)`);
      } else {
        console.log(`[${ts()}] 到点无连接，跳过 shutdown`);
      }
    }, shutdownAfterSec * 1000);
  }

  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim().length === 0) continue;
      handleMessage(socket, line);
    }
  });
  socket.on("close", () => {
    console.log(`[${ts()}] 渲染进程断开`);
    if (client === socket) client = null;
  });
  socket.on("error", (err: Error) => {
    console.log(`[${ts()}] 连接错误: ${err.message}`);
    if (client === socket) client = null;
  });
});

/** 按协议信封构造并发送一条消息（\n 行分帧）。 */
function send(
  socket: net.Socket,
  type: string,
  payload: Record<string, unknown>,
  sessionId: string | null = null,
): void {
  const msg = {
    v: 1,
    type,
    id: randomUUID(),
    ts: new Date().toISOString(),
    session_id: sessionId,
    payload,
  };
  socket.write(JSON.stringify(msg) + "\n");
}

function handleMessage(socket: net.Socket, line: string): void {
  let msg: IncomingMessage;
  try {
    msg = JSON.parse(line) as IncomingMessage;
  } catch {
    console.log(`[${ts()}] 非法 JSON（忽略）: ${line.slice(0, 120)}`);
    return;
  }
  const p = msg.payload ?? {};
  switch (msg.type) {
    case "hello": {
      console.log(
        `[${ts()}] 收到 hello: protocol_version=${p.protocol_version} role=${p.role} pid=${p.pid} version=${p.version} capabilities=[${(p.capabilities ?? []).join(", ")}]`,
      );
      // 握手：回 hello + 下发初始状态（模拟补发 pet_state）
      send(socket, "hello", {
        protocol_version: 1,
        role: "daemon",
        pid: process.pid,
        version: "mock-daemon",
        capabilities: [
          "pet_state",
          "sessions_snapshot",
          "config_snapshot",
          "session_state",
          "tasks_snapshot",
          "task_start",
          "task_end",
          "notify",
          "shutdown",
        ],
      });
      const sessions: SessionInfo[] = [
        {
          session_id: "demo-working-session",
          title: "正在工作的会话",
          cwd: "D:\\Workspace\\UnrealProject\\KimiPet",
          active: true,
          working: true,
          unread: false,
          updated_at: Date.now(),
        },
        {
          session_id: "demo-unread-session",
          title: "有新回复的会话",
          cwd: "D:\\Workspace\\UnrealProject\\KimiPet",
          active: true,
          working: false,
          unread: true,
          updated_at: Date.now() - 1000,
        },
        {
          session_id: "demo-history-session",
          title: "未激活的历史会话",
          cwd: "D:\\Workspace\\UnrealProject",
          active: false,
          working: false,
          unread: false,
          updated_at: Date.now() - 2000,
        },
      ];
      if (verificationMode) {
        for (let index = sessions.length; index < 50; index += 1) {
          sessions.push({
            session_id: `demo-history-session-${String(index).padStart(2, "0")}`,
            title: `历史会话 ${String(index).padStart(2, "0")}`,
            cwd: `D:\\Workspace\\UnrealProject\\History${String(index).padStart(2, "0")}`,
            active: false,
            working: false,
            unread: false,
            updated_at: Date.now() - index * 1000,
          });
        }
      }
      send(socket, "sessions_snapshot", { sessions });
      send(socket, "pet_state", { state: "Idle", reason: "mock:initial" });
      // 握手收尾补发全量配置快照（与真实守护进程一致：设置 WebUI 初始化用）。
      pushConfigSnapshot(socket);
      console.log(`[${ts()}] 已回 hello，并下发 ${sessions.length} 条会话演示数据与 pet_state: Idle`);
      if (verificationMode) console.log(`[${ts()}] VERIFY_CATALOG_SIZE=${sessions.length}`);
      if (verificationMode && !verificationStateTimer) {
        verificationStateTimer = setTimeout(() => {
          if (!client) return;
          // 状态清除改走全量快照而不是两条增量 session_state：增量消息会触发面板
          // 「活跃会话置顶」（MoveSessionToFront），把 demo-unread-session 移到首行，
          // 导致后续「定向跳转 demo-working-session」点击命中的是 unread 会话。
          // 全量快照同时清除 working/unread 呈现并恢复初始会话顺序。
          const cleared: SessionInfo[] = sessions.map((session) => ({
            ...session,
            working: false,
            unread: false,
          }));
          send(client, "sessions_snapshot", { sessions: cleared });
          console.log(`[${ts()}] VERIFY_STATE_CLEARED`);
        }, 5000);
      }
      break;
    }
    case "heartbeat":
      console.log(`[${ts()}] 收到心跳: pid=${p.pid} uptime_s=${p.uptime_s} state=${p.state}`);
      break;
    case "open_tui":
      if (typeof p.session_id === "string" && p.session_id.length > 0) {
        send(socket, "session_state", { working: false, unread: false }, p.session_id);
      }
      console.log(
        `[${ts()}] OPEN_TUI: source=${p.source} session_id=${msg.session_id ?? p.session_id ?? "null"} task_id=${p.task_id ?? "null"}`,
      );
      if (verificationMode && !verificationShutdownTimer) {
        verificationShutdownTimer = setTimeout(() => {
          if (!client) return;
          send(client, "shutdown", { reason: "verification_complete" });
          console.log(`[${ts()}] VERIFY_SHUTDOWN_SENT`);
        }, 3000);
      }
      break;
    case "pet_moved":
      console.log(`[${ts()}] 宠物位置: x=${p.x} y=${p.y} monitor_id=${p.monitor_id}`);
      break;
    case "update_config": {
      // 镜像真实守护进程（bridge daemon/app.ts onUpdateConfig）：逐字段校验合并进
      // 内存配置；至少一个合法字段才生效，否则回 protocol_error。
      // 生效后回推全量 config_snapshot——渲染端 HandleConfigSnapshot 因此会对（隐藏中的）
      // 会话面板再次推 SetTheme + SetFpsMonitor，这一往返是复现设置面板压栈黑化的关键前置。
      const rawTarget = p.open_target;
      const rawTheme = p.ui_theme;
      const rawFps = p.fps_monitor;
      let applied = false;
      if (rawTarget !== undefined && OPEN_TARGETS.includes(rawTarget as string)) {
        config.open_target = rawTarget as MockConfig["open_target"];
        applied = true;
      }
      if (rawTheme !== undefined && UI_THEMES.includes(rawTheme as string)) {
        config.ui_theme = rawTheme as MockConfig["ui_theme"];
        applied = true;
      }
      if (rawFps !== undefined && typeof rawFps === "boolean") {
        config.fps_monitor = rawFps;
        applied = true;
      }
      console.log(
        `[${ts()}] 收到 update_config: open_target=${rawTarget ?? "-"} ui_theme=${rawTheme ?? "-"} fps_monitor=${rawFps ?? "-"} | 合并后 ui_theme=${config.ui_theme} fps_monitor=${config.fps_monitor}`,
      );
      if (!applied) {
        send(socket, "protocol_error", {
          description: "update_config 至少需要一个合法字段",
          raw_excerpt: line.slice(0, 256),
        });
        console.log(`[${ts()}] update_config 无合法字段，回 protocol_error`);
        break;
      }
      pushConfigSnapshot(socket);
      break;
    }
    case "protocol_error":
      console.log(`[${ts()}] 收到 protocol_error: ${p.description ?? ""}`);
      break;
    default:
      console.log(`[${ts()}] 未知消息类型 ${msg.type}（忽略，向前兼容）`);
  }
}

// 每 10 秒交替下发 pet_state Working/Idle（联调用：肉眼验证球体颜色切换）
let state = "Idle";
setInterval(() => {
  if (!client) return;
  state = state === "Idle" ? "Working" : "Idle";
  send(client, "pet_state", { state, reason: "mock:interval" });
  if (!verificationMode) {
    send(client, "session_state", { working: state === "Working", unread: false }, "demo-working-session");
  }
  console.log(`[${ts()}] 下发 pet_state: ${state}`);
}, 10_000);

server.on("error", (err: Error & { code?: string }) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[${ts()}] ${PIPE_NAME} 已被占用（真实守护进程或其他 mock 已在运行？），退出`);
  } else {
    console.error(`[${ts()}] 服务器错误: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PIPE_NAME, () => {
  console.log(`[${ts()}] mock-daemon 监听 ${PIPE_NAME}（Ctrl+C 退出）`);
});

process.on("SIGINT", () => {
  console.log(`[${ts()}] 退出，关闭服务器（渲染进程将进入断线重连）`);
  server.close();
  process.exit(0);
});
