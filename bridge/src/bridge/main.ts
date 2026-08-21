/**
 * 转发器主程序（§3.3 伪代码），单 exe 分发后由 src/launcher/main.ts 按 --relay 调用。
 *
 * 宿主每发生一个事件拉起本进程一次，流程：
 *   read_all(stdin) → 非法 JSON 直接放行 → 包装 host_event 信封
 *   → 管道不存在则分离拉起守护进程（防并发风暴）
 *   → 连接 + 写入（200ms 超时）→ 失败写本地暂存
 *   → 任何情况 exit(0)（失败放行，§2.2 D4 / §3.1 宿主约定）
 *
 * 消息按 §4.2 为单个 JSON 对象；node:net 的命名管道是字节流模式而非消息模式，
 * 为让守护进程端可靠分帧，每条消息追加一个换行（JSON 文本流惯例，不影响消息模式收端）。
 */
import * as fs from 'node:fs';
import { createHostEventEnvelope, type MessageEnvelope } from '../protocol/index.js';
import { getEventPipeName } from './user.js';
import { probePipe, writeToPipe, type PipeWriteResult } from './pipe.js';
import {
  acquireDeliveryLease,
  acquireOwnedDaemonLock,
  clearDaemonLock,
  clearDaemonLockIfOwner,
  clearPetSuppressed,
  getDaemonLockPath,
  getPetRecoveryPath,
  getPetRecoveryGatePath,
  getPetSuppressionPath,
  getPetSuppressedAt,
  hasActiveDeliveryLeases,
  isPetRecoveryPending,
  refreshDaemonLock,
  RECOVERY_GATE_LOCK_TTL_MS,
  DAEMON_RECOVERY_ARG,
  resolveDaemonPath,
  scheduleDaemonRecovery,
  type ScheduleDaemonRecoveryOptions,
  type OwnedDaemonLock,
  setPetRecoveryPending,
  spawnDaemonIfNeeded,
} from './daemon.js';
import { clearStagingBeforeTimestamp, getStagingDir, writeStaging } from './staging.js';

/** 事件管道连接 + 写入总超时（毫秒），§3.3：200ms。 */
export const PIPE_TIMEOUT_MS = 200;

/** 探测管道存在性的超时（毫秒），不消耗主预算。 */
const PIPE_PROBE_TIMEOUT_MS = 100;

/** 关闭后 SessionStart 恢复时等待旧守护进程释放事件管道的最长时间。 */
export const RECOVERY_PIPE_WAIT_MS = 3000;

/** 交接锁正常只持有数毫秒；上限留给回放较多暂存文件的情况。 */
const RECOVERY_GATE_WAIT_MS = 1_200;

/** 帧分隔符：见文件头注释。 */
export const FRAME_DELIMITER = '\n';

export type RelayOutcome = 'invalid_json' | 'suppressed' | 'delivered' | 'staged';

export interface RelayResult {
  outcome: RelayOutcome;
}

/** 转发器核心逻辑的可注入依赖（测试用；生产环境全部缺省）。 */
export interface RelayOptions {
  /** 事件管道全名，缺省按当前用户名推导（§4.1）。 */
  pipeName?: string;
  /** 连接 + 写入总超时（毫秒），缺省 200ms（§3.3）。 */
  timeoutMs?: number;
  /** 暂存目录，缺省系统临时目录下的 kpet-events/（§3.3）。 */
  stagingDir?: string;
  /** 用户关闭抑制标记路径，缺省系统临时目录下的 kpet/pet.disabled。 */
  suppressionPath?: string;
  /** 拉起锁路径，缺省系统临时目录下的 kpet/daemon.lock。 */
  daemonLockPath?: string;
  /** 恢复中标记路径，缺省系统临时目录下的 kpet/pet.recovering。 */
  recoveryPath?: string;
  /** 恢复时等待旧事件管道释放的时长，测试可注入 0；默认 3 秒。 */
  recoveryWaitMs?: number;
  /** 安排 detached 恢复 worker；测试可注入并断言安排成功。 */
  scheduleRecovery?: (opts: ScheduleDaemonRecoveryOptions) => boolean | Promise<boolean>;
  /** 是否允许拉起守护进程，缺省 true（测试置 false）。 */
  spawnDaemon?: boolean;
  probe?: (pipe: string) => Promise<boolean>;
  write?: (pipe: string, data: string, timeoutMs: number) => Promise<PipeWriteResult>;
  staging?: (envelope: MessageEnvelope) => string | null;
}

