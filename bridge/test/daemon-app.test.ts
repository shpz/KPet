/**
 * 守护进程集成测试（真实 Windows 命名管道）：
 * 模拟转发器写入事件管道 → 模拟渲染进程连入控制管道 → 断言收到 hello 回包、
 * pet_state / tasks_snapshot / task_start 等消息。
 *
 * 覆盖：冷启动握手与快照、事件→状态全链路、并发风暴、非法帧容错、退出倒计时与取消、
 * 心跳超时判死、暂存回收、单实例。非 Windows 平台跳过（命名管道为 Windows 特性）。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { test } from 'node:test';
import { DaemonApp, SingleInstanceError, type DaemonAppOptions } from '../src/daemon/app.js';
import { defaultConfig, type DaemonConfig } from '../src/daemon/config.js';
import { Logger } from '../src/daemon/logger.js';
import { createEnvelope, createHostEventEnvelope, type MessageEnvelope } from '../src/protocol/index.js';
import { PROTOCOL_VERSION, type ShutdownReason } from '../src/protocol/types.js';
import { buildStagingFileName, writeStaging } from '../src/bridge/staging.js';
import {
  clearPetSuppressed,
  getDaemonLockPath,
  getPetRecoveryGatePath,
  getPetRecoveryPath,
  isPetRecoveryPending,
  setPetRecoveryPending,
  setPetSuppressed,
} from '../src/bridge/daemon.js';

const isWindows = process.platform === 'win32';

/** 测试日志：只留 error，静默运行。 */
const silentLogger = new Logger({ level: 'error', filePath: null });

function uniquePipeName(prefix: string): string {
  return `\\\\.\\pipe\\KPet.Test.${prefix}.${process.pid}.${randomUUID().slice(0, 8)}`;
}

/** 测试配置：renderer_path 指向不存在的 exe（不拉起真渲染进程，验证缺失兜底）。 */
function testConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    ...defaultConfig({}),
    renderer_path: path.join(os.tmpdir(), 'kpet-test', 'KPet-nonexistent.exe'),
    log_level: 'error',
    ...overrides,
  };
}

/** 模拟转发器：连接事件管道写入一条 host_event（+ \n 分帧）后断开。与转发器一致，信封携带解析出的 session_id。 */
function writeHostEvent(pipeName: string, raw: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipeName);
    socket.on('connect', () => {
      socket.write(JSON.stringify(createHostEventEnvelope(raw, JSON.parse(raw))) + '\n', () => {
        socket.end();
        resolve();
      });
    });
    socket.on('error', reject);
  });
}

/** 模拟渲染进程：连入控制管道，按行分帧收消息，可发 hello/心跳。 */
class FakeRenderer {
  readonly socket: net.Socket;
  private readonly decoder = new StringDecoder('utf8');
  private buf = '';
  readonly messages: MessageEnvelope[] = [];
  private waiters: Array<{ type: string; resolve: (env: MessageEnvelope) => void; timer: NodeJS.Timeout }> = [];
  closed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buf += chunk;
      let idx = this.buf.indexOf('\n');
      while (idx >= 0) {
        const line = this.buf.slice(0, idx).replace(/\r$/, '');
        this.buf = this.buf.slice(idx + 1);
        if (line.length > 0) this.dispatch(line);
        idx = this.buf.indexOf('\n');
      }
    });
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', () => {});
  }

  static connect(pipeName: string): Promise<FakeRenderer> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(pipeName);
      socket.once('connect', () => resolve(new FakeRenderer(socket)));
      socket.once('error', reject);
    });
  }

  send(env: MessageEnvelope): void {
    this.socket.write(JSON.stringify(env) + '\n');
  }

  hello(pid: number = process.pid): void {
    this.send(
      createEnvelope('hello', {
        protocol_version: PROTOCOL_VERSION,
        role: 'renderer',
        pid,
        version: 'test-fake',
        capabilities: [],
      }),
    );
  }

  heartbeat(): void {
    this.send(createEnvelope('heartbeat', { pid: process.pid, uptime_s: 1, state: 'Idle' }));
  }

  close(): void {
    this.socket.destroy();
  }

  /**
   * 等待下一条指定类型的消息（每条消息只被消费一次：扫描命中或 waiter 回调都把消息移出队列，
   * 避免「waiter 路径不推进消费位置」导致同一条消息被重复返回）。
   */
  waitFor(type: string, timeoutMs = 4000): Promise<MessageEnvelope> {
    const idx = this.messages.findIndex((m) => m.type === type);
    if (idx >= 0) {
      const [env] = this.messages.splice(idx, 1);
      return Promise.resolve(env!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(
          new Error(`等待 ${type} 超时（已收到: ${this.messages.map((m) => m.type).join(', ') || '(无)'}）`),
        );
      }, timeoutMs);
      this.waiters.push({ type, resolve, timer });
    });
  }

  private dispatch(line: string): void {
    let env: MessageEnvelope;
    try {
      env = JSON.parse(line) as MessageEnvelope;
    } catch {
      return;
    }
    // 有等待者则直接交付并消费；无等待者暂存队列（后续 waitFor 扫描命中）
    const waiterIdx = this.waiters.findIndex((w) => w.type === env.type);
    if (waiterIdx >= 0) {
      const [w] = this.waiters.splice(waiterIdx, 1);
      clearTimeout(w!.timer);
      w!.resolve(env);
      return;
    }
    this.messages.push(env);
  }
}

