/**
 * 守护进程拉起（§3.3：管道不存在时以分离方式拉起守护进程，不等待就绪）。
 *
 * 单 exe 合并（阶段五 P1）：kpetd（Windows 为 kpetd.exe）同时承载转发器与守护进程，按首参数分发
 * （src/launcher/main.ts）；拉起守护进程时以 --daemon 分发，恢复 worker 以 --kpet-recover 分发。
 *
 * 防并发风暴：多个转发器同时发现管道不存在时，用独占锁文件保证只拉一次。
 * 锁文件不主动删除，靠 mtime 超过 TTL 视为陈旧 —— 持有锁的转发器（或守护进程）崩溃后，
 * 下一个转发器可接管重拉；spawn 同步失败（可执行文件缺失）则立即释放锁允许重试。
 * 残留的陈旧锁最多让拉起延迟一个 TTL，可接受。
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 守护进程可执行文件名（单 exe 合并后仅用于开发模式兜底路径，见 resolveDaemonPath）。
 * win32 为 kpetd.exe，其余平台为 kpetd；platform 参数仅供测试注入，生产环境默认取 process.platform。
 */
export function getDaemonExeName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'kpetd.exe' : 'kpetd';
}

/** 锁文件 TTL（毫秒）：超过该时长视为陈旧锁，下一个转发器可接管。 */
export const DAEMON_LOCK_TTL_MS = 15_000;
/** 恢复交接锁只保护同步文件操作；短 TTL 让崩溃残留能在单次 5 秒 hook 内接管。 */
export const RECOVERY_GATE_LOCK_TTL_MS = 1_000;
/** 正常事件投递租约超时；超过宿主 hook 预算的残留进程可由恢复 worker 安全回收。 */
export const DELIVERY_LEASE_TTL_MS = 15_000;

/** 用户关闭后的持久抑制标记；存在即表示等待下一次 SessionStart 恢复。 */
export const PET_SUPPRESSION_FILE = 'pet.disabled';
/** 旧事件管道迟迟未释放时的恢复中标记，防止后续事件误写旧守护进程。 */
export const PET_RECOVERY_FILE = 'pet.recovering';
/** 恢复交接锁：串行化 Bridge 暂存、旧 daemon 退出和新 daemon 回放切换。 */
export const PET_RECOVERY_GATE_FILE = 'pet.recovering.gate';
/** 转发器 detached recovery worker 的命令行参数。 */
export const DAEMON_RECOVERY_ARG = '--kpet-recover';

/**
 * 解析守护进程可执行文件路径。
 *
 * 单 exe 合并后，守护进程与转发器同体：bun build --compile 产物下当前进程自身即守护进程，
 * 直接返回 argv[0]（跳过 bun/node 等开发运行时的宿主可执行文件）。
 * 开发模式（node/bun 直跑）保留原解析逻辑：
 * 1. 优先环境变量 KIMI_PLUGIN_ROOT/bin/ 下的守护进程产物（Windows 为 kpetd.exe，其余平台 kpetd；宿主注入，§3.1）；
 * 2. 缺省相对推导：转发器由宿主钩子拉起、工作目录即插件根目录（§3.1），故取 cwd()/bin/ 下的守护进程产物（同上按平台取文件名）。
 *
 * platform 参数仅供测试注入；生产环境默认取 process.platform。
 */
export function resolveDaemonPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const self = process.argv[0];
  if (self && isStandaloneExecutable(self, platform)) {
    return self;
  }
  const root = env.KIMI_PLUGIN_ROOT;
  if (root && root.length > 0) return path.join(root, 'bin', getDaemonExeName(platform));
  return path.join(process.cwd(), 'bin', getDaemonExeName(platform));
}

/**
 * 判断 argv[0] 是否指向单 exe 合并产物自身（而非 bun/node 开发宿主）。
 * win32：以 .exe 结尾且 basename 不是 bun.exe/node.exe；
 * 其余平台：basename 不是 bun/node（开发宿主即 bun 或 node，可带 .exe 后缀一并排除）。
 *
 * platform 参数仅供测试注入；生产环境默认取 process.platform。
 */
export function isStandaloneExecutable(
  self: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const base = path.basename(self);
  if (platform === 'win32') {
    return /\.exe$/i.test(base) && !/^(?:bun|node)\.exe$/i.test(base);
  }
  return !/^(?:bun|node)(?:\.exe)?$/i.test(base);
}

/** 锁文件路径：系统临时目录/kpet/daemon.lock（Windows 为 %TEMP%/kpet/daemon.lock；独立于事件暂存目录，避免被暂存回收误删）。 */
export function getDaemonLockPath(tmpDir: string = os.tmpdir()): string {
  return path.join(tmpDir, 'kpet', 'daemon.lock');
}