/**
 * 转发器核心流程（§3.3）：
 * 非法 JSON → 直接放行（返回 'invalid_json'，调用方以 0 退出），永不阻塞宿主（§2.2 D4）。
 */
export async function relayHostEvent(raw: string, opts: RelayOptions = {}): Promise<RelayResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { outcome: 'invalid_json' };
  }
  const envelope = createHostEventEnvelope(raw, parsed);
  return relayEnvelope(envelope, opts);
}

/** 信封 → 管道（含守护进程拉起与暂存兜底）。测试可直接注入信封与依赖。 */
export async function relayEnvelope(envelope: MessageEnvelope, opts: RelayOptions = {}): Promise<RelayResult> {
  const pipeName = opts.pipeName ?? getEventPipeName();
  const timeoutMs = opts.timeoutMs ?? PIPE_TIMEOUT_MS;
  const probe = opts.probe ?? probePipe;
  const write = opts.write ?? writeToPipe;
  const staging = opts.staging ?? ((env) => writeStaging(env, opts.stagingDir));
  const suppressionPath = opts.suppressionPath ?? getPetSuppressionPath();
  const stagingDir = opts.stagingDir ?? getStagingDir();
  const daemonLockPath = opts.daemonLockPath ?? getDaemonLockPath();
  const recoveryPath = opts.recoveryPath ?? getPetRecoveryPath();
  const scheduleRecovery = opts.scheduleRecovery ?? scheduleDaemonRecovery;

  const recoveryGatePath = getPetRecoveryGatePath(recoveryPath);

  // 用户关闭后，当前会话的后续事件必须直接丢弃，不能写暂存、不能拉起守护进程。
  // 只有下一次 SessionStart 消费标记并恢复；恢复前清理旧暂存，避免关闭前事件重放。
  const hook = extractHostHook(envelope);
  const suppressedAt = getPetSuppressedAt(suppressionPath);
  const recoveryPendingAtEntry = isPetRecoveryPending(recoveryPath);
  if (suppressedAt !== null && !recoveryPendingAtEntry) {
    if (hook !== 'SessionStart' || typeof envelope.session_id !== 'string' || envelope.session_id.length === 0) {
      return { outcome: 'suppressed' };
    }
    const gate = await acquireRecoveryGate(recoveryGatePath);
    if (!gate) return { outcome: 'suppressed' };
    let joinedActiveRecovery = false;
    let recoveryAlreadyCompleted = false;
    try {
      // 锁内重查：另一个并发 SessionStart 可能已建立甚至已完成整个恢复批次。
      const recoveryPendingNow = isPetRecoveryPending(recoveryPath);
      const suppressedNow = getPetSuppressedAt(suppressionPath);
      if (!recoveryPendingNow && suppressedNow === null) {
        recoveryAlreadyCompleted = true;
      } else if (!recoveryPendingNow) {
        // 先发布恢复标记，再清旧文件、暂存首个 SessionStart。
        // 旧 daemon 的退出清理使用同一把锁，不会与这三步交叉。
        if (!setPetRecoveryPending(recoveryPath)) return { outcome: 'suppressed' };
        clearStagingBeforeTimestamp(stagingDir, suppressedNow ?? suppressedAt, () => assertGateOwnership(recoveryGatePath, gate));
      }
      if (!recoveryAlreadyCompleted) {
        assertGateOwnership(recoveryGatePath, gate);
        if (staging(envelope) === null) return { outcome: 'suppressed' };
        assertGateOwnership(recoveryGatePath, gate);
        joinedActiveRecovery = true;
      }
    } catch {
      return { outcome: 'suppressed' };
    } finally {
      gate.release();
    }
    if (joinedActiveRecovery) {
      // UE 可能先写标记后才送达 close_pet；必须确认旧事件管道已释放，避免把恢复事件写给
      // 正在退出的旧守护进程。若旧管道迟迟不释放，当前 SessionStart 仍立即完成恢复：先
      // 暂存事件，再由 worker 等待管道释放、消费关闭标记并拉起新守护进程。
      const pipeReleased = await waitForPipeUnavailable(
        probe,
        pipeName,
        opts.recoveryWaitMs ?? RECOVERY_PIPE_WAIT_MS,
      );
      if (!pipeReleased) {
        if (opts.spawnDaemon !== false) {
          await scheduleRecovery({ pipeName, recoveryPath, lockPath: daemonLockPath, suppressionPath });
        }
        return { outcome: 'staged' };
      }
      if (opts.spawnDaemon !== false) {
        await scheduleRecovery({ pipeName, recoveryPath, lockPath: daemonLockPath, suppressionPath });
      }
      return { outcome: 'staged' };
    }
    // 首个并发 SessionStart 已完成恢复；本事件继续走正常投递，不能重开一个
    // 没有 worker 接管的恢复批次。
  }

  // 正常投递只在 gate 内登记租约，网络操作在锁外并发执行。恢复 worker 会等待所有租约
  // 释放后才消费 suppression，既避免旧事件命中新 daemon，也不串行化并发宿主事件。
  const registrationGate = await acquireRecoveryGate(recoveryGatePath);
  if (!registrationGate) return { outcome: 'suppressed' };
  let scheduleAfterUnlock = false;
  let deliveryLease: ReturnType<typeof acquireDeliveryLease> = null;
  let registeredOutcome: RelayResult = { outcome: 'suppressed' };
  try {
    if (isPetRecoveryPending(recoveryPath)) {
      assertGateOwnership(recoveryGatePath, registrationGate);
      if (staging(envelope) !== null) {
        assertGateOwnership(recoveryGatePath, registrationGate);
        registeredOutcome = { outcome: 'staged' };
        scheduleAfterUnlock = true;
      }
    } else if (getPetSuppressedAt(suppressionPath) === null) {
      deliveryLease = acquireDeliveryLease(recoveryPath);
      if (deliveryLease) assertGateOwnership(recoveryGatePath, registrationGate);
    }
  } catch {
    registeredOutcome = { outcome: 'suppressed' };
  } finally {
    registrationGate.release();
  }
  if (scheduleAfterUnlock && opts.spawnDaemon !== false) {
    await scheduleRecovery({ pipeName, recoveryPath, lockPath: daemonLockPath, suppressionPath });
  }
  if (!deliveryLease) return registeredOutcome;

  try {
    const exists = await probe(pipeName, PIPE_PROBE_TIMEOUT_MS);
    // UE 独立写 suppression；SessionStart 也可能已在登记后建立 recovery。两者任一出现，
    // 本事件都属于旧批次，应直接丢弃并释放租约。
    if (getPetSuppressedAt(suppressionPath) !== null || isPetRecoveryPending(recoveryPath)) {
      return { outcome: 'suppressed' };
    }
    if (!exists && opts.spawnDaemon !== false) {
      spawnDaemonIfNeeded({ lockPath: daemonLockPath, suppressionPath }); // 分离拉起，不等待就绪；守护进程启动期间的事件走暂存兜底（§3.4）
    }

    const result = await write(pipeName, JSON.stringify(envelope) + FRAME_DELIMITER, timeoutMs);
    if (result === 'ok') {
      return getPetSuppressedAt(suppressionPath) !== null || isPetRecoveryPending(recoveryPath)
        ? { outcome: 'suppressed' }
        : { outcome: 'delivered' };
    }

    // 写失败后的暂存决策重新进入 gate，避免与 SessionStart 的清旧/建恢复批次交叉。
    const stagingGate = await acquireRecoveryGate(recoveryGatePath);
    if (!stagingGate) return { outcome: 'suppressed' };
    try {
      if (getPetSuppressedAt(suppressionPath) !== null || isPetRecoveryPending(recoveryPath)) {
        return { outcome: 'suppressed' };
      }
      const stagedPath = staging(envelope);
      if (stagedPath === null) return { outcome: 'staged' };
      assertGateOwnership(recoveryGatePath, stagingGate);
      // suppression 不受 gate 约束；若它与写文件交叉，只撤销本次旧事件。
      if (getPetSuppressedAt(suppressionPath) !== null) {
        try {
          fs.rmSync(stagedPath, { force: true });
        } catch {
          // 下一次 SessionStart 会按标记时间戳再次清理。
        }
        return { outcome: 'suppressed' };
      }
      return { outcome: 'staged' };
    } catch {
      return { outcome: 'suppressed' };
    } finally {
      stagingGate.release();
    }
  } finally {
    deliveryLease.release();
  }
}