interface TestApp {
  app: DaemonApp;
  eventPipe: string;
  controlPipe: string;
  stagingDir: string;
  exits: ShutdownReason[];
}

/** 启动一个测试用守护进程（缺省配置 + 可覆盖），渲染进程路径缺失（不拉起真进程）。 */
async function startApp(
  overrides: Partial<DaemonConfig> = {},
  appOverrides: Partial<DaemonAppOptions> = {},
): Promise<TestApp> {
  const eventPipe = uniquePipeName('H2D');
  const controlPipe = uniquePipeName('PET');
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-staging-test-'));
  const exits: ShutdownReason[] = [];
  const app = new DaemonApp({
    config: testConfig(overrides),
    logger: silentLogger,
    eventPipeName: eventPipe,
    controlPipeName: controlPipe,
    stagingDir,
    onExit: (r) => exits.push(r),
    exitGraceMs: 100,
    ...appOverrides,
  });
  await app.start();
  return { app, eventPipe, controlPipe, stagingDir, exits };
}

async function stopApp(t: TestApp): Promise<void> {
  await t.app.stop();
  fs.rmSync(t.stagingDir, { recursive: true, force: true });
}

test('冷启动握手：hello 回包 + 快照（无会话 → pet_state:Idle）', { skip: !isWindows }, async () => {
  const t = await startApp();
  try {
    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    const hello = await r.waitFor('hello');
    assert.equal((hello.payload as { role: string }).role, 'daemon');
    assert.equal((hello.payload as { protocol_version: number }).protocol_version, PROTOCOL_VERSION);
    const ps = await r.waitFor('pet_state');
    assert.deepEqual(ps.payload, { state: 'Idle', reason: 'boot' });
    const snap = await r.waitFor('tasks_snapshot');
    assert.deepEqual(snap.payload, { tasks: [] });
    r.close();
  } finally {
    await stopApp(t);
  }
});

test('全链路：转发器事件 → 渲染进程收到 session_start / pet_state Working / task_start / pet_state Idle', { skip: !isWindows }, async () => {
  const t = await startApp();
  try {
    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    await r.waitFor('hello');
    const bootPs = await r.waitFor('pet_state'); // 握手快照中的 pet_state:Idle
    assert.deepEqual(bootPs.payload, { state: 'Idle', reason: 'boot' });

    await writeHostEvent(t.eventPipe, '{"hook_event_name":"SessionStart","session_id":"s1","cwd":"D:\\\\ws1","matcher":"startup"}');
    const ss = await r.waitFor('session_start');
    assert.equal(ss.session_id, 's1');
    assert.deepEqual(ss.payload, { cwd: 'D:\\ws1', resume: false });

    await writeHostEvent(t.eventPipe, '{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"D:\\\\ws1"}');
    const ps = await r.waitFor('pet_state');
    assert.deepEqual(ps.payload, { state: 'Working', reason: 'user_prompt' });

    await writeHostEvent(t.eventPipe, '{"hook_event_name":"PreToolUse","session_id":"s1","cwd":"D:\\\\ws1","tool_name":"bash","tool_input":{"command":"npm test"}}');
    const ts = await r.waitFor('task_start'); // 200ms 节流窗口后到达
    assert.deepEqual(ts.payload, { task_id: (ts.payload as { task_id: string }).task_id, title: 'npm test', tool: 'bash' });
    assert.equal(ts.session_id, 's1');

    await writeHostEvent(t.eventPipe, '{"hook_event_name":"Stop","session_id":"s1","cwd":"D:\\\\ws1"}');
    const ps2 = await r.waitFor('pet_state');
    assert.deepEqual(ps2.payload, { state: 'Idle', reason: 'stop' });
    r.close();
  } finally {
    await stopApp(t);
  }
});

test('重连快照：握手时补发活跃会话 + 当前 pet_state + 未完成任务', { skip: !isWindows }, async () => {
  const t = await startApp();
  try {
    await writeHostEvent(t.eventPipe, '{"hook_event_name":"SessionStart","session_id":"s1","cwd":"D:\\\\a"}');
    await writeHostEvent(t.eventPipe, '{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"D:\\\\a"}');
    await writeHostEvent(t.eventPipe, '{"hook_event_name":"PreToolUse","session_id":"s1","cwd":"D:\\\\a","tool_name":"bash","tool_input":{"command":"build"}}');

    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    const ss = await r.waitFor('session_start');
    assert.equal(ss.session_id, 's1');
    assert.equal((ss.payload as { cwd: string }).cwd, 'D:\\a');
    const ps = await r.waitFor('pet_state');
    assert.deepEqual(ps.payload, { state: 'Working', reason: 'user_prompt' });
    const snap = await r.waitFor('tasks_snapshot');
    const tasks = (snap.payload as { tasks: Array<{ task_id: string; title: string; tool: string; started_at: string }> }).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.title, 'build');
    assert.equal(tasks[0]!.tool, 'bash');
    assert.ok(!Number.isNaN(Date.parse(tasks[0]!.started_at)));
    r.close();
  } finally {
    await stopApp(t);
  }
});

