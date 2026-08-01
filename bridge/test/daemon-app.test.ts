/**
 * 守护进程集成测试（真实 Windows 命名管道，§4.1/§4.3/§4.5）：
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
import { buildStagingFileName } from '../src/bridge/staging.js';

const isWindows = process.platform === 'win32';

/** 测试日志：只留 error，静默运行。 */
const silentLogger = new Logger({ level: 'error', filePath: null });

function uniquePipeName(prefix: string): string {
  return `\\\\.\\pipe\\KimiPet.Test.${prefix}.${process.pid}.${randomUUID().slice(0, 8)}`;
}

/** 测试配置：renderer_path 指向不存在的 exe（不拉起真渲染进程，验证缺失兜底）。 */
function testConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    ...defaultConfig({}),
    renderer_path: path.join(os.tmpdir(), 'kimi-pet-test', 'KimiPet-nonexistent.exe'),
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
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-pet-staging-test-'));
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

test('冷启动握手（§4.5-1）：hello 回包 + 快照（无会话 → pet_state:Idle）', { skip: !isWindows }, async () => {
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

test('全链路（§3.4/§4.5-2）：转发器事件 → 渲染进程收到 session_start / pet_state Working / task_start / pet_state Idle', { skip: !isWindows }, async () => {
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

test('重连快照（§4.5-4）：握手时补发活跃会话 + 当前 pet_state + 未完成任务', { skip: !isWindows }, async () => {
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

test('并发风暴（§3.3/R9）：30 条转发器并发写入全部处理，互不干扰', { skip: !isWindows }, async () => {
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

test('非法帧容错（§4.4）：非法 JSON/非法信封/非 host_event 跳过并计数，后续合法事件不受影响', { skip: !isWindows }, async () => {
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

test('退出倒计时（§4.5-6）：最后一个 SessionEnd → host_grace_seconds → shutdown(host_gone) + onExit', { skip: !isWindows }, async () => {
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

test('退出倒计时取消（§4.5-6）：倒计时内新宿主事件到达 → 不退出', { skip: !isWindows }, async () => {
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

test('心跳超时判死（§4.5-4）：停发心跳 → 连接被关闭', { skip: !isWindows }, async () => {
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

test('暂存回收（§3.3）：启动前落暂存文件 → 启动后按字典序重放并删除', { skip: !isWindows }, async () => {
  const eventPipe = uniquePipeName('H2D');
  const controlPipe = uniquePipeName('PET');
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-pet-staging-test-'));
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

test('单实例（§4.1）：事件管道被占用 → 第二个实例抛 SingleInstanceError', { skip: !isWindows }, async () => {
  const eventPipe = uniquePipeName('H2D');
  const controlPipe = uniquePipeName('PET');
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-pet-staging-test-'));
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
      stagingDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-pet-staging-test-')),
      exitGraceMs: 100,
    });
    await assert.rejects(app2.start(), SingleInstanceError);
  } finally {
    await app1.stop();
    fs.rmSync(stagingDir, { recursive: true, force: true });
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