/** 等待并取得恢复交接锁。获锁失败时不越过恢复协议直写管道。 */
async function acquireRecoveryGate(lockPath: string): Promise<OwnedDaemonLock | null> {
  const deadline = Date.now() + RECOVERY_GATE_WAIT_MS;
  while (true) {
    const gate = acquireOwnedDaemonLock(lockPath, RECOVERY_GATE_LOCK_TTL_MS);
    if (gate) return gate;
    if (Date.now() >= deadline) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function assertGateOwnership(lockPath: string, gate: OwnedDaemonLock): void {
  if (!refreshDaemonLock(lockPath, gate.owner)) throw new Error('恢复交接锁所有权已丢失');
}

/** 在恢复竞态窗口内等待旧事件管道消失。 */
async function waitForPipeUnavailable(
  probe: (pipe: string, timeoutMs: number) => Promise<boolean>,
  pipeName: string,
  waitMs: number,
): Promise<boolean> {
  if (waitMs <= 0) return true;
  const deadline = Date.now() + waitMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    if (!(await probe(pipeName, Math.min(PIPE_PROBE_TIMEOUT_MS, remaining)))) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, remaining))));
  }
}

/** 从 host_event 信封中提取 hook_event_name；缺失时按非 SessionStart 处理。 */
function extractHostHook(envelope: MessageEnvelope): string | null {
  const raw = envelope.type === 'host_event' ? (envelope.payload as { _raw?: unknown })._raw : undefined;
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const hook = (parsed as Record<string, unknown>).hook_event_name;
    return typeof hook === 'string' ? hook : null;
  } catch {
    return null;
  }
}

