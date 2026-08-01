/**
 * 渲染进程守护（docs/MVP设计.md §2.3 / §4.5-4）。
 *
 * - 由守护进程拉起；控制管道断开或心跳超时视为崩溃，按 1s/2s/4s/8s（封顶 8s）指数退避重启；
 * - 60 秒窗口内最多 restart_max_attempts 次（§4.5-4），超限停手，等下一个宿主事件再试一轮；
 * - renderer_path 不存在（MVP 联调阶段常见）：记日志但不退避刷屏，等下一个宿主事件重试；
 * - 重连后的快照回放由调用方完成（app.ts），本模块只管进程生命周期。
 *
 * spawn 函数可注入（测试用假子进程；生产用 node:child_process.spawn）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from './logger.js';

/** 退避序列：1s/2s/4s/8s，之后封顶 8s（§4.5-4）。 */
export function backoffDelayMs(round: number): number {
  return Math.min(1000 * 2 ** round, 8000);
}

export type SpawnFn = (command: string, args: string[], options: { cwd: string }) => ChildProcess;

export interface RendererSupervisorOptions {
  rendererPath: string;
  restartMaxAttempts: number;
  /** 重启计数窗口（毫秒）。 */
  restartWindowMs: number;
  logger: Logger;
  spawnFn?: SpawnFn;
  now?: () => number;
  /** 退避间隔计算（测试注入短间隔；缺省 1s/2s/4s/8s 封顶 8s，§4.5-4）。 */
  backoffDelay?: (round: number) => number;
}

/** 渲染进程生命周期状态（供日志与测试断言）。 */
export type RendererStatus =
  | 'running' // 已拉起且未退出
  | 'waiting' // 崩溃/失联后处于退避等待中
  | 'stopped' // 窗口内超限停手，等宿主事件
  | 'missing' // renderer_path 不存在，等宿主事件
  | 'shutdown'; // 守护进程退出流程中，不再拉起

export class RendererSupervisor {
  private readonly rendererPath: string;
  private readonly restartMaxAttempts: number;
  private readonly restartWindowMs: number;
  private readonly logger: Logger;
  private readonly spawnFn: SpawnFn;
  private readonly now: () => number;
  private readonly backoffDelay: (round: number) => number;

  child: ChildProcess | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private statusValue: RendererStatus = 'waiting';
  /** 最近一次 spawn 的时间戳（毫秒），用于窗口内限流。 */
  private attemptTimes: number[] = [];
  /** 本轮退避序号（每次实际拉起后归零，宿主事件后也归零）。 */
  private round = 0;

  constructor(opts: RendererSupervisorOptions) {
    this.rendererPath = opts.rendererPath;
    this.restartMaxAttempts = opts.restartMaxAttempts;
    this.restartWindowMs = opts.restartWindowMs;
    this.logger = opts.logger;
    this.spawnFn = opts.spawnFn ?? ((command, args, options) => spawn(command, args, options));
    this.now = opts.now ?? Date.now;
    this.backoffDelay = opts.backoffDelay ?? backoffDelayMs;
  }

  get status(): RendererStatus {
    return this.statusValue;
  }

  /** 初始拉起（守护进程启动时，§4.5-1 冷启动）。 */
  start(): void {
    this.spawn();
  }

  /**
   * 宿主事件到达（§4.5-4：超限停手 / renderer_path 缺失后，等下一个宿主事件再试一轮）。
   * 宿主事件意味着宿主活跃、环境恢复正常：清空重启窗口计数并重置退避轮次。
   * 进程正常运行中则仅刷新计数，不重复拉起。
   */
  onHostEvent(): void {
    this.round = 0;
    this.attemptTimes = [];
    if (this.status === 'stopped' || this.status === 'missing') {
      this.logger.info('收到宿主事件，重新尝试拉起渲染进程');
      this.spawn();
    } else if (!this.child && !this.pendingTimer && this.status !== 'shutdown') {
      this.spawn();
    }
  }

  /** 控制管道断开 / 心跳超时 → 渲染进程失联（§4.5-4）。 */
  onConnectionLost(): void {
    if (this.status === 'shutdown') return;
    if (this.pendingTimer) return; // 已在退避等待中
    if (this.child) {
      // 管道断了但进程还在（异常挂起等）：杀掉走 exit 路径统一处理
      this.logger.warn('控制管道断开但渲染进程仍在，强制结束');
      this.killChild();
      return;
    }
    this.scheduleRestart('渲染进程失联');
  }

