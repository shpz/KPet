/**
 * 守护进程拉起（§3.3：管道不存在时以分离方式拉起守护进程，不等待就绪）。
 *
 * 防并发风暴：多个转发器同时发现管道不存在时，用独占锁文件保证只拉一次。
 * 锁文件不主动删除，靠 mtime 超过 TTL 视为陈旧 —— 持有锁的转发器（或守护进程）崩溃后，
 * 下一个转发器可接管重拉；spawn 同步失败（exe 缺失）则立即释放锁允许重试。
 * 残留的陈旧锁最多让拉起延迟一个 TTL，可接受。
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 守护进程可执行文件名（随插件分发，见 packaging/kimi-pet/）。 */
export const DAEMON_EXE = 'kimi-petd.exe';

/** 锁文件 TTL（毫秒）：超过该时长视为陈旧锁，下一个转发器可接管。 */
export const DAEMON_LOCK_TTL_MS = 15_000;

/**
 * 解析守护进程可执行文件路径：
 * 1. 优先环境变量 KIMI_PLUGIN_ROOT/bin/kimi-petd.exe（宿主注入，§3.1）；
 * 2. 缺省相对推导：转发器由宿主钩子拉起、工作目录即插件根目录（§3.1），故取 cwd()/bin/kimi-petd.exe。
 */
export function resolveDaemonPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.KIMI_PLUGIN_ROOT;
  if (root && root.length > 0) return path.join(root, 'bin', DAEMON_EXE);
  return path.join(process.cwd(), 'bin', DAEMON_EXE);
}

/** 锁文件路径：%TEMP%/kimi-pet/daemon.lock（独立于事件暂存目录 %TEMP%/kimi-pet-events/，避免被暂存回收误删）。 */
export function getDaemonLockPath(tmpDir: string = os.tmpdir()): string {
  return path.join(tmpDir, 'kimi-pet', 'daemon.lock');
}

/**
 * 尝试独占获取「拉起守护进程」的锁（fs.openSync 'wx' 排他创建，原子）。
 * 锁已存在且未陈旧 → 返回 null（不拉起）；陈旧 → 删除重试一次。
 * 返回释放函数；调用方在 spawn 失败时调用，spawn 成功后让锁自然 TTL 过期。
 *
 * 注：删除陈旧锁与并发重抢存在极小竞态窗口（可能双拉），
 * 守护进程侧有系统级互斥体兜底（§4.1 单实例），重复实例启动即退出，风险可接受。
 */
export function acquireDaemonLock(lockPath: string = getDaemonLockPath()): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true }); // 锁文件父目录可能不存在
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd);
      return () => {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // 删除失败无妨，TTL 会兜底
        }
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') return null; // 权限等其他错误：不拉起
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > DAEMON_LOCK_TTL_MS) {
          fs.rmSync(lockPath, { force: true });
          continue; // 陈旧锁已删除，重试
        }
      } catch {
        continue; // stat 失败（锁恰好被并发删除）：重试一次
      }
      return null; // 锁仍有效：别的转发器正在拉起，本转发器不拉起
    }
  }
  return null;
}

/**
 * 伪代码 §3.3 的 spawn_detached：管道不存在时分离拉起守护进程，立即返回。
 * - detached + stdio ignore + unref：守护进程不随转发器退出，无控制台窗口（§3.1 闪窗规避）
 * - 带独占锁，防并发风暴；spawn 失败（exe 缺失）释放锁允许下个转发器重试
 * - 不等待守护进程就绪（启动期间的事件走暂存兜底，§3.4）
 */
export function spawnDaemonIfNeeded(): void {
  const daemonPath = resolveDaemonPath();
  const lockPath = getDaemonLockPath();
  const release = acquireDaemonLock(lockPath);
  if (!release) return;

  try {
    const child = spawn(daemonPath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    child.once('error', () => {
      // exe 缺失等启动错误：释放锁，允许下一个转发器重试
      release();
    });
  } catch {
    release();
  }
}