/** 读取 stdin 全部内容（宿主事件 JSON，§3.1）。 */
export function readAllStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      data += chunk;
    });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

export interface DaemonRecoveryWorkerOptions {
  pipeName: string;
  recoveryPath: string;
  lockPath: string;
  suppressionPath: string;
  daemonPath?: string;
  workerLockPath?: string;
  workerLockOwner?: string;
}

export interface DaemonRecoveryWorkerDeps {
  probe?: (pipe: string, timeoutMs: number) => Promise<boolean>;
  clearLock?: (path: string) => boolean;
  clearWorkerLock?: (path: string) => boolean;
  clearSuppression?: (path: string) => boolean;
  spawnDaemon?: (opts: { lockPath: string; daemonPath?: string }) => boolean;
  delay?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

/**
 * detached recovery worker：持续等待旧事件管道释放，随后独占地重试拉起 daemon。
 * 该函数不读取 stdin，因此不会占用当前 SessionStart hook 的超时预算。
 */
export async function runDaemonRecoveryWorker(
  opts: DaemonRecoveryWorkerOptions,
  deps: DaemonRecoveryWorkerDeps = {},
): Promise<boolean> {
  const probe = deps.probe ?? probePipe;
  const clearLock = deps.clearLock ?? clearDaemonLock;
  const clearWorkerLock = deps.clearWorkerLock ?? ((path: string) => (
    opts.workerLockOwner ? clearDaemonLockIfOwner(path, opts.workerLockOwner) : clearDaemonLock(path)
  ));
  const clearSuppression = deps.clearSuppression ?? clearPetSuppressed;
  const spawnDaemon = deps.spawnDaemon ?? ((spawnOpts) => spawnDaemonIfNeeded(spawnOpts));
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // 生产环境持续接管恢复，直到成功或恢复标记被其他进程完成；这样即使后续没有
  // 第二个宿主事件，临时的 daemon 启动失败也不会让宠物永久停在恢复中。
  // 测试可注入有限次数，保持失败用例可终止。
  const maxAttempts = deps.maxAttempts ?? Number.POSITIVE_INFINITY;
  let finished = false;
  const finish = (result: boolean): boolean => {
    if (finished) return result;
    finished = true;
    if (opts.workerLockPath) clearWorkerLock(opts.workerLockPath);
    return result;
  };
  const refreshWorkerLock = (): boolean => {
    if (!opts.workerLockPath) return true;
    return refreshDaemonLock(opts.workerLockPath, opts.workerLockOwner);
  };

  // 从 schedule 交接来的 worker 必须仍持有同一枚令牌；旧 worker 恢复运行时若锁已
  // 被 TTL 接管，必须立即退出，不得再清锁或拉起 daemon。
  if (!refreshWorkerLock()) return false;

  while (isPetRecoveryPending(opts.recoveryPath)
    && ((await probe(opts.pipeName, PIPE_PROBE_TIMEOUT_MS)) || hasActiveDeliveryLeases(opts.recoveryPath))) {
    if (!refreshWorkerLock()) return finish(false);
    await delay(50);
  }
  if (!isPetRecoveryPending(opts.recoveryPath)) return finish(false);

  // schedule 时已通过 workerLockPath 原子选出唯一 worker。等待可能超过锁 TTL，
  // 因此每轮刷新 mtime，防止后续事件误启动第二个 worker。
  if (!clearSuppression(opts.suppressionPath)) return finish(false);
  for (let attempt = 0; attempt < maxAttempts && isPetRecoveryPending(opts.recoveryPath); attempt++) {
    if (!refreshWorkerLock()) return finish(false);
    if (await probe(opts.pipeName, PIPE_PROBE_TIMEOUT_MS)) {
      await delay(50);
      attempt--;
      continue;
    }
    clearLock(opts.lockPath);
    if (!spawnDaemon({ lockPath: opts.lockPath, daemonPath: opts.daemonPath })) {
      await delay(1000);
      continue;
    }

    // daemon 只有在交接锁内完成 staging 重放后才清除 recovery；因此这里
    // 必须同时等到 recovery 消失和事件管道可用，才算真正恢复成功。
    for (let readyPoll = 0; readyPoll < 100; readyPoll++) {
      if (!refreshWorkerLock()) return finish(false);
      if (!isPetRecoveryPending(opts.recoveryPath) && (await probe(opts.pipeName, PIPE_PROBE_TIMEOUT_MS))) {
        return finish(true);
      }
      await delay(50);
    }
    clearLock(opts.lockPath);
  }
  const recovered = !isPetRecoveryPending(opts.recoveryPath)
    && (await probe(opts.pipeName, PIPE_PROBE_TIMEOUT_MS));
  return finish(recovered);
}

/** 解析 --kpet-recover 的 7 个位置参数并运行 detached 恢复 worker（由 launcher 分发调用）。 */
export async function runRecoveryFromArgv(): Promise<void> {
  const index = process.argv.indexOf(DAEMON_RECOVERY_ARG);
  const pipeName = process.argv[index + 1];
  const recoveryPath = process.argv[index + 2];
  const lockPath = process.argv[index + 3];
  const suppressionPath = process.argv[index + 4];
  const daemonPath = process.argv[index + 5] ?? resolveDaemonPath();
  const workerLockPath = process.argv[index + 6];
  const workerLockOwner = process.argv[index + 7];
  if (!pipeName || !recoveryPath || !lockPath || !suppressionPath) return;
  await runDaemonRecoveryWorker({
    pipeName,
    recoveryPath,
    lockPath,
    suppressionPath,
    daemonPath,
    workerLockPath,
    workerLockOwner,
  });
}

/** 入口：任何情况都以 0 退出（失败放行，§2.2 D4 / §3.3）。 */
export async function main(): Promise<void> {
  try {
    const raw = await readAllStdin();
    await relayHostEvent(raw);
  } catch {
    // 极端异常也放行
  }
  process.exit(0);
}
