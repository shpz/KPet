/**
 * 集成测试（Windows 命名管道，§4.1）：
 * - echo 管道：本地 net server 充当命名管道服务端，验证转发器送达的 host_event 信封完整正确
 * - 管道不存在 → 写本地暂存兜底（§3.3）
 * - 非法 JSON → 放行，不连管道、不写暂存（§2.2 D4 / §3.3）
 *
 * 非 Windows 平台跳过（命名管道为 Windows 特性）。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { relayHostEvent, runDaemonRecoveryWorker } from '../src/bridge/main.js';
import {
  acquireDeliveryLease,
  acquireOwnedDaemonLock,
  clearPetSuppressed,
  clearPetRecoveryPending,
  getDaemonLockPath,
  getPetRecoveryGatePath,
  getPetRecoveryPath,
  getPetSuppressionPath,
  isPetRecoveryPending,
  setPetRecoveryPending,
  setPetSuppressed,
} from '../src/bridge/daemon.js';

const isWindows = process.platform === 'win32';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-pet-test-'));
}

function uniquePipeName(): string {
  return `\\\\.\\pipe\\KimiPet.Test.${process.pid}.${randomUUID().slice(0, 8)}`;
}

/** 建一个命名管道服务端，收到一条完整消息后 resolve 消息文本。所有连接与定时器在收尾时清理，保证进程可退出。 */
function listenOnce(pipeName: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<net.Socket>();
    const timer = setTimeout(() => {
      for (const s of sockets) s.destroy();
      server.close();
      reject(new Error('等待管道消息超时'));
    }, timeoutMs);
    timer.unref();

    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {
        // 探测连接的瞬时断开可能带错误，忽略
      });
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.includes('\n')) {
          const line = buf.split('\n')[0]!;
          clearTimeout(timer);
          for (const s of sockets) s.destroy();
          server.close();
          resolve(line);
        }
      });
    });
    server.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    server.listen(pipeName);
  });
}

test('集成：转发器经命名管道送达 host_event（_raw 透传原文）', { skip: !isWindows }, async () => {
  const pipeName = uniquePipeName();
  const received = listenOnce(pipeName);
  const raw = '{"hook_event_name":"PreToolUse","session_id":"session_9","cwd":"D:\\\\ws","tool_input":{"command":"npm test"}}';

  const result = await relayHostEvent(raw, { pipeName, spawnDaemon: false });
  assert.equal(result.outcome, 'delivered');

  const env = JSON.parse(await received);
  assert.equal(env.v, 1);
  assert.equal(env.type, 'host_event');
  assert.equal(env.session_id, 'session_9');
  assert.ok(env.id && typeof env.id === 'string');
  assert.ok(!Number.isNaN(Date.parse(env.ts)));
  assert.equal(env.payload._raw, raw, '_raw 与输入文本逐字符一致');
});