/** 用户关闭标记路径，与拉起锁同目录，避免与事件暂存混用。 */
export function getPetSuppressionPath(tmpDir: string = os.tmpdir()): string {
  return path.join(tmpDir, 'kpet', PET_SUPPRESSION_FILE);
}

/** 恢复中标记路径；由下一次有效 SessionStart 建立，直到新 daemon 完成有序回放。 */
export function getPetRecoveryPath(tmpDir: string = os.tmpdir()): string {
  return path.join(tmpDir, 'kpet', PET_RECOVERY_FILE);
}

/** 恢复交接锁路径；与恢复标记同目录，便于跨转发器和 worker 协调。 */
export function getPetRecoveryGatePath(recoveryPath: string = getPetRecoveryPath()): string {
  return recoveryPath === getPetRecoveryPath()
    ? path.join(path.dirname(recoveryPath), PET_RECOVERY_GATE_FILE)
    : `${recoveryPath}.gate`;
}

/** 恢复交接前的在途正常事件目录；worker 会等目录中的有效租约全部释放。 */
export function getDeliveryLeaseDir(recoveryPath: string = getPetRecoveryPath()): string {
  return `${recoveryPath}.deliveries`;
}

export interface DeliveryLease {
  path: string;
  release: () => void;
}

/**
 * 登记一条在途正常投递。调用方在恢复 gate 内创建、在管道操作结束后释放；
 * 这样恢复 worker 不会在旧事件仍可能写管道时提前消费 suppression 并启动新 daemon。
 */
export function acquireDeliveryLease(recoveryPath: string = getPetRecoveryPath()): DeliveryLease | null {
  const dir = getDeliveryLeaseDir(recoveryPath);
  const leasePath = path.join(dir, `${process.pid}-${randomLockOwner()}.lease`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(leasePath, 'wx');
    fs.closeSync(fd);
    return {
      path: leasePath,
      release: () => {
        try {
          fs.rmSync(leasePath, { force: true });
        } catch {
          // worker 会按 TTL 回收崩溃残留。
        }
      },
    };
  } catch {
    return null;
  }
}

/** 检查并清理已超过 TTL 的在途投递租约。读取失败时保守视为仍有在途事件。 */
export function hasActiveDeliveryLeases(
  recoveryPath: string = getPetRecoveryPath(),
  staleAfterMs: number = DELIVERY_LEASE_TTL_MS,
): boolean {
  const dir = getDeliveryLeaseDir(recoveryPath);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  let active = false;
  for (const file of files) {
    if (!file.endsWith('.lease')) continue;
    const leasePath = path.join(dir, file);
    try {
      const stat = fs.statSync(leasePath);
      if (Date.now() - stat.mtimeMs <= staleAfterMs) {
        active = true;
        continue;
      }
      try {
        fs.rmSync(leasePath, { force: true });
      } catch {
        active = true;
      }
    } catch {
      // 并发释放后文件消失，视为已完成。
    }
  }
  return active;
}

/** 刷新长时持有锁的 mtime；给定 owner 时只允许当前持有者续租。 */
export function refreshDaemonLock(lockPath: string, owner?: string): boolean {
  try {
    if (owner !== undefined && fs.readFileSync(lockPath, 'utf8') !== owner) return false;
    const now = new Date();
    fs.utimesSync(lockPath, now, now);
    return true;
  } catch {
    return false;
  }
}

/** 判断宠物是否处于用户关闭抑制期；只看标记存在性，内容损坏也必须保持抑制。 */
export function isPetSuppressed(markerPath: string = getPetSuppressionPath()): boolean {
  try {
    return fs.statSync(markerPath).isFile();
  } catch {
    return false;
  }
}