test('会话状态快照与 open_tui：握手补发状态，打开会话清除 unread 并回传更新', { skip: !isWindows }, async () => {
  const opened: Array<{ terminal: string; cwd: string; sessionId: string | null }> = [];
  const t = await startApp({}, {
    openTuiFn: async (opts) => {
      opened.push(opts);
      return { terminal: opts.terminal, ok: true };
    },
  });
  try {
    await writeHostEvent(t.eventPipe, '{"hook_event_name":"SessionStart","session_id":"s1","cwd":"D:\\\\w"}');
    await writeHostEvent(t.eventPipe, '{"hook_event_name":"Stop","session_id":"s1","cwd":"D:\\\\w"}');

    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    await r.waitFor('hello');
    const ss = await r.waitFor('session_start');
    assert.equal(ss.session_id, 's1');
    const snapshotState = await r.waitFor('session_state');
    assert.equal(snapshotState.session_id, 's1');
    assert.deepEqual(snapshotState.payload, { working: false, unread: true });

    r.send(createEnvelope('open_tui', { session_id: 's1', source: 'pet' }));
    const readState = await r.waitFor('session_state');
    assert.equal(readState.session_id, 's1');
    assert.deepEqual(readState.payload, { working: false, unread: false });
    await waitUntil(() => opened.length === 1, 1000);
    assert.deepEqual(opened[0], { target: 'cli', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/', cwd: 'D:\\w', sessionId: 's1', wslDistro: '' });
    r.close();
  } finally {
    await stopApp(t);
  }
});

test('会话目录握手合并与历史 open_tui：目录项下发并使用目录 cwd', { skip: !isWindows }, async () => {
  const opened: Array<{ terminal: string; cwd: string; sessionId: string | null }> = [];
  const t = await startApp({}, {
    sessionCatalog: () => [
      { sessionId: 'history-1', title: '历史会话', cwd: 'D:\\history', updatedAt: 1234 },
    ],
    openTuiFn: async (opts) => {
      opened.push(opts);
      return { terminal: opts.terminal, ok: true };
    },
  });
  try {
    await writeHostEvent(t.eventPipe, '{"hook_event_name":"SessionStart","session_id":"active-1","cwd":"D:\\\\active"}');
    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    await r.waitFor('hello');
    const sessions = await r.waitFor('sessions_snapshot');
    assert.deepEqual(sessions.payload, {
      sessions: [
        {
          session_id: 'active-1', title: '', cwd: 'D:\\active', active: true,
          working: false, unread: false, updated_at: 0,
        },
        {
          session_id: 'history-1', title: '历史会话', cwd: 'D:\\history', active: false,
          working: false, unread: false, updated_at: 1234,
        },
      ],
    });

    r.send(createEnvelope('open_tui', { session_id: 'history-1', source: 'bubble' }));
    await waitUntil(() => opened.length === 1, 1000);
    assert.deepEqual(opened[0], { target: 'cli', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/', cwd: 'D:\\history', sessionId: 'history-1', wslDistro: '' });
    r.close();
  } finally {
    await stopApp(t);
  }
});

test('刚结束且目录尚未落盘的会话仍使用本轮记录的 cwd 打开', { skip: !isWindows }, async () => {
  const opened: Array<{ terminal: string; cwd: string; sessionId: string | null }> = [];
  const t = await startApp({ host_grace_seconds: 30 }, {
    sessionCatalog: () => [],
    openTuiFn: async (opts) => {
      opened.push(opts);
      return { terminal: opts.terminal, ok: true };
    },
  });
  try {
    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    await r.waitFor('hello');
    await writeHostEvent(t.eventPipe, '{"hook_event_name":"SessionStart","session_id":"just-ended","cwd":"D:\\\\fresh"}');
    await r.waitFor('session_start');
    await writeHostEvent(t.eventPipe, '{"hook_event_name":"SessionEnd","session_id":"just-ended","cwd":"D:\\\\fresh","reason":"exit"}');
    await r.waitFor('session_end');

    r.send(createEnvelope('open_tui', { session_id: 'just-ended', source: 'pet' }));
    await waitUntil(() => opened.length === 1, 1000);
    assert.deepEqual(opened[0], { target: 'cli', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/', cwd: 'D:\\fresh', sessionId: 'just-ended', wslDistro: '' });
    r.close();
  } finally {
    await stopApp(t);
  }
});

test('open_target=web：open_tui 以 web 目标唤起并透传 URL 模板', { skip: !isWindows }, async () => {
  const opened: Array<{ target?: string; terminal: string; webUrl?: string; cwd: string; sessionId: string | null }> = [];
  const t = await startApp({ open_target: 'web', open_web_url: 'http://127.0.0.1:58627/?s={session_id}' }, {
    openTuiFn: async (opts) => {
      opened.push(opts);
      return { terminal: 'web', ok: true };
    },
  });
  try {
    await writeHostEvent(t.eventPipe, '{"hook_event_name":"SessionStart","session_id":"s1","cwd":"D:\\\\ws"}');
    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    await r.waitFor('hello');
    await r.waitFor('session_start');
    r.send(createEnvelope('open_tui', { session_id: 's1', source: 'pet' }));
    await waitUntil(() => opened.length === 1, 1000);
    assert.deepEqual(opened[0], {
      target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/?s={session_id}', cwd: 'D:\\ws', sessionId: 's1', wslDistro: '',
    });
    r.close();
  } finally {
    await stopApp(t);
  }
});

test('open_tui 唤起失败：补发 error 气泡，用户可感知', { skip: !isWindows }, async () => {
  const t = await startApp({}, {
    openTuiFn: async (opts) => ({ terminal: opts.terminal, ok: false, error: 'wt.exe 不存在' }),
  });
  try {
    await writeHostEvent(t.eventPipe, '{"hook_event_name":"SessionStart","session_id":"s1","cwd":"D:\\\\ws"}');
    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    await r.waitFor('hello');
    await r.waitFor('session_start');
    r.send(createEnvelope('open_tui', { session_id: 's1', source: 'pet' }));
    const notify = await r.waitFor('notify');
    assert.equal(notify.session_id, 's1');
    assert.equal((notify.payload as { level: string }).level, 'error');
    assert.match((notify.payload as { text: string }).text, /打开会话失败/);
    r.close();
  } finally {
    await stopApp(t);
  }
});

test('并发风暴：30 条转发器并发写入全部处理，互不干扰', { skip: !isWindows }, async () => {
  const t = await startApp();
  try {
    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    await r.waitFor('hello');

    const N = 30;
    const writes = [];
    for (let i = 0; i < N; i++) {
      writes.push(
        writeHostEvent(t.eventPipe, `{"hook_event_name":"SessionStart","session_id":"s${i}","cwd":"D:\\\\w"}`),
      );
    }
    await Promise.all(writes);
    for (let i = 0; i < N; i++) {
      const ss = await r.waitFor('session_start', 8000);
      assert.equal((ss.payload as { cwd: string }).cwd, 'D:\\w');
    }
    r.close();
  } finally {
    await stopApp(t);
  }
});

test('非法帧容错：非法 JSON/非法信封/非 host_event 跳过并计数，后续合法事件不受影响', { skip: !isWindows }, async () => {
  const t = await startApp();
  try {
    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    await r.waitFor('hello');
    await r.waitFor('pet_state'); // 消费握手快照中的 pet_state:Idle

    await writeRaw(t.eventPipe, 'this is not json'); // 非法 JSON
    await writeRaw(t.eventPipe, '{"v":1,"type":"host_event","ts":"bad","session_id":null,"payload":{}}'); // 非法信封
    await writeRaw(t.eventPipe, JSON.stringify(createEnvelope('heartbeat', { pid: 1, uptime_s: 0, state: 'Idle' })) + '\n'); // 非 host_event 类型

    await writeHostEvent(t.eventPipe, '{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"D:\\\\w"}');
    const ps = await r.waitFor('pet_state');
    assert.deepEqual(ps.payload, { state: 'Working', reason: 'user_prompt' }, '非法帧之后合法事件照常处理');
    r.close();
  } finally {
    await stopApp(t);
  }
});

test('退出倒计时：最后一个 SessionEnd → host_grace_seconds → shutdown(host_gone) + onExit', { skip: !isWindows }, async () => {
  const t = await startApp({ host_grace_seconds: 1 });
  try {
    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    await r.waitFor('hello');
    await writeHostEvent(t.eventPipe, '{"hook_event_name":"SessionStart","session_id":"s1","cwd":"D:\\\\w"}');
    await r.waitFor('session_start');

    await writeHostEvent(t.eventPipe, '{"hook_event_name":"SessionEnd","session_id":"s1","reason":"exit"}');
    const sd = await r.waitFor('shutdown', 6000);
    assert.deepEqual(sd.payload, { reason: 'host_gone' });
    await waitUntil(() => t.exits.length === 1, 3000);
    assert.equal(t.exits[0], 'host_gone');
    r.close();
  } finally {
    await stopApp(t);
  }
});

test('退出倒计时取消：倒计时内新宿主事件到达 → 不退出', { skip: !isWindows }, async () => {
  const t = await startApp({ host_grace_seconds: 1 });
  try {
    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    await r.waitFor('hello');
    await writeHostEvent(t.eventPipe, '{"hook_event_name":"SessionEnd","session_id":"old","reason":"exit"}');
    // 立即开新会话（倒计时内）
    await writeHostEvent(t.eventPipe, '{"hook_event_name":"SessionStart","session_id":"new","cwd":"D:\\\\w"}');
    const ss = await r.waitFor('session_start');
    assert.equal(ss.session_id, 'new');
    // 等待超过 grace + 宽限，确认没有退出
    await new Promise((res) => setTimeout(res, 2500));
    assert.equal(t.exits.length, 0, '倒计时被取消，不应退出');
    r.close();
  } finally {
    await stopApp(t);
  }
});

test('用户关闭协议：close_pet → shutdown(reason=user)，释放管道并持久化抑制标记', { skip: !isWindows }, async () => {
  const markerBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-close-test-'));
  const suppressionPath = path.join(markerBase, 'pet.disabled');
  const lockPath = getDaemonLockPath(path.join(markerBase, 'tmp'));
  const t = await startApp({}, { suppressionPath, daemonLockPath: lockPath });
  try {
    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    await r.waitFor('hello');
    await r.waitFor('pet_state');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, 'old-lock', 'utf8');

    r.send(createEnvelope('close_pet', { reason: 'user' }));
    const shutdown = await r.waitFor('shutdown');
    assert.deepEqual(shutdown.payload, { reason: 'user' });
    await waitUntil(() => t.exits.length === 1, 3000);
    assert.equal(t.exits[0], 'user');
    assert.equal(fs.existsSync(suppressionPath), true, '用户关闭后保留抑制标记');
    assert.equal(fs.existsSync(lockPath), true, '旧 daemon 不得无条件删除可能已被新进程接管的拉起锁');
    r.close();
  } finally {
    await stopApp(t);
    fs.rmSync(markerBase, { recursive: true, force: true });
  }
});

test('启动竞态：已有用户关闭标记时 daemon 立即退出并释放服务端管道', { skip: !isWindows }, async () => {
  const markerBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-start-suppressed-test-'));
  const suppressionPath = path.join(markerBase, 'pet.disabled');
  assert.equal(setPetSuppressed(suppressionPath), true);
  const t = await startApp({}, { suppressionPath, daemonLockPath: path.join(markerBase, 'daemon.lock') });
  try {
    await waitUntil(() => t.exits.length === 1, 3000);
    assert.equal(t.exits[0], 'user');
    assert.equal(fs.existsSync(suppressionPath), true, '启动竞态退出不应误删关闭标记');
  } finally {
    await stopApp(t);
    fs.rmSync(markerBase, { recursive: true, force: true });
  }
});

test('恢复启动竞态：构造后才消费抑制标记仍须取得恢复所有权并回放', { skip: !isWindows }, async () => {
  const markerBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-late-recovery-owner-test-'));
  const eventPipe = uniquePipeName('H2D');
  const controlPipe = uniquePipeName('PET');
  const stagingDir = path.join(markerBase, 'staging');
  const suppressionPath = path.join(markerBase, 'pet.disabled');
  const recoveryPath = getPetRecoveryPath(markerBase);
  const fakeChild = {
    once: () => fakeChild,
    kill: () => true,
  } as unknown as import('node:child_process').ChildProcess;
  assert.equal(setPetSuppressed(suppressionPath), true);
  assert.equal(setPetRecoveryPending(recoveryPath), true);
  const staged = writeStaging(
    createHostEventEnvelope('{"hook_event_name":"SessionStart","session_id":"late-owner"}'),
    stagingDir,
  );
  assert.ok(staged);
  const app = new DaemonApp({
    config: testConfig({ renderer_path: import.meta.filename }),
    logger: silentLogger,
    eventPipeName: eventPipe,
    controlPipeName: controlPipe,
    stagingDir,
    suppressionPath,
    recoveryPath,
    rendererSpawn: () => fakeChild,
  });

  // 模拟 worker 在 DaemonApp 构造后、start 建立管道前才消费 suppression。
  assert.equal(clearPetSuppressed(suppressionPath), true);
  try {
    await app.start();
    assert.equal(isPetRecoveryPending(recoveryPath), false, '启动时应重新判定并完成恢复交接');
    assert.deepEqual(fs.readdirSync(stagingDir), [], '恢复暂存必须完成回放');
    const renderer = await FakeRenderer.connect(controlPipe);
    renderer.hello();
    await renderer.waitFor('hello');
    const snapshot = await renderer.waitFor('sessions_snapshot');
    assert.equal((snapshot.payload as { sessions: Array<{ session_id: string }> }).sessions.some(
      (session) => session.session_id === 'late-owner',
    ), true);
    renderer.close();
  } finally {
    await app.stop();
    fs.rmSync(markerBase, { recursive: true, force: true });
  }
});

test('关闭恢复竞态：旧 daemon 延迟 close_pet 不得重写抑制标记或删除恢复期 SessionStart', { skip: !isWindows }, async () => {
  const markerBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-delayed-close-test-'));
  const suppressionPath = path.join(markerBase, 'pet.disabled');
  const recoveryPath = getPetRecoveryPath(markerBase);
  const stagingDir = path.join(markerBase, 'staging');
  const lockPath = getDaemonLockPath(markerBase);
  const t = await startApp({}, { suppressionPath, recoveryPath, stagingDir, daemonLockPath: lockPath });
  try {
    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    await r.waitFor('hello');
    await r.waitFor('pet_state');

    assert.equal(setPetSuppressed(suppressionPath), true);
    assert.equal(setPetRecoveryPending(recoveryPath), true);
    const staged = writeStaging(
      createHostEventEnvelope('{"hook_event_name":"SessionStart","session_id":"next","cwd":"D:\\\\next"}'),
      stagingDir,
    );
    assert.ok(staged);

    // 验证旧 daemon 不会把 suppression 重写成新的关闭时间。
    const oldMarkerTime = new Date('2026-01-01T00:00:00.000Z');
    fs.utimesSync(suppressionPath, oldMarkerTime, oldMarkerTime);
    const markerMtimeBefore = fs.statSync(suppressionPath).mtimeMs;

    r.send(createEnvelope('close_pet', { reason: 'user' }));
    const shutdown = await r.waitFor('shutdown');
    assert.deepEqual(shutdown.payload, { reason: 'user' });
    await waitUntil(() => t.exits.length === 1, 3000);

    assert.equal(isPetRecoveryPending(recoveryPath), true, '旧 daemon 不得消费恢复标记');
    assert.equal(fs.existsSync(suppressionPath), true, '本用例原有标记仍在');
    assert.equal(fs.statSync(suppressionPath).mtimeMs, markerMtimeBefore, '旧 daemon 不得重建或改写 suppression');
    assert.equal(fs.readdirSync(stagingDir).filter((file) => file.endsWith('.json')).length, 1, '恢复期 SessionStart 必须保留');
    r.close();
  } finally {
    await stopApp(t);
    fs.rmSync(markerBase, { recursive: true, force: true });
  }
});

test('心跳超时判死：停发心跳 → 连接被关闭', { skip: !isWindows }, async () => {
  const t = await startApp({ heartbeat_timeout_ms: 600 });
  try {
    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    await r.waitFor('hello');
    // 不再发任何消息（不心跳）→ 守护进程 ~1s 后按崩溃处理断开
    await waitUntil(() => r.closed, 4000);
    assert.equal(r.closed, true);
  } finally {
    await stopApp(t);
  }
});

test('暂存回收：启动前落暂存文件 → 启动后按字典序重放并删除', { skip: !isWindows }, async () => {
  const eventPipe = uniquePipeName('H2D');
  const controlPipe = uniquePipeName('PET');
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-staging-test-'));
  const exits: ShutdownReason[] = [];
  try {
    // 先落两个暂存文件（字典序 = 时间序）
    const f1 = path.join(stagingDir, buildStagingFileName(new Date('2026-07-31T08:00:00.000Z')));
    const f2 = path.join(stagingDir, buildStagingFileName(new Date('2026-07-31T08:00:01.000Z')));
    fs.writeFileSync(f1, JSON.stringify(createHostEventEnvelope('{"hook_event_name":"SessionStart","session_id":"r1","cwd":"D:\\\\r"}')), 'utf8');
    fs.writeFileSync(f2, JSON.stringify(createHostEventEnvelope('{"hook_event_name":"UserPromptSubmit","session_id":"r1","cwd":"D:\\\\r"}')), 'utf8');

    const app = new DaemonApp({
      config: testConfig(),
      logger: silentLogger,
      eventPipeName: eventPipe,
      controlPipeName: controlPipe,
      stagingDir,
      onExit: (r) => exits.push(r),
      exitGraceMs: 100,
    });
    await app.start();

    // 渲染进程连入 → 快照应包含暂存重放的会话与 Working 状态
    const r = await FakeRenderer.connect(controlPipe);
    r.hello();
    const ss = await r.waitFor('session_start');
    assert.equal(ss.session_id, 'r1');
    const ps = await r.waitFor('pet_state');
    assert.equal((ps.payload as { state: string }).state, 'Working', '暂存重放后状态为 Working');
    r.close();
    assert.deepEqual(fs.readdirSync(stagingDir), [], '重放后文件删除');
    await app.stop();
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('恢复 daemon：交接锁内按序回放后才启动 renderer，随后新 close_pet 仍正常抑制', { skip: !isWindows }, async () => {
  const markerBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-recovery-owner-test-'));
  const eventPipe = uniquePipeName('H2D');
  const controlPipe = uniquePipeName('PET');
  const stagingDir = path.join(markerBase, 'staging');
  const suppressionPath = path.join(markerBase, 'pet.disabled');
  const recoveryPath = getPetRecoveryPath(markerBase);
  const gatePath = getPetRecoveryGatePath(recoveryPath);
  const exits: ShutdownReason[] = [];
  let rendererSpawns = 0;
  const fakeChild = {
    once: () => fakeChild,
    kill: () => true,
  } as unknown as import('node:child_process').ChildProcess;
  assert.equal(setPetRecoveryPending(recoveryPath), true);
  writeStaging(
    createHostEventEnvelope('{"hook_event_name":"SessionStart","session_id":"r1","cwd":"D:\\\\r"}'),
    stagingDir,
    new Date('2026-08-12T01:00:00.000Z'),
  );
  writeStaging(
    createHostEventEnvelope('{"hook_event_name":"UserPromptSubmit","session_id":"r1","cwd":"D:\\\\r"}'),
    stagingDir,
    new Date('2026-08-12T01:00:01.000Z'),
  );

  // rendererPath 必须存在才会调用注入 spawn，用当前测试文件作为无害占位。
  const app = new DaemonApp({
    config: testConfig({ renderer_path: import.meta.filename }),
    logger: silentLogger,
    eventPipeName: eventPipe,
    controlPipeName: controlPipe,
    stagingDir,
    suppressionPath,
    recoveryPath,
    daemonLockPath: path.join(markerBase, 'daemon.lock'),
    rendererSpawn: () => {
      rendererSpawns++;
      assert.equal(isPetRecoveryPending(recoveryPath), false, 'renderer 启动前必须已完成回放与恢复交接');
      assert.deepEqual(fs.readdirSync(stagingDir), [], 'renderer 启动前 staging 必须已清空');
      return fakeChild;
    },
    onExit: (reason) => exits.push(reason),
    exitGraceMs: 100,
  });

  try {
    await app.start();
    assert.equal(rendererSpawns, 1);
    assert.equal(fs.existsSync(gatePath), false, '回放完成后必须释放交接锁');

    const renderer = await FakeRenderer.connect(controlPipe);
    renderer.hello();
    await renderer.waitFor('hello');
    const state = await renderer.waitFor('pet_state');
    assert.deepEqual(state.payload, { state: 'Working', reason: 'user_prompt' });
    renderer.send(createEnvelope('close_pet', { reason: 'user' }));
    const shutdown = await renderer.waitFor('shutdown');
    assert.deepEqual(shutdown.payload, { reason: 'user' });
    await waitUntil(() => exits.length === 1, 3000);
    assert.equal(fs.existsSync(suppressionPath), true, '恢复 owner 上的新关闭必须重新写入 suppression');
    renderer.close();
  } finally {
    await app.stop();
    fs.rmSync(markerBase, { recursive: true, force: true });
  }
});

test('恢复 daemon：下一批恢复建立后，延迟 close_pet 不得覆盖新批次', { skip: !isWindows }, async () => {
  const markerBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-recovery-owner-delayed-close-test-'));
  const eventPipe = uniquePipeName('H2D');
  const controlPipe = uniquePipeName('PET');
  const stagingDir = path.join(markerBase, 'staging');
  const suppressionPath = path.join(markerBase, 'pet.disabled');
  const recoveryPath = getPetRecoveryPath(markerBase);
  const exits: ShutdownReason[] = [];
  const fakeChild = {
    once: () => fakeChild,
    kill: () => true,
  } as unknown as import('node:child_process').ChildProcess;
  assert.equal(setPetRecoveryPending(recoveryPath), true);
  writeStaging(
    createHostEventEnvelope('{"hook_event_name":"SessionStart","session_id":"r1","cwd":"D:\\\\r"}'),
    stagingDir,
  );
  const app = new DaemonApp({
    config: testConfig({ renderer_path: import.meta.filename }),
    logger: silentLogger,
    eventPipeName: eventPipe,
    controlPipeName: controlPipe,
    stagingDir,
    suppressionPath,
    recoveryPath,
    daemonLockPath: path.join(markerBase, 'daemon.lock'),
    rendererSpawn: () => fakeChild,
    onExit: (reason) => exits.push(reason),
    exitGraceMs: 100,
  });

  try {
    await app.start();
    const renderer = await FakeRenderer.connect(controlPipe);
    renderer.hello();
    await renderer.waitFor('hello');
    await renderer.waitFor('pet_state');

    // 模拟 UE 已落关闭标记、而下一次 SessionStart 先于旧 close_pet 到达并建立新恢复批次。
    assert.equal(setPetSuppressed(suppressionPath), true);
    assert.equal(setPetRecoveryPending(recoveryPath), true);
    const nextStaged = writeStaging(
      createHostEventEnvelope('{"hook_event_name":"SessionStart","session_id":"r2","cwd":"D:\\\\next"}'),
      stagingDir,
    );
    assert.ok(nextStaged);
    const markerTime = new Date('2026-01-02T00:00:00.000Z');
    fs.utimesSync(suppressionPath, markerTime, markerTime);
    const markerMtimeBefore = fs.statSync(suppressionPath).mtimeMs;

    renderer.send(createEnvelope('close_pet', { reason: 'user' }));
    await renderer.waitFor('shutdown');
    await waitUntil(() => exits.length === 1, 3000);

    assert.equal(fs.statSync(suppressionPath).mtimeMs, markerMtimeBefore, '延迟关闭不得改写下一批 suppression');
    assert.equal(isPetRecoveryPending(recoveryPath), true, '延迟关闭不得清除下一批恢复标记');
    assert.equal(fs.existsSync(nextStaged!), true, '延迟关闭不得删除下一批 SessionStart 暂存');
    renderer.close();
  } finally {
    await app.stop();
    fs.rmSync(markerBase, { recursive: true, force: true });
  }
});

test('单实例：事件管道被占用 → 第二个实例抛 SingleInstanceError', { skip: !isWindows }, async () => {
  const eventPipe = uniquePipeName('H2D');
  const controlPipe = uniquePipeName('PET');
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-staging-test-'));
  const app1 = new DaemonApp({
    config: testConfig(),
    logger: silentLogger,
    eventPipeName: eventPipe,
    controlPipeName: controlPipe,
    stagingDir,
    exitGraceMs: 100,
  });
  await app1.start();
  try {
    const app2 = new DaemonApp({
      config: testConfig(),
      logger: silentLogger,
      eventPipeName: eventPipe,
      controlPipeName: uniquePipeName('PET2'),
      stagingDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-staging-test-')),
      exitGraceMs: 100,
    });
    await assert.rejects(app2.start(), SingleInstanceError);
  } finally {
    await app1.stop();
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('握手推送 config_snapshot：hello 快照收尾包含全量配置（设置 WebUI 初始化）', { skip: !isWindows }, async () => {
  const markerBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-config-snapshot-test-'));
  const configPath = path.join(markerBase, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ open_target: 'web' }), 'utf8');
  const t = await startApp({}, { configPath }); // 守护进程使用传入的测试配置，文件仅作持久化目标
  try {
    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    const snap = await r.waitFor('config_snapshot');
    assert.deepEqual(snap.payload, {
      open_target: 'cli',
      ui_theme: 'dark-glass',
      fps_monitor: false,
      open_web_url: 'http://127.0.0.1:58627/',
    }, '快照反映守护进程当前生效配置');
    r.close();
  } finally {
    await stopApp(t);
    fs.rmSync(markerBase, { recursive: true, force: true });
  }
});

test('update_config：应用合并、持久化写回（未知字段保留）、推送 config_snapshot、open_tui 读到新值', { skip: !isWindows }, async () => {
  const markerBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-update-config-test-'));
  const configPath = path.join(markerBase, 'kpet', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // 预置文件带未知字段 brand + 旧已知配置，验证合并时只覆盖 patch 字段
  fs.writeFileSync(configPath, JSON.stringify({ brand: 'kimi', open_target: 'web', ui_theme: 'light-minimal' }), 'utf8');
  const opened: Array<{ target?: string; terminal: string; webUrl?: string; cwd: string; sessionId: string | null }> = [];
  const t = await startApp({}, {
    configPath,
    openTuiFn: async (opts) => {
      opened.push(opts);
      return { terminal: opts.terminal, ok: true };
    },
  });
  try {
    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    const boot = await r.waitFor('config_snapshot');
    assert.deepEqual(boot.payload, {
      open_target: 'cli',
      ui_theme: 'dark-glass',
      fps_monitor: false,
      open_web_url: 'http://127.0.0.1:58627/',
    }, '启动快照为默认值');

    // 全部字段合法：合并 + 上报
    r.send(createEnvelope('update_config', { open_target: 'web', ui_theme: 'cute-pet', fps_monitor: true }));
    const snap = await r.waitFor('config_snapshot');
    assert.deepEqual(snap.payload, {
      open_target: 'web',
      ui_theme: 'cute-pet',
      fps_monitor: true,
      open_web_url: 'http://127.0.0.1:58627/',
    });

    // 持久化：未知字段 brand 保留，open_target/ui_theme 覆盖，fps_monitor 新增
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
      brand: 'kimi',
      open_target: 'web',
      ui_theme: 'cute-pet',
      fps_monitor: true,
    });
    assert.ok(fs.readFileSync(configPath, 'utf8').includes('\n  "open_target"'), '2 空格缩进写回');

    // open_tui 运行时读取更新后的 open_target（app.ts 运行时读取点）
    await writeHostEvent(t.eventPipe, '{"hook_event_name":"SessionStart","session_id":"s1","cwd":"D:\\\\ws"}');
    await r.waitFor('session_start');
    r.send(createEnvelope('open_tui', { session_id: 's1', source: 'pet' }));
    await waitUntil(() => opened.length === 1, 1000);
    assert.deepEqual(opened[0], {
      target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/', cwd: 'D:\\ws', sessionId: 's1', wslDistro: '',
    }, 'open_tui 使用更新后的 open_target');
    r.close();
  } finally {
    await stopApp(t);
    fs.rmSync(markerBase, { recursive: true, force: true });
  }
});

test('update_config 无合法字段：回 protocol_error、配置不变、不写文件、不推快照', { skip: !isWindows }, async () => {
  const markerBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-update-config-bad-test-'));
  const configPath = path.join(markerBase, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ open_target: 'cli', custom: 'x' }), 'utf8');
  const t = await startApp({}, { configPath });
  try {
    const r = await FakeRenderer.connect(t.controlPipe);
    r.hello();
    const boot = await r.waitFor('config_snapshot');
    assert.deepEqual(boot.payload, {
      open_target: 'cli',
      ui_theme: 'dark-glass',
      fps_monitor: false,
      open_web_url: 'http://127.0.0.1:58627/',
    });

    const before = fs.readFileSync(configPath, 'utf8');
    // 模拟非法负载（JSON 解析后运行时值，绕过 TS 静态类型）
    r.send(createEnvelope('update_config', { ui_theme: 'bogus', open_target: 'browser' } as never));
    const err = await r.waitFor('protocol_error');
    assert.equal((err.payload as { description: string }).description, 'update_config 至少需要一个合法字段');
    assert.equal(fs.readFileSync(configPath, 'utf8'), before, '无合法字段不应写文件');
    assert.equal(r.messages.some((m) => m.type === 'config_snapshot'), false, '无合法字段不应推送 config_snapshot');
    r.close();
  } finally {
    await stopApp(t);
    fs.rmSync(markerBase, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 向事件管道写任意原始行（模拟非法帧）。 */
function writeRaw(pipeName: string, rawLine: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipeName);
    socket.on('connect', () => {
      socket.write(rawLine.endsWith('\n') ? rawLine : rawLine + '\n', () => {
        socket.end();
        resolve();
      });
    });
    socket.on('error', reject);
  });
}

function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('等待条件超时'));
      setTimeout(tick, 20);
    };
    tick();
  });
}
