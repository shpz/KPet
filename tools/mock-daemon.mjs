#!/usr/bin/env node
/**
 * mock-daemon：控制管道（\\.\pipe\KimiPet.PET.<用户名>）上的模拟守护进程。
 * 用于在真实守护进程缺位时联调渲染进程（UE 侧 Pet 工程）：
 * - 收 hello / heartbeat / open_tui / pet_moved / protocol_error 等并打印
 * - 收到 hello 回 hello 并下发初始 pet_state:Idle，此后每 10 秒交替下发 Working/Idle（验证状态切换可视化）
 * - Ctrl+C 退出；退出后重启可验证渲染进程断线重连（§4.5-5：每 5 秒重连）
 *
 * 消息约定与 bridge/ 完全一致（§4.2）：UTF-8 JSON + '\n' 行分帧；未知类型忽略（§4.2 向前兼容）。
 * 用法：node tools/mock-daemon.mjs
 */
import * as net from 'node:net';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

const PIPE_USER_REPLACEMENT = '_';
const INVALID_PIPE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
const PIPE_USER_FALLBACK = 'default';

function sanitizePipeUser(username) {
  const cleaned = username.replace(INVALID_PIPE_CHARS, PIPE_USER_REPLACEMENT).trim();
  return cleaned.length > 0 ? cleaned : PIPE_USER_FALLBACK;
}

function getUserName() {
  try {
    const name = os.userInfo().username;
    if (name && name.length > 0) return name;
  } catch {
    // 回退环境变量
  }
  return process.env.USERNAME ?? process.env.USER ?? PIPE_USER_FALLBACK;
}

const PIPE_NAME = `\\\\.\\pipe\\KimiPet.PET.${sanitizePipeUser(getUserName())}`;
const ts = () => new Date().toISOString();

let client = null; // 当前连接的渲染进程（单连接）

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
        send(client, 'shutdown', { reason: 'user' });
        console.log(`[${ts()}] 已下发 shutdown (reason=user)`);
      } else {
        console.log(`[${ts()}] 到点无连接，跳过 shutdown`);
      }
    }, shutdownAfterSec * 1000);
  }

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim().length === 0) continue;
      handleMessage(socket, line);
    }
  });
  socket.on('close', () => {
    console.log(`[${ts()}] 渲染进程断开`);
    if (client === socket) client = null;
  });
  socket.on('error', (err) => {
    console.log(`[${ts()}] 连接错误: ${err.message}`);
    if (client === socket) client = null;
  });
});

/** 按 §4.2 信封构造并发送一条消息（\n 行分帧）。 */
function send(socket, type, payload) {
  const msg = {
    v: 1,
    type,
    id: randomUUID(),
    ts: new Date().toISOString(),
    session_id: null,
    payload,
  };
  socket.write(JSON.stringify(msg) + '\n');
}

function handleMessage(socket, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log(`[${ts()}] 非法 JSON（忽略）: ${line.slice(0, 120)}`);
    return;
  }
  const p = msg.payload ?? {};
  switch (msg.type) {
    case 'hello': {
      console.log(
        `[${ts()}] 收到 hello: protocol_version=${p.protocol_version} role=${p.role} pid=${p.pid} version=${p.version} capabilities=[${(p.capabilities ?? []).join(', ')}]`,
      );
      // 握手：回 hello + 下发初始状态（模拟 §4.5-1 补发 pet_state）
      send(socket, 'hello', {
        protocol_version: 1,
        role: 'daemon',
        pid: process.pid,
        version: 'mock-daemon',
        capabilities: ['pet_state', 'tasks_snapshot', 'task_start', 'task_end', 'notify', 'shutdown'],
      });
      send(socket, 'pet_state', { state: 'Idle', reason: 'mock:initial' });
      console.log(`[${ts()}] 已回 hello 并下发 pet_state: Idle`);
      break;
    }
    case 'heartbeat':
      console.log(`[${ts()}] 收到心跳: pid=${p.pid} uptime_s=${p.uptime_s} state=${p.state}`);
      break;
    case 'open_tui':
      console.log(
        `[${ts()}] OPEN_TUI: source=${p.source} session_id=${msg.session_id ?? p.session_id ?? 'null'} task_id=${p.task_id ?? 'null'}`,
      );
      break;
    case 'pet_moved':
      console.log(`[${ts()}] 宠物位置: x=${p.x} y=${p.y} monitor_id=${p.monitor_id}`);
      break;
    case 'protocol_error':
      console.log(`[${ts()}] 收到 protocol_error: ${p.description ?? ''}`);
      break;
    default:
      console.log(`[${ts()}] 未知消息类型 ${msg.type}（忽略，§4.2 向前兼容）`);
  }
}

// 每 10 秒交替下发 pet_state Working/Idle（联调用：肉眼验证球体颜色切换）
let state = 'Idle';
setInterval(() => {
  if (!client) return;
  state = state === 'Idle' ? 'Working' : 'Idle';
  send(client, 'pet_state', { state, reason: 'mock:interval' });
  console.log(`[${ts()}] 下发 pet_state: ${state}`);
}, 10_000);

// 联调选项：--send-shutdown-after <秒> 或 --send-shutdown-after=<秒>：连接建立后 N 秒下发 shutdown，
// 验证渲染进程收到后退出（计时从渲染进程连上开始）
let shutdownAfterSec = 0;
let shutdownTimer = null;
const shutdownArgIdx = process.argv.indexOf('--send-shutdown-after');
if (shutdownArgIdx >= 0) {
  shutdownAfterSec = Number(process.argv[shutdownArgIdx + 1]) || 0;
} else {
  const arg = process.argv.find((a) => a.startsWith('--send-shutdown-after='));
  if (arg) shutdownAfterSec = Number(arg.split('=')[1]) || 0;
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[${ts()}] ${PIPE_NAME} 已被占用（真实守护进程或其他 mock 已在运行？），退出`);
  } else {
    console.error(`[${ts()}] 服务器错误: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PIPE_NAME, () => {
  console.log(`[${ts()}] mock-daemon 监听 ${PIPE_NAME}（Ctrl+C 退出）`);
});

process.on('SIGINT', () => {
  console.log(`[${ts()}] 退出，关闭服务器（渲染进程将进入断线重连）`);
  server.close();
  process.exit(0);
});