  /** 守护进程退出流程：停止一切重启（渲染进程收到 shutdown 消息后自行退出，由调用方兜底 forceKill）。 */
  shutdown(): void {
    this.statusValue = 'shutdown';
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  /** 兜底强制结束子进程（守护进程退出前调用；已由 shutdown 停止重启逻辑，不会再次拉起）。 */
  forceKill(): void {
    this.killChild();
  }

  get isShuttingDown(): boolean {
    return this.status === 'shutdown';
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private spawn(): void {
    if (this.status === 'shutdown') return;
    if (this.child || this.pendingTimer) return;

    if (!fs.existsSync(this.rendererPath)) {
      // MVP 联调阶段渲染进程可能不存在：记日志，不退避刷屏，等宿主事件重试
      this.statusValue = 'missing';
      this.logger.warn(`渲染进程不存在（${this.rendererPath}），等待宿主事件后重试`);
      return;
    }

    // 窗口内限流：60 秒内最多 restart_max_attempts 次（§4.5-4）
    const now = this.now();
    this.attemptTimes = this.attemptTimes.filter((t) => now - t < this.restartWindowMs);
    if (this.attemptTimes.length >= this.restartMaxAttempts) {
      this.statusValue = 'stopped';
      this.logger.warn(
        `渲染进程 ${this.restartMaxAttempts} 次重启超过 ${this.restartWindowMs / 1000}s 窗口，停止重启，等待宿主事件`,
      );
      return;
    }
    this.attemptTimes.push(now);

    this.statusValue = 'running';
    this.logger.info(`拉起渲染进程（第 ${this.attemptTimes.length} 次/窗口）: ${this.rendererPath}`);
    let child: ChildProcess;
    try {
      // cwd 取可执行文件所在目录：UE 需要相对自身目录加载数据包。
      // -RenderOffScreen：游戏主窗口从创建起就不显示（CreateGameWindow 里跳过 ShowWindow），
      // 根除启动时全屏黑窗口闪现；SceneCapture→RT→回读与窗口可见性无关，不受影响。
      child = this.spawnFn(this.rendererPath, ['-RenderOffScreen'], { cwd: path.dirname(this.rendererPath) });
    } catch (err) {
      this.child = null;
      this.statusValue = 'missing';
      this.logger.warn(`拉起渲染进程失败: ${(err as Error).message}，等待宿主事件后重试`);
      return;
    }
    this.child = child;

    child.once('error', (err) => {
      // spawn 失败（exe 缺失/权限等）：进程未启动
      this.child = null;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES') {
        this.statusValue = 'missing';
        this.logger.warn(`渲染进程无法启动（${code}）: ${this.rendererPath}，等待宿主事件后重试`);
      } else {
        this.scheduleRestart(`渲染进程启动失败（${code ?? err.message}）`);
      }
    });

    child.once('exit', (code, signal) => {
      this.child = null;
      if (this.status === 'shutdown') return;
      this.logger.info(`渲染进程退出 code=${code} signal=${signal ?? ''}`);
      this.scheduleRestart('渲染进程崩溃');
    });
  }

  private scheduleRestart(cause: string): void {
    if (this.status === 'shutdown') return;
    if (this.pendingTimer || this.child) return;
    // 缺失路径不安排退避（等宿主事件），其余情况按 1s/2s/4s/8s 退避
    if (this.status === 'missing' || !fs.existsSync(this.rendererPath)) {
      this.statusValue = 'missing';
      return;
    }
    // 窗口内限流（§4.5-4）：60 秒内最多 restart_max_attempts 次，超限立即停手等宿主事件
    const now = this.now();
    this.attemptTimes = this.attemptTimes.filter((t) => now - t < this.restartWindowMs);
    if (this.attemptTimes.length >= this.restartMaxAttempts) {
      this.statusValue = 'stopped';
      this.logger.warn(
        `渲染进程 ${this.restartMaxAttempts} 次重启超过 ${this.restartWindowMs / 1000}s 窗口，停止重启，等待宿主事件`,
      );
      return;
    }
    const delay = this.backoffDelay(this.round);
    this.round = Math.min(this.round + 1, 4); // 1,2,4,8,8,…（封顶 8s）
    this.statusValue = 'waiting';
    this.logger.info(`${cause}，${delay}ms 后重启渲染进程`);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.spawn();
    }, delay);
    this.pendingTimer.unref?.();
  }

  private killChild(): void {
    if (this.child) {
      const c = this.child;
      this.child = null;
      try {
        c.kill(); // Windows 上 node 用 TerminateProcess
      } catch {
        // 进程已死，忽略
      }
    }
  }
}