/** 返回抑制标记的修改时间，用于恢复时区分关闭前旧暂存与恢复期新暂存。 */
export function getPetSuppressedAt(markerPath: string = getPetSuppressionPath()): number | null {
  try {
    const stat = fs.statSync(markerPath);
    return stat.isFile() ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

/** 写入用户关闭标记。标记是故意持久的，直到下一次 SessionStart 被转发器消费。 */
export function setPetSuppressed(markerPath: string = getPetSuppressionPath()): boolean {
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    // 先创建文件再写入，任何时刻读到文件都代表抑制；崩溃留下空文件也安全。
    const fd = fs.openSync(markerPath, 'w');
    try {
      fs.writeSync(fd, `${new Date().toISOString()}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/** 消费用户关闭标记；下一次 SessionStart 才允许恢复。 */
export function clearPetSuppressed(markerPath: string = getPetSuppressionPath()): boolean {
  try {
    fs.rmSync(markerPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 写入恢复中标记；恢复期间事件只暂存，不投递给仍可能存活的旧守护进程。 */
export function setPetRecoveryPending(markerPath: string = getPetRecoveryPath()): boolean {
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 清除恢复中标记。 */
export function clearPetRecoveryPending(markerPath: string = getPetRecoveryPath()): boolean {
  try {
    fs.rmSync(markerPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 判断是否处于旧事件管道释放后的恢复中阶段。 */
export function isPetRecoveryPending(markerPath: string = getPetRecoveryPath()): boolean {
  try {
    return fs.statSync(markerPath).isFile();
  } catch {
    return false;
  }
}

export interface ScheduleDaemonRecoveryOptions {
  /** 事件管道名。 */
  pipeName: string;
  /** 恢复中标记路径。 */
  recoveryPath: string;
  /** 拉起锁路径。 */
  lockPath: string;
  /** 用户关闭抑制标记路径；worker 在旧管道释放后才消费。 */
  suppressionPath: string;
  /** 可选守护进程路径；缺省由 worker 按当前环境解析。 */
  daemonPath?: string;
  /** worker 独占锁路径；缺省为 recoveryPath 加后缀。 */
  workerLockPath?: string;
  /** 测试注入的子进程拉起函数；生产环境使用 node:child_process.spawn。 */
  spawnFn?: typeof spawn;
}

/**
 * 安排 detached recovery worker。
 *
 * 转发器本身会在当前 hook 结束时退出，因此恢复等待不能依赖当前进程的定时器。
 * worker 复用同一个 kpetd 产物（Windows 为 kpetd.exe）的 --kpet-recover 隐藏命令行入口（launcher 分发），
 * 独立等待事件管道释放。
 */
export async function scheduleDaemonRecovery(opts: ScheduleDaemonRecoveryOptions): Promise<boolean> {
  const workerLockPath = opts.workerLockPath ?? `${opts.recoveryPath}.worker.lock`;
  const launcher = resolveBridgeLauncher();
  const spawnWorker = opts.spawnFn ?? spawn;
  for (let attempt = 0; attempt < 3; attempt++) {
    const workerLock = acquireOwnedDaemonLock(workerLockPath);
    // 已有持锁 worker 时，恢复任务已经被可靠接管，不需要重复拉起。
    if (!workerLock) return true;
    const args = [
      ...launcher.args,
      DAEMON_RECOVERY_ARG,
      opts.pipeName,
      opts.recoveryPath,
      opts.lockPath,
      opts.suppressionPath,
      opts.daemonPath ?? resolveDaemonPath(),
      workerLockPath,
      workerLock.owner,
    ];
    const started = await new Promise<boolean>((resolve) => {
      let settled = false;
      try {
        const child = spawnWorker(launcher.command, args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        const onError = (): void => {
          if (settled) return;
          settled = true;
          workerLock.release();
          child.unref();
          resolve(false);
        };
        child.once('error', onError);
        child.once('spawn', () => {
          if (settled) return;
          settled = true;
          child.removeListener('error', onError);
          child.unref();
          resolve(true);
        });
      } catch {
        workerLock.release();
        resolve(false);
      }
    });
    if (started) return true;
    if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** Node 开发运行时需要把入口脚本作为参数；bun build --compile 后直接执行当前可执行文件。 */
function resolveBridgeLauncher(): { command: string; args: string[] } {
  const entry = process.argv[1];
  if (entry && /\.(?:mjs|cjs|js|ts)$/i.test(entry)) {
    return { command: process.execPath, args: [entry] };
  }
  // bun build --compile 通常把自身可执行文件放在 argv[0]；优先复用当前编译产物，
  // 避免把恢复参数误传给全局 bun/node 宿主。
  const self = process.argv[0];
  if (self && isStandaloneExecutable(self)) {
    return { command: self, args: [] };
  }
  return { command: process.execPath, args: [] };
}

/** 清理用户关闭后遗留的拉起锁，避免 15 秒 TTL 阻塞下一次 SessionStart。 */
export function clearDaemonLock(lockPath: string = getDaemonLockPath()): boolean {
  try {
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 尝试独占获取「拉起守护进程」的锁（fs.openSync 'wx' 排他创建，原子）。
 * 锁已存在且未陈旧 → 返回 null（不拉起）；陈旧 → 原子改名隔离后重试一次。
 * 返回释放函数；调用方在 spawn 失败时调用，spawn 成功后让锁自然 TTL 过期。
 *
 * 陈旧锁不直接删除：多个进程同时接管时，只有一个能把原路径原子改名；其余进程
 * 回到排他创建竞争，仍只会产生一个新持有者。
 */
export interface OwnedDaemonLock {
  owner: string;
  release: () => void;
}

/** 获取带所有者令牌的锁，用于需要把锁所有权交给子进程的恢复 worker。 */
export function acquireOwnedDaemonLock(
  lockPath: string = getDaemonLockPath(),
  staleAfterMs: number = DAEMON_LOCK_TTL_MS,
): OwnedDaemonLock | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true }); // 锁文件父目录可能不存在
      const fd = fs.openSync(lockPath, 'wx');
      const owner = `${process.pid}:${randomLockOwner()}`;
      try {
        fs.writeFileSync(fd, owner, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return {
        owner,
        release: () => {
        try {
          // 陈旧锁可能已被别的进程接管；旧持有者只能删除自己创建的锁。
          if (fs.readFileSync(lockPath, 'utf8') === owner) fs.rmSync(lockPath, { force: true });
        } catch {
          // 删除失败无妨，TTL 会兜底
        }
        },
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') return null; // 权限等其他错误：不拉起
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleAfterMs) {
          const quarantined = `${lockPath}.stale-${process.pid}-${randomLockOwner()}`;
          try {
            // 同目录 rename 在当前平台文件系统上是原子的；若另一进程已接管，rename 会失败，
            // 下一轮排他创建或新锁 mtime 检查会选出唯一 winner。
            fs.renameSync(lockPath, quarantined);
            try {
              fs.rmSync(quarantined, { force: true });
            } catch {
              // 隔离文件不再参与锁竞争，清理失败不影响正确性。
            }
          } catch {
            // 锁在 stat 后发生变化；回到排他创建重新竞争。
          }
          continue;
        }
      } catch {
        continue; // stat 失败（锁恰好被并发删除）：重试一次
      }
      return null; // 锁仍有效：别的转发器正在拉起，本转发器不拉起
    }
  }
  return null;
}

export function acquireDaemonLock(lockPath: string = getDaemonLockPath()): (() => void) | null {
  return acquireOwnedDaemonLock(lockPath)?.release ?? null;
}

/** 仅当锁仍属于指定持有者时删除，防止被 TTL 接管的旧 worker 误清新锁。 */
export function clearDaemonLockIfOwner(lockPath: string, owner: string): boolean {
  try {
    if (fs.readFileSync(lockPath, 'utf8') !== owner) return false;
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function randomLockOwner(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 伪代码 §3.3 的 spawn_detached：管道不存在时分离拉起守护进程，立即返回。
 * - detached + stdio ignore + unref：守护进程不随转发器退出，无控制台窗口（§3.1 闪窗规避）
 * - 带独占锁，防并发风暴；spawn 失败（可执行文件缺失）释放锁允许下个转发器重试
 * - 不等待守护进程就绪（启动期间的事件走暂存兜底，§3.4）
 */
export interface SpawnDaemonOptions {
  /** 测试或多实例场景注入锁路径；生产环境使用默认路径。 */
  lockPath?: string;
  /** 测试或多实例场景注入守护进程路径；生产环境使用默认路径。 */
  daemonPath?: string;
  /** 正常转发路径传入用户关闭标记，避免入口检查后才发生关闭时继续拉起 daemon。 */
  suppressionPath?: string;
  /** 测试注入的子进程拉起函数；生产环境使用 node:child_process.spawn。 */
  spawnFn?: typeof spawn;
}

export function spawnDaemonIfNeeded(opts: SpawnDaemonOptions = {}): boolean {
  const daemonPath = opts.daemonPath ?? resolveDaemonPath();
  const lockPath = opts.lockPath ?? getDaemonLockPath();
  const spawnDaemon = opts.spawnFn ?? spawn;
  if (opts.suppressionPath && isPetSuppressed(opts.suppressionPath)) return false;
  const release = acquireDaemonLock(lockPath);
  if (!release) return false;

  try {
    if (opts.suppressionPath && isPetSuppressed(opts.suppressionPath)) {
      release();
      return false;
    }
    // 单 exe 合并后，守护进程即当前可执行文件自身，以 --daemon 参数分发（见 src/launcher/main.ts）。
    const child = spawnDaemon(daemonPath, ['--daemon'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // 必须先监听异步启动错误，再检查 spawn 调用期间是否出现抑制标记；否则 kill 后
    // 仍可能收到无人处理的 error 事件并让短生命周期 Bridge 异常退出。
    child.once('error', () => {
      release();
    });
    child.unref();
    if (opts.suppressionPath && isPetSuppressed(opts.suppressionPath)) {
      child.kill();
      release();
      return false;
    }
    return true;
  } catch {
    release();
    return false;
  }
}
