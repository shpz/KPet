/**
 * 渲染进程监督测试（1s/2s/4s/8s 指数退避、60s 窗口最多 5 次、
 * renderer_path 缺失不退避刷屏、宿主事件重置）。
 * spawn 注入假子进程，时钟注入可控，纯事件驱动不依赖真实时间。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { backoffDelayMs, RendererSupervisor, type SpawnFn } from '../src/daemon/renderer.js';
import { Logger } from '../src/daemon/logger.js';

const silentLogger = new Logger({ level: 'error', filePath: null });

/** 假子进程：可控 emit exit/error。 */
interface FakeChild extends EventEmitter {
  killed: boolean;
  kill(): boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

interface Harness {
  supervisor: RendererSupervisor;
  children: FakeChild[];
  spawnCalls: SpawnCall[];
  spawnCount: number;
}

interface SpawnCall {
  command: string;
  args: string[];
  options: { cwd: string };
}

/** 构造测试台：假 spawn（每次返回新假子进程）、短退避间隔（10ms，逻辑同 1s/2s/4s/8s）。 */
function makeHarness(opts: { rendererPath: string; maxAttempts?: number; windowS?: number }): Harness {
  const children: FakeChild[] = [];
  const spawnCalls: SpawnCall[] = [];
  let spawnCount = 0;
  const spawnFn: SpawnFn = (command, args, options) => {
    spawnCount++;
    spawnCalls.push({ command, args: [...args], options: { ...options } });
    const child = fakeChild();
    children.push(child);
    // spawn 成功：由 supervisor 挂 error/exit 监听后再触发
    queueMicrotask(() => {
      if (!child.killed) child.emit('spawn');
    });
    return child as never;
  };
  const supervisor = new RendererSupervisor({
    rendererPath: opts.rendererPath,
    restartMaxAttempts: opts.maxAttempts ?? 5,
    restartWindowMs: (opts.windowS ?? 60) * 1000,
    logger: silentLogger,
    spawnFn,
    backoffDelay: () => 10, // 测试用短间隔（序列本身由 backoffDelayMs 单测覆盖）
  });
  return {
    supervisor,
    children,
    spawnCalls,
    get spawnCount() {
      return spawnCount;
    },
  };
}

/** 等待退避定时器触发（最长 waitMs）。 */
function waitFor(cond: () => boolean, waitMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - start > waitMs) return reject(new Error('等待条件超时'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('backoffDelayMs：1s/2s/4s/8s 指数序列，之后封顶 8s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(backoffDelayMs), [1000, 2000, 4000, 8000, 8000, 8000]);
});

test('渲染进程启动参数移除 RenderOffScreen 并使用安全窗口参数', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-renderer-test-'));
  const exe = path.join(dir, 'KPet.exe');
  fs.writeFileSync(exe, '');
  try {
    const h = makeHarness({ rendererPath: exe });
    h.supervisor.start();
    await waitFor(() => h.spawnCalls.length === 1);

    assert.deepEqual(h.spawnCalls[0], {
      command: exe,
      args: ['-NOSPLASH', '-windowed', '-ResX=16', '-ResY=16'],
      options: { cwd: dir },
    });
    assert.equal(h.spawnCalls[0]!.args.includes('-RenderOffScreen'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('冷启动拉起渲染进程；崩溃后按 1s/2s/4s 退避重启', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-renderer-test-'));
  const exe = path.join(dir, 'KPet.exe');
  fs.writeFileSync(exe, '');
  try {
    const h = makeHarness({ rendererPath: exe });
    h.supervisor.start();
    await waitFor(() => h.spawnCount === 1);
    assert.equal(h.supervisor.status, 'running');

    // 第一次崩溃 → 1s 后重启
    h.children[0]!.emit('exit', 1, null);
    await waitFor(() => h.spawnCount === 2);
    assert.equal(h.supervisor.status, 'running');

    // 第二次崩溃 → 2s 后重启
    h.children[1]!.emit('exit', 1, null);
    await waitFor(() => h.spawnCount === 3);

    // 第三次崩溃 → 4s 后重启
    h.children[2]!.emit('exit', 1, null);
    await waitFor(() => h.spawnCount === 4);
    assert.equal(h.supervisor.status, 'running');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('60s 窗口内最多 5 次（restart_max_attempts），超限停手等宿主事件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-renderer-test-'));
  const exe = path.join(dir, 'KPet.exe');
  fs.writeFileSync(exe, '');
  try {
    const h = makeHarness({ rendererPath: exe, maxAttempts: 5, windowS: 60 });
    h.supervisor.start();
    await waitFor(() => h.spawnCount === 1);
    // 连崩 5 次（每次都被自动重启）：第 5 次拉起后停手
    for (let i = 0; i < 5; i++) {
      await waitFor(() => h.spawnCount === i + 1);
      h.children[i]!.emit('exit', 1, null);
    }
    await waitFor(() => h.spawnCount === 5); // 第 5 次崩溃后不再拉起（窗口内已达 5 次）
    // 给足时间确认没有第 6 次
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(h.spawnCount, 5);
    assert.equal(h.supervisor.status, 'stopped');

    // 宿主事件 → 新的一轮尝试
    h.supervisor.onHostEvent();
    await waitFor(() => h.spawnCount === 6);
    assert.equal(h.supervisor.status, 'running');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderer_path 不存在：记日志不拉起、不退避刷屏，宿主事件后重试（联调兜底）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-renderer-test-'));
  const exe = path.join(dir, 'KPet.exe'); // 不存在
  try {
    const h = makeHarness({ rendererPath: exe });
    h.supervisor.start();
    assert.equal(h.supervisor.status, 'missing');
    assert.equal(h.spawnCount, 0);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.spawnCount, 0, '缺失路径绝不重复尝试');

    // 宿主事件到达且路径仍缺失 → 仍不拉起
    h.supervisor.onHostEvent();
    assert.equal(h.spawnCount, 0);

    // 路径出现后宿主事件 → 拉起
    fs.writeFileSync(exe, '');
    h.supervisor.onHostEvent();
    await waitFor(() => h.spawnCount === 1);
    assert.equal(h.supervisor.status, 'running');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('onConnectionLost：管道断开但进程仍在 → 强制结束走 exit 路径统一重启', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-renderer-test-'));
  const exe = path.join(dir, 'KPet.exe');
  fs.writeFileSync(exe, '');
  try {
    const h = makeHarness({ rendererPath: exe });
    h.supervisor.start();
    await waitFor(() => h.spawnCount === 1);
    h.supervisor.onConnectionLost(); // 管道断开，进程还活着
    assert.equal(h.children[0]!.killed, true, '应强制结束挂起进程');
    h.children[0]!.emit('exit', 1, null); // exit 路径触发重启
    await waitFor(() => h.spawnCount === 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shutdown 后不再重启（守护进程退出流程）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-renderer-test-'));
  const exe = path.join(dir, 'KPet.exe');
  fs.writeFileSync(exe, '');
  try {
    const h = makeHarness({ rendererPath: exe });
    h.supervisor.start();
    await waitFor(() => h.spawnCount === 1);
    h.supervisor.shutdown();
    h.children[0]!.emit('exit', 1, null); // 退出后不应重启
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.spawnCount, 1);
    assert.equal(h.supervisor.status, 'shutdown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('退避重启期间命中关闭标记：不再 spawn 且只通知一次', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-renderer-test-'));
  const exe = path.join(dir, 'KPet.exe');
  fs.writeFileSync(exe, '');
  try {
    const children: FakeChild[] = [];
    let spawnCount = 0;
    let suppressed = false;
    let suppressedCalls = 0;
    const supervisor = new RendererSupervisor({
      rendererPath: exe,
      restartMaxAttempts: 5,
      restartWindowMs: 60_000,
      logger: silentLogger,
      spawnFn: () => {
        spawnCount++;
        const child = fakeChild();
        children.push(child);
        return child as never;
      },
      backoffDelay: () => 10,
      isSuppressed: () => suppressed,
      onSuppressed: () => {
        suppressedCalls++;
      },
    });

    supervisor.start();
    await waitFor(() => spawnCount === 1);
    children[0]!.emit('exit', 1, null);
    await waitFor(() => supervisor.status === 'waiting');

    suppressed = true;
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(spawnCount, 1);
    assert.equal(supervisor.status, 'shutdown');
    assert.equal(suppressedCalls, 1);

    // 之后任何事件都不能再次回调或拉起进程。
    supervisor.onHostEvent();
    supervisor.onConnectionLost();
    assert.equal(spawnCount, 1);
    assert.equal(suppressedCalls, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn 和 scheduleRestart 入口命中关闭标记时统一关闭', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-renderer-test-'));
  const exe = path.join(dir, 'KPet.exe');
  fs.writeFileSync(exe, '');
  try {
    let spawnCount = 0;
    let suppressedCalls = 0;
    const options = {
      rendererPath: exe,
      restartMaxAttempts: 5,
      restartWindowMs: 60_000,
      logger: silentLogger,
      spawnFn: () => {
        spawnCount++;
        return fakeChild() as never;
      },
      backoffDelay: () => 10,
      isSuppressed: () => true,
      onSuppressed: () => {
        suppressedCalls++;
      },
    };

    const supervisor = new RendererSupervisor({ ...options, isSuppressed: () => true });
    supervisor.start();
    assert.equal(spawnCount, 0);
    assert.equal(supervisor.status, 'shutdown');
    assert.equal(suppressedCalls, 1);

    const restartSupervisor = new RendererSupervisor({ ...options, isSuppressed: () => true });
    (restartSupervisor as unknown as { scheduleRestart: (cause: string) => void }).scheduleRestart('测试');
    assert.equal(spawnCount, 0);
    assert.equal(restartSupervisor.status, 'shutdown');
    assert.equal(suppressedCalls, 2);

    supervisor.onHostEvent();
    supervisor.onConnectionLost();
    assert.equal(spawnCount, 0);
    assert.equal(suppressedCalls, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn 调用期间写入关闭标记：立即结束刚拉起的 renderer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-renderer-test-'));
  const exe = path.join(dir, 'KPet.exe');
  fs.writeFileSync(exe, '');
  try {
    let suppressed = false;
    let suppressedCalls = 0;
    const child = fakeChild();
    const supervisor = new RendererSupervisor({
      rendererPath: exe,
      restartMaxAttempts: 5,
      restartWindowMs: 60_000,
      logger: silentLogger,
      spawnFn: () => {
        suppressed = true;
        return child as never;
      },
      isSuppressed: () => suppressed,
      onSuppressed: () => {
        suppressedCalls++;
      },
    });

    supervisor.start();
    assert.equal(supervisor.status, 'shutdown');
    assert.equal(suppressedCalls, 1);
    assert.equal(child.killed, true, '竞态中已创建的 renderer 必须立即结束');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn 抛异常（同步失败）→ 视为缺失等宿主事件，不崩溃', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-renderer-test-'));
  const exe = path.join(dir, 'KPet.exe');
  fs.writeFileSync(exe, '');
  try {
    let clock = 1_000_000;
    const supervisor = new RendererSupervisor({
      rendererPath: exe,
      restartMaxAttempts: 5,
      restartWindowMs: 60_000,
      logger: silentLogger,
      spawnFn: () => {
        throw new Error('spawn boom');
      },
      now: () => clock,
    });
    supervisor.start();
    assert.equal(supervisor.status, 'missing');
    assert.equal(supervisor.child, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