test('集成：管道不存在 → 写本地暂存兜底（§3.3）', { skip: !isWindows }, async () => {
  const stagingDir = tempDir();
  try {
    const raw = '{"hook_event_name":"Stop"}';
    const result = await relayHostEvent(raw, {
      pipeName: uniquePipeName(), // 绝不存在的管道
      spawnDaemon: false,
      stagingDir,
    });
    assert.equal(result.outcome, 'staged');
    const files = fs.readdirSync(stagingDir);
    assert.equal(files.length, 1);
    const env = JSON.parse(fs.readFileSync(path.join(stagingDir, files[0]!), 'utf8'));
    assert.equal(env.type, 'host_event');
    assert.equal(env.payload._raw, raw);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('集成：非法 JSON 直接放行，不连管道、不写暂存（§2.2 D4）', { skip: !isWindows }, async () => {
  const stagingDir = tempDir();
  let probeCalled = false;
  try {
    const result = await relayHostEvent('this is not json', {
      pipeName: uniquePipeName(),
      spawnDaemon: false,
      stagingDir,
      probe: async () => {
        probeCalled = true;
        return true;
      },
    });
    assert.equal(result.outcome, 'invalid_json');
    assert.equal(probeCalled, false, '非法输入不应触碰管道');
    assert.equal(fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir).length : 0, 0, '不应写暂存');
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('集成：管道探测成功但写入失败 → 暂存兜底（§3.3）', { skip: !isWindows }, async () => {
  const stagingDir = tempDir();
  let probeCalled = false;
  try {
    const result = await relayHostEvent('{"hook_event_name":"Interrupt"}', {
      pipeName: uniquePipeName(),
      spawnDaemon: false,
      stagingDir,
      probe: async () => {
        probeCalled = true;
        return true; // 探测到管道存在
      },
      write: async () => 'error', // 写入失败
    });
    assert.equal(probeCalled, true);
    assert.equal(result.outcome, 'staged');
    const files = fs.readdirSync(stagingDir);
    assert.equal(files.length, 1);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('关闭竞态：入口检查后才出现抑制标记时不得继续写管道或暂存', async () => {
  const base = tempDir();
  const stagingDir = path.join(base, 'staging');
  const suppressionPath = path.join(base, 'kimi-pet', 'pet.disabled');
  let writeCount = 0;
  try {
    const result = await relayHostEvent(
      '{"hook_event_name":"UserPromptSubmit","session_id":"old-session"}',
      {
        suppressionPath,
        stagingDir,
        spawnDaemon: false,
        probe: async () => {
          assert.equal(setPetSuppressed(suppressionPath), true);
          return false;
        },
        write: async () => {
          writeCount++;
          return 'error';
        },
      },
    );
    assert.equal(result.outcome, 'suppressed');
    assert.equal(writeCount, 0, '探测期间发生关闭后不得再尝试写旧事件');
    assert.equal(fs.existsSync(stagingDir), false, '关闭后的旧事件不得落入暂存');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('关闭竞态：暂存写入期间出现抑制标记时撤销本次旧事件文件', async () => {
  const base = tempDir();
  const stagingDir = path.join(base, 'staging');
  const suppressionPath = path.join(base, 'kimi-pet', 'pet.disabled');
  try {
    const result = await relayHostEvent(
      '{"hook_event_name":"UserPromptSubmit","session_id":"old-session"}',
      {
        suppressionPath,
        stagingDir,
        spawnDaemon: false,
        probe: async () => true,
        write: async () => 'error',
        staging: (envelope) => {
          fs.mkdirSync(stagingDir, { recursive: true });
          const stagedPath = path.join(stagingDir, 'racing-old-event.json');
          fs.writeFileSync(stagedPath, JSON.stringify(envelope), 'utf8');
          assert.equal(setPetSuppressed(suppressionPath), true);
          return stagedPath;
        },
      },
    );
    assert.equal(result.outcome, 'suppressed');
    assert.deepEqual(fs.readdirSync(stagingDir), [], '与关闭交叉的旧暂存文件必须撤销');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('关闭竞态：普通旧事件持锁期间并发 SessionStart，旧事件丢弃且只暂存 SessionStart', async () => {
  const base = tempDir();
  const stagingDir = path.join(base, 'staging');
  const suppressionPath = path.join(base, 'kimi-pet', 'pet.disabled');
  const recoveryPath = path.join(base, 'kimi-pet', 'pet.recovering');
  const sessionStarts: Array<ReturnType<typeof relayHostEvent>> = [];
  try {
    const oldEvent = await relayHostEvent(
      '{"hook_event_name":"UserPromptSubmit","session_id":"old-session"}',
      {
        suppressionPath,
        recoveryPath,
        stagingDir,
        spawnDaemon: false,
        probe: async () => {
          assert.equal(setPetSuppressed(suppressionPath), true);
          sessionStarts.push(relayHostEvent(
            '{"hook_event_name":"SessionStart","session_id":"new-session"}',
            {
              suppressionPath,
              recoveryPath,
              stagingDir,
              spawnDaemon: false,
              recoveryWaitMs: 0,
              probe: async () => false,
            },
          ));
          return false;
        },
      },
    );
    assert.equal(oldEvent.outcome, 'suppressed');
    assert.equal(sessionStarts.length, 1);
    assert.equal((await sessionStarts[0]!).outcome, 'staged');
    const files = fs.readdirSync(stagingDir).sort();
    assert.equal(files.length, 1);
    const envelope = JSON.parse(fs.readFileSync(path.join(stagingDir, files[0]!), 'utf8')) as { payload: { _raw: string } };
    assert.equal(JSON.parse(envelope.payload._raw).hook_event_name, 'SessionStart');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('正常转发并发：30 条 relay 的管道操作不被恢复登记锁串行化', async () => {
  const base = tempDir();
  const suppressionPath = path.join(base, 'kimi-pet', 'pet.disabled');
  const recoveryPath = path.join(base, 'kimi-pet', 'pet.recovering');
  let activeProbes = 0;
  let maxActiveProbes = 0;
  try {
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) => relayHostEvent(
      `{"hook_event_name":"PreToolUse","session_id":"parallel-${index}"}`,
      {
        suppressionPath,
        recoveryPath,
        spawnDaemon: false,
        probe: async () => {
          activeProbes++;
          maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          activeProbes--;
          return true;
        },
        write: async () => 'ok',
      },
    )));
    assert.equal(results.every((result) => result.outcome === 'delivered'), true);
    assert.ok(maxActiveProbes > 1, '恢复登记只能串行化短文件操作，不能串行化管道 I/O');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('转发器：用户关闭抑制期丢弃非 SessionStart 事件且不写暂存，SessionStart 消费标记恢复', async () => {
  const base = tempDir();
  const stagingDir = path.join(base, 'staging');
  const suppressionPath = path.join(base, 'kimi-pet', 'pet.disabled');
  const lockPath = path.join(base, 'kimi-pet', 'daemon.lock');
  let probeCount = 0;
  let writeCount = 0;
  let recoveryScheduled = false;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, 'old-lock', 'utf8');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'old.json'), '{}', 'utf8');
    assert.equal(setPetSuppressed(suppressionPath), true);

    const suppressed = await relayHostEvent(
      '{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"D:\\\\ws"}',
      {
        pipeName: uniquePipeName(),
        stagingDir,
        suppressionPath,
        daemonLockPath: lockPath,
        probe: async () => {
          probeCount++;
          return false;
        },
        write: async () => {
          writeCount++;
          return 'ok';
        },
      },
    );
    assert.equal(suppressed.outcome, 'suppressed');
    assert.equal(probeCount, 0);
    assert.equal(writeCount, 0);
    assert.deepEqual(fs.readdirSync(stagingDir), ['old.json'], '抑制事件不应新增长期暂存');

    const resumed = await relayHostEvent(
      '{"hook_event_name":"SessionStart","session_id":"s2","cwd":"D:\\\\ws"}',
      {
        pipeName: uniquePipeName(),
        stagingDir,
        suppressionPath,
        daemonLockPath: lockPath,
        recoveryPath: path.join(base, 'kimi-pet', 'pet.recovering'),
        recoveryWaitMs: 1,
        probe: async () => {
          probeCount++;
          return false;
        },
        scheduleRecovery: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          recoveryScheduled = true;
          return true;
        },
        write: async () => {
          writeCount++;
          return 'ok';
        },
      },
    );
    assert.equal(resumed.outcome, 'staged');
    assert.equal(probeCount, 1);
    assert.equal(writeCount, 0, '恢复交接期间不得直写管道');
    assert.equal(recoveryScheduled, true, '当前 hook 退出前必须确认恢复 worker 已启动');
    assert.equal(fs.existsSync(suppressionPath), true, '抑制标记由 worker 在旧管道释放后消费');
    assert.deepEqual(fs.readdirSync(stagingDir).length, 1, '旧暂存已清理，当前 SessionStart 已有序暂存');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('转发器：旧管道超时后 SessionStart 与后续事件保持有序暂存', async () => {
  const base = tempDir();
  const stagingDir = path.join(base, 'staging');
  const suppressionPath = getPetSuppressionPath(path.join(base, 'tmp'));
  const recoveryPath = getPetRecoveryPath(path.join(base, 'tmp'));
  try {
    assert.equal(setPetSuppressed(suppressionPath), true);
    const first = await relayHostEvent(
      '{"hook_event_name":"SessionStart","session_id":"s1","cwd":"D:\\\\ws"}',
      {
        pipeName: uniquePipeName(),
        stagingDir,
        suppressionPath,
        recoveryPath,
        spawnDaemon: false,
        recoveryWaitMs: 1,
        probe: async () => true,
        write: async () => 'ok',
      },
    );
    assert.equal(first.outcome, 'staged');
    assert.equal(fs.existsSync(suppressionPath), true, '旧管道释放前不得消费关闭标记');
    assert.equal(isPetRecoveryPending(recoveryPath), true, '旧管道未释放时进入恢复中阶段');
    assert.equal(fs.readdirSync(stagingDir).length, 1, '当前 SessionStart 已暂存');

    let writeCount = 0;
    const second = await relayHostEvent(
      '{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"D:\\\\ws"}',
      {
        pipeName: uniquePipeName(),
        stagingDir,
        suppressionPath,
        recoveryPath,
        spawnDaemon: false,
        recoveryWaitMs: 0,
        probe: async () => false,
        write: async () => {
          writeCount++;
          return 'ok';
        },
      },
    );
    assert.equal(second.outcome, 'staged', '恢复完成前后续事件必须继续暂存');
    assert.equal(writeCount, 0, '即使管道已释放也不得越过首个 SessionStart 直写');
    assert.equal(isPetRecoveryPending(recoveryPath), true, '恢复标记由新 daemon 完成重放后清除');
    const hooks = fs.readdirSync(stagingDir).sort().map((file) => {
      const env = JSON.parse(fs.readFileSync(path.join(stagingDir, file), 'utf8')) as { payload: { _raw: string } };
      return (JSON.parse(env.payload._raw) as { hook_event_name: string }).hook_event_name;
    });
    assert.deepEqual(hooks, ['SessionStart', 'UserPromptSubmit']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('并发 SessionStart：等待 gate 期间恢复已完成时不得重开恢复批次', async () => {
  const base = tempDir();
  const stagingDir = path.join(base, 'staging');
  const suppressionPath = getPetSuppressionPath(path.join(base, 'tmp'));
  const recoveryPath = getPetRecoveryPath(path.join(base, 'tmp'));
  const gate = acquireOwnedDaemonLock(getPetRecoveryGatePath(recoveryPath));
  assert.ok(gate);
  let writes = 0;
  let schedules = 0;
  try {
    assert.equal(setPetSuppressed(suppressionPath), true);
    const pending = relayHostEvent(
      '{"hook_event_name":"SessionStart","session_id":"s2","cwd":"D:\\\\ws"}',
      {
        pipeName: uniquePipeName(),
        stagingDir,
        suppressionPath,
        recoveryPath,
        probe: async () => true,
        write: async () => {
          writes++;
          return 'ok';
        },
        scheduleRecovery: () => {
          schedules++;
          return true;
        },
      },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(clearPetSuppressed(suppressionPath), true, '模拟首个并发事件已完成恢复');
    gate!.release();
    const result = await pending;

    assert.equal(result.outcome, 'delivered');
    assert.equal(writes, 1);
    assert.equal(schedules, 0, '已完成恢复后不得再安排 worker');
    assert.equal(isPetRecoveryPending(recoveryPath), false, '不得遗留无人清除的新恢复标记');
    assert.equal(fs.existsSync(stagingDir), false, '已完成恢复的并发事件不应再暂存');
  } finally {
    gate?.release();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('恢复 worker：独立重试启动、等待 daemon 完成重放，并发时仅一个 winner', async () => {
  const base = tempDir();
  const stagingDir = path.join(base, 'staging');
  const suppressionPath = getPetSuppressionPath(path.join(base, 'tmp'));
  const recoveryPath = getPetRecoveryPath(path.join(base, 'tmp'));
  const pipeName = uniquePipeName();
  let scheduled: { pipeName: string; recoveryPath: string; lockPath: string; suppressionPath: string } | null = null;
  let spawned = 0;
  let probeCalls = 0;
  try {
    assert.equal(setPetSuppressed(suppressionPath), true);
    const first = await relayHostEvent(
      '{"hook_event_name":"SessionStart","session_id":"s1","cwd":"D:\\\\ws"}',
      {
        pipeName,
        stagingDir,
        suppressionPath,
        recoveryPath,
        daemonLockPath: path.join(base, 'tmp', 'daemon.lock'),
        recoveryWaitMs: 1,
        probe: async () => true,
        write: async () => 'ok',
        scheduleRecovery: (opts) => {
          scheduled = {
            pipeName: opts.pipeName,
            recoveryPath: opts.recoveryPath,
            lockPath: opts.lockPath,
            suppressionPath: opts.suppressionPath,
          };
          return true;
        },
      },
    );
    assert.equal(first.outcome, 'staged');
    assert.ok(scheduled, '当前 SessionStart 应安排 detached worker');

    let spawnAttempts = 0;
    let daemonReady = false;
    const workerResult = await runDaemonRecoveryWorker(scheduled!, {
      probe: async () => {
        probeCalls++;
        return probeCalls === 1 || daemonReady; // 第一次旧管道仍在；恢复成功后新管道可用
      },
      delay: async () => {},
      spawnDaemon: () => {
        spawned++;
        spawnAttempts++;
        if (spawnAttempts === 1) return false;
        daemonReady = true;
        clearPetRecoveryPending(recoveryPath); // 模拟新 daemon 完成 staging 重放并发布 ready
        return true;
      },
      maxAttempts: 3,
    });
    assert.equal(workerResult, true);
    assert.equal(spawned, 2, '首次拉起失败后无需第二个宿主事件即可自动重试');
    assert.equal(isPetRecoveryPending(recoveryPath), false);
    assert.equal(fs.existsSync(suppressionPath), false, '旧管道释放后由 worker 消费抑制标记');
    assert.equal(fs.readdirSync(stagingDir).length, 1, '当前 SessionStart 保留给新 daemon 回收');

    // schedule 的 worker 锁保证只有一个 worker 进入完整恢复循环。
    assert.equal(setPetRecoveryPending(recoveryPath), true);
    spawned = 0;
    let newPipeReady = false;
    const workerDeps = {
      probe: async () => newPipeReady,
      delay: async () => {},
      spawnDaemon: () => {
        spawned++;
        clearPetRecoveryPending(recoveryPath);
        newPipeReady = true;
        return true;
      },
    };
    // 这里验证单 worker 完整路径；并发 schedule 的原子互斥由 daemon.test 覆盖。
    const worker = await runDaemonRecoveryWorker(scheduled!, workerDeps);
    assert.equal(worker, true);
    assert.equal(spawned, 1, '并发 worker 只允许 winner 拉起 daemon');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('恢复 worker：等待在途旧事件租约释放后才消费抑制并拉起 daemon', async () => {
  const base = tempDir();
  const suppressionPath = path.join(base, 'pet.disabled');
  const recoveryPath = path.join(base, 'pet.recovering');
  const lockPath = path.join(base, 'daemon.lock');
  const lease = acquireDeliveryLease(recoveryPath);
  assert.ok(lease);
  assert.equal(setPetSuppressed(suppressionPath), true);
  assert.equal(setPetRecoveryPending(recoveryPath), true);
  let delayCalls = 0;
  let suppressionCleared = false;
  let spawned = 0;
  let pipeReady = false;
  try {
    const result = await runDaemonRecoveryWorker(
      { pipeName: uniquePipeName(), recoveryPath, lockPath, suppressionPath },
      {
        probe: async () => pipeReady,
        clearSuppression: (markerPath) => {
          suppressionCleared = true;
          return clearPetSuppressed(markerPath);
        },
        delay: async () => {
          delayCalls++;
          assert.equal(suppressionCleared, false, '租约释放前不得消费 suppression');
          lease!.release();
        },
        spawnDaemon: () => {
          spawned++;
          clearPetRecoveryPending(recoveryPath);
          pipeReady = true;
          return true;
        },
        maxAttempts: 1,
      },
    );
    assert.equal(result, true);
    assert.equal(delayCalls, 1);
    assert.equal(suppressionCleared, true);
    assert.equal(spawned, 1);
  } finally {
    lease?.release();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
