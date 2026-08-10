/**
 * 守护进程主体（kimi-petd）：把配置/状态机/两条管道/渲染进程守护/终端唤起/暂存回收组装在一起。
 *
 * 职责（§2.3）：建两条管道；事件汇总与状态推导；任务列表维护；事件缓存与补发（快照）；
 * 渲染进程启动/崩溃重启；收到 open_tui 打开终端；收尾退出（§4.5-6）。
 *
 * 单实例（§4.1）：Node 侧没有 Win32 命名互斥体 API，用事件管道名占用实现 —— 同名管道创建失败
 * （EADDRINUSE/EACCES）即视为已有实例，调用方直接退出。管道访问控制见 pipes.ts 文件头注释
 * （node:net 命名管道继承进程默认安全描述符，仅当前用户可访问）。
 */
import * as net from 'node:net';
import * as os from 'node:os';
import { createEnvelope, validateEnvelope, type MessageEnvelope } from '../protocol/index.js';
import {
  DAEMON_VERSION,
  type DaemonConfig,
  getLogFilePath,
} from './config.js';
import { ControlSession, type ControlCallbacks } from './control.js';
import { Logger } from './logger.js';
import { PetStateStore } from './petstate.js';
import { createLineFramedServer } from './pipes.js';
import { RendererSupervisor, type SpawnFn } from './renderer.js';
import { replayStagingDir } from './staging.js';
import { PetStateMachine, type OutgoingMessage } from './state.js';
import { openTui, type OpenTuiOptions, type OpenTuiResult } from './terminal.js';
import {
  mergeSessionSnapshots,
  readSessionCatalog,
  type SessionCatalogEntry,
  type SessionCatalogReader,
} from './session-catalog.js';
import { getEventPipeName, getControlPipeName } from '../bridge/user.js';
import {
  PROTOCOL_VERSION,
  type HelloPayload,
  type HostEventPayload,
  type OpenTuiPayload,
  type ShutdownReason,
} from '../protocol/types.js';
import { getStagingDir } from '../bridge/staging.js';

/** 错误计数窗口（毫秒），§4.4：连续超阈值（10 条/分钟）记日志告警。 */
const ERROR_WINDOW_MS = 60_000;
/** 错误告警阈值（条/窗口）。 */
const ERROR_WARN_THRESHOLD = 10;
/** 渲染进程收到 shutdown 后的强制结束宽限（毫秒）。 */
const RENDERER_EXIT_GRACE_MS = 3000;

/** 单实例冲突：事件管道已被占用 → 已有守护进程实例（§4.1）。 */
export class SingleInstanceError extends Error {
  constructor(readonly pipeName: string, readonly code: string) {
    super(`已有守护进程实例（${pipeName}，${code}）`);
    this.name = 'SingleInstanceError';
  }
}

export interface DaemonAppOptions {
  config: DaemonConfig;
  logger?: Logger;
  /** 事件管道全名，缺省按当前用户名推导（§4.1）。 */
  eventPipeName?: string;
  /** 控制管道全名，缺省按当前用户名推导（§4.1）。 */
  controlPipeName?: string;
  /** 暂存目录，缺省 %TEMP%/kimi-pet-events/（§3.3）。 */
  stagingDir?: string;
  /** 渲染进程 spawn 注入（测试用）。 */
  rendererSpawn?: SpawnFn;
  /** 退出回调，缺省 process.exit(0)（测试注入 spy）。 */
  onExit?: (reason: ShutdownReason) => void;
  /** 时钟注入（测试用），缺省 Date.now。 */
  now?: () => number;
  /** 终端唤起函数注入（测试用），缺省使用 openTui。 */
  openTuiFn?: (opts: OpenTuiOptions) => Promise<OpenTuiResult>;
  /** CLI 会话目录读取函数注入（测试用），缺省读取 KIMI_CODE_HOME/session_index.jsonl。 */
  sessionCatalog?: SessionCatalogReader;
  /** 渲染进程收到 shutdown 后的强制结束宽限（毫秒），缺省 3000。 */
  exitGraceMs?: number;
}

export class DaemonApp {
  readonly config: DaemonConfig;
  readonly logger: Logger;
  readonly state: PetStateMachine;
  readonly renderer: RendererSupervisor;
  readonly petState: PetStateStore;

  private readonly eventPipeName: string;
  private readonly controlPipeName: string;
  private readonly stagingDir: string;
  private readonly onExit: (reason: ShutdownReason) => void;
  private readonly exitGraceMs: number;
  private readonly openTuiFn: (opts: OpenTuiOptions) => Promise<OpenTuiResult>;
  private readonly sessionCatalogFn: SessionCatalogReader;
  private sessionCatalogEntries: SessionCatalogEntry[] = [];
  private sessionCatalogLoaded = false;

  private eventServer: net.Server | null = null;
  private controlServer: net.Server | null = null;
  private controlSession: ControlSession | null = null;
  private countdownTimer: NodeJS.Timeout | null = null;
  private readonly throttleTimers = new Map<string, NodeJS.Timeout>();
  private housekeepingTimer: NodeJS.Timeout | null = null;
  private errorTimes: number[] = [];
  private lastErrorWarnAt = 0;
  private exiting = false;

  constructor(opts: DaemonAppOptions) {
    this.config = opts.config;
    this.logger =
      opts.logger ?? new Logger({ level: this.config.log_level, filePath: getLogFilePath(process.env) });
    this.eventPipeName = opts.eventPipeName ?? getEventPipeName();
    this.controlPipeName = opts.controlPipeName ?? getControlPipeName();
    this.stagingDir = opts.stagingDir ?? getStagingDir();
    this.onExit = opts.onExit ?? (() => process.exit(0));
    this.exitGraceMs = opts.exitGraceMs ?? RENDERER_EXIT_GRACE_MS;
    this.openTuiFn = opts.openTuiFn ?? openTui;
    this.sessionCatalogFn = opts.sessionCatalog ?? (() => readSessionCatalog());
    const now = opts.now ?? Date.now;

    this.state = new PetStateMachine({
      staleMs: this.config.session.staleMinutes * 60_000,
      now,
    });
    this.renderer = new RendererSupervisor({
      rendererPath: this.config.renderer_path,
      restartMaxAttempts: this.config.restart_max_attempts,
      restartWindowMs: this.config.restart_window_s * 1000,
      logger: this.logger,
      spawnFn: opts.rendererSpawn,
      now,
    });
    this.petState = new PetStateStore(undefined, { now });
  }

  /** 建两条管道 → 拉起渲染进程 → 回收暂存 → 周期任务。事件管道被占用时抛 SingleInstanceError。 */
  async start(): Promise<void> {
    // 1. 事件管道服务端（§4.1；占用失败 = 已有实例）
    this.eventServer = createLineFramedServer(this.eventPipeName, (line) => this.handleEventLine(line));
    await new Promise<void>((resolve, reject) => {
      this.eventServer!.once('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (code === 'EADDRINUSE' || code === 'EACCES' || code === 'EEXIST') {
          reject(new SingleInstanceError(this.eventPipeName, code));
        } else {
          reject(err);
        }
      });
      this.eventServer!.listen(this.eventPipeName, () => resolve());
    });

    // 2. 控制管道服务端（§4.1，渲染进程主动连入）
    this.controlServer = net.createServer((socket) => this.onControlConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.controlServer!.once('error', reject);
      this.controlServer!.listen(this.controlPipeName, () => resolve());
    });

    this.logger.info(
      `守护进程 v${DAEMON_VERSION} 就绪: 事件管道 ${this.eventPipeName} | 控制管道 ${this.controlPipeName}`,
    );

    // 3. 冷启动拉起渲染进程（§4.5-1；路径缺失时等宿主事件重试）
    this.renderer.start();

    // 4. 回收暂存（§3.3：字典序=时间序，重放后删除）
    const replayed = replayStagingDir(this.stagingDir, (env) => this.handleHostEnvelope(env), this.logger);
    if (replayed > 0) this.logger.info(`回收并重放 ${replayed} 条暂存事件`);

    // 5. 周期任务：心跳超时判定（§4.5-4）/ 会话卡死兜底（§3.4）
    this.housekeepingTimer = setInterval(() => this.housekeeping(), 1000);
    this.housekeepingTimer.unref?.();
  }

  /** 优雅停止（测试用）：清定时器、关管道、结束渲染进程。 */
  async stop(): Promise<void> {
    this.exiting = true;
    if (this.countdownTimer) clearTimeout(this.countdownTimer);
    this.countdownTimer = null;
    for (const t of this.throttleTimers.values()) clearTimeout(t);
    this.throttleTimers.clear();
    if (this.housekeepingTimer) clearInterval(this.housekeepingTimer);
    this.housekeepingTimer = null;
    this.state.clearAllPending();
    this.controlSession?.close();
    this.controlSession = null;
    this.renderer.shutdown();
    this.renderer.forceKill();
    this.petState.flush();
    await closeServer(this.eventServer);
    await closeServer(this.controlServer);
  }

  /** 外部请求退出（信号/未捕获异常）：发 shutdown → 宽限 → 强制结束 → onExit。 */
  requestShutdown(reason: ShutdownReason): void {
    this.doExit(reason);
  }

  // -------------------------------------------------------------------------
  // 事件管道
  // -------------------------------------------------------------------------

  /** 一行 → 信封校验 → 只接受 host_event（§4.3 唯一入站类型）；非法跳过并计数（§4.4）。 */
  private handleEventLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.countError('事件管道收到非法 JSON');
      return;
    }
    const validation = validateEnvelope(parsed);
    if (!validation.ok) {
      this.countError(`事件管道信封校验失败: ${validation.errors.join('; ')}`);
      return;
    }
    const env = validation.envelope;
    if (env.type !== 'host_event') {
      this.countError(`事件管道收到非 host_event 类型: ${env.type}`);
      return;
    }
    if (typeof (env.payload as HostEventPayload)._raw !== 'string') {
      this.countError('host_event 缺少 _raw 字符串');
      return;
    }
    this.handleHostEnvelope(env);
  }

  /** host_event 信封 → 状态机 → 下发消息（事件管道与暂存重放共用入口）。 */
  private handleHostEnvelope(env: MessageEnvelope): void {
    this.cancelCountdown(); // 倒计时内新宿主事件取消退出（§4.5-6）
    const result = this.state.processHostEvent((env.payload as HostEventPayload)._raw);
    if (!result.ok) {
      this.countError(`host_event 处理失败: ${result.error}`);
      return;
    }
    this.renderer.onHostEvent(); // 渲染进程停手/缺失时，宿主事件触发新一轮尝试（§4.5-4）
    for (const msg of result.out) this.sendToRenderer(msg);
    // 节流会话以状态机解析结果为准（信封 session_id 可能缺失，如异常转发器/旧暂存文件）
    if (result.throttled && (result.sessionId ?? env.session_id)) {
      this.scheduleThrottleFlush(result.sessionId ?? env.session_id!);
    }
    if (result.hostIdle) this.startCountdown();
  }

  // -------------------------------------------------------------------------
  // 控制管道
  // -------------------------------------------------------------------------

  private onControlConnection(socket: net.Socket): void {
    this.logger.info('渲染进程连入控制管道');
    if (this.controlSession && !this.controlSession.isClosed) {
      this.logger.warn('已有渲染进程连接，替换旧连接');
      this.controlSession.close();
    }
    const callbacks: ControlCallbacks = {
      onHello: (payload) => this.onRendererHello(session, payload),
      onOpenTui: (payload) => this.onOpenTui(payload),
      onPetMoved: (payload) => this.petState.updateWindow(payload.x, payload.y, payload.monitor_id),
      onClosed: () => {
        if (this.controlSession === session) this.controlSession = null;
        // 失联 → 渲染进程崩溃处理（§4.5-4）；已被新会话接管则忽略
        if (!this.controlSession) this.renderer.onConnectionLost();
      },
    };
    const session = new ControlSession(socket, callbacks, {
      logger: this.logger,
      onProtocolError: (d) => this.countError(d),
    });
    this.controlSession = session;
  }

  /** 握手：回 hello + 补发快照（§4.5-1/4：活跃会话 + 当前 pet_state + 未完成任务列表）。 */
  private onRendererHello(session: ControlSession, payload: HelloPayload): void {
    this.logger.info(
      `渲染进程握手 pid=${payload.pid} version=${payload.version} capabilities=${JSON.stringify(payload.capabilities ?? [])}`,
    );
    session.send(
      createEnvelope('hello', {
        protocol_version: PROTOCOL_VERSION,
        role: 'daemon',
        pid: process.pid,
        version: DAEMON_VERSION,
        capabilities: [],
      }),
    );
    const snap = this.state.getSnapshot();
    this.sessionCatalogEntries = this.readSessionCatalogSafely();
    this.sessionCatalogLoaded = true;
    const sessionsSnapshot = mergeSessionSnapshots(this.sessionCatalogEntries, snap.sessions);
    session.send(createEnvelope('sessions_snapshot', { sessions: sessionsSnapshot }, {}));
    for (const s of snap.sessions) {
      session.send(createEnvelope('session_start', { cwd: s.cwd ?? '', resume: s.resume }, { session_id: s.sessionId }));
      session.send(
        createEnvelope(
          'session_state',
          { working: s.busy, unread: s.unread },
          { session_id: s.sessionId },
        ),
      );
    }
    session.send(createEnvelope('pet_state', { state: snap.state, reason: snap.reason }, {}));
    session.send(createEnvelope('tasks_snapshot', { tasks: snap.tasks }, {}));
    this.logger.info(
      `快照回放: ${sessionsSnapshot.length} 个目录会话（${snap.sessions.length} 个活跃）, pet_state=${snap.state}(${snap.reason}), ${snap.tasks.length} 个未完成任务`,
    );
  }

  /** open_tui（§4.5-3）：会话 id 为空 → 最近会话；cwd 取会话 cwd，取不到回退用户主目录。 */
  private onOpenTui(payload: OpenTuiPayload): void {
    if (!this.sessionCatalogLoaded) {
      this.sessionCatalogEntries = this.readSessionCatalogSafely();
      this.sessionCatalogLoaded = true;
    }
    const recentActive = this.state.mostRecentSession();
    const requestedSession = payload.session_id;
    const sessionId = requestedSession ?? recentActive?.sessionId ?? this.sessionCatalogEntries[0]?.sessionId ?? null;
    const catalogEntry = sessionId
      ? this.sessionCatalogEntries.find((entry) => entry.sessionId === sessionId)
      : undefined;
    const cwd = (sessionId ? this.state.getSessionCwd(sessionId) : null) ?? catalogEntry?.cwd ?? recentActive?.cwd ?? os.homedir();
    if (sessionId) {
      const readUpdate = this.state.markSessionRead(sessionId);
      if (readUpdate) this.sendToRenderer(readUpdate);
    }
    this.logger.info(`open_tui source=${payload.source} session=${sessionId ?? '(最近会话)'} cwd=${cwd}`);
    void this.openTuiFn({ terminal: this.config.terminal, cwd, sessionId }).then((res) => {
      if (res.ok) this.logger.info(`open_tui 唤起成功（${res.terminal}）`);
      else this.logger.warn(`open_tui 唤起失败（${res.terminal}）: ${res.error ?? ''}`);
    });
  }

  /** 目录属于外部 CLI 状态，读取失败时按空目录处理，不能阻断握手。 */
  private readSessionCatalogSafely(): SessionCatalogEntry[] {
    try {
      return this.sessionCatalogFn();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`读取 Kimi Code 会话目录失败: ${detail}`);
      return [];
    }
  }

  /** 下发一条消息给渲染进程；未连接时丢弃（快照在握手时补发，§2.2 D1）。 */
  private sendToRenderer(msg: OutgoingMessage): void {
    const cs = this.controlSession;
    if (!cs || cs.isClosed) {
      this.logger.debug(`渲染进程未连接，丢弃消息 ${msg.type}`);
      return;
    }
    const env = createEnvelope(msg.type, msg.payload as never, { session_id: msg.session_id });
    cs.send(env);
  }

  /** 200ms 合并窗口：同会话连续任务事件攒一批下发（§3.4 节流）。 */
  private scheduleThrottleFlush(sessionId: string): void {
    if (!this.state.hasPendingThrottle(sessionId)) return;
    if (this.throttleTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.throttleTimers.delete(sessionId);
      for (const msg of this.state.drainThrottled(sessionId, true)) this.sendToRenderer(msg);
    }, this.state.throttleWindowMs);
    this.throttleTimers.set(sessionId, timer);
  }

  // -------------------------------------------------------------------------
  // 退出（§4.5-6）
  // -------------------------------------------------------------------------

  /** 最后一个 SessionEnd → host_grace_seconds 倒计时；auto_quit_with_host=false 时保持常驻。 */
  private startCountdown(): void {
    if (this.countdownTimer) return;
    if (!this.config.auto_quit_with_host) {
      this.logger.info('宿主全部退出，auto_quit_with_host=false，守护进程保持常驻');
      return;
    }
    this.logger.info(`最后一个 SessionEnd，${this.config.host_grace_seconds}s 后退出（host_grace_seconds）`);
    this.countdownTimer = setTimeout(() => {
      this.countdownTimer = null;
      this.doExit('host_gone');
    }, this.config.host_grace_seconds * 1000);
  }

  private cancelCountdown(): void {
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
      this.logger.info('收到宿主事件，取消退出倒计时');
    }
  }

  private doExit(reason: ShutdownReason): void {
    if (this.exiting) return;
    this.exiting = true;
    this.logger.info(`守护进程退出，reason=${reason}`);
    this.petState.flush();
    this.state.clearAllPending();
    if (this.countdownTimer) clearTimeout(this.countdownTimer);
    for (const t of this.throttleTimers.values()) clearTimeout(t);
    this.throttleTimers.clear();
    if (this.housekeepingTimer) clearInterval(this.housekeepingTimer);

    this.controlSession?.send(createEnvelope('shutdown', { reason }, {}));
    this.controlSession?.close();
    this.renderer.shutdown(); // 停止重启逻辑；渲染进程收到 shutdown 后自行退出

    // 宽限后强制结束渲染进程并退出（§2.3：渲染进程随守护进程退出）
    setTimeout(() => {
      this.renderer.forceKill();
      void closeServer(this.eventServer);
      void closeServer(this.controlServer);
      this.onExit(reason);
    }, this.exitGraceMs);
  }

  // -------------------------------------------------------------------------
  // 周期任务与错误计数
  // -------------------------------------------------------------------------

  private housekeeping(): void {
    if (this.exiting) return;
    // 心跳超时判死（§4.5-4：heartbeat 3s，heartbeat_timeout_ms 10s；任意合法消息都刷新存活时间）
    const cs = this.controlSession;
    if (cs && !cs.isClosed && this.config.heartbeat_timeout_ms > 0) {
      if (Date.now() - cs.lastRxAt > this.config.heartbeat_timeout_ms) {
        this.logger.warn(`渲染进程心跳超时（${this.config.heartbeat_timeout_ms}ms），按崩溃处理`);
        cs.close(); // close → onClosed → 渲染进程重启路径
      }
    }
    // 会话卡死兜底（§3.4）：超时会话强制转闲，状态切换消息下发
    for (const msg of this.state.markStaleSessions()) this.sendToRenderer(msg);
  }

  /** 错误计数（§4.4）：非法消息跳过 + 计数 +1；连续超阈值（10 条/分钟）告警，不中断连接。 */
  private countError(description: string): void {
    const now = Date.now();
    this.errorTimes = this.errorTimes.filter((t) => now - t < ERROR_WINDOW_MS);
    this.errorTimes.push(now);
    this.logger.debug(`协议错误: ${description}（近 60s 共 ${this.errorTimes.length} 条）`);
    if (this.errorTimes.length > ERROR_WARN_THRESHOLD && now - this.lastErrorWarnAt > ERROR_WINDOW_MS) {
      this.lastErrorWarnAt = now;
      this.logger.warn(`协议错误超过 ${ERROR_WARN_THRESHOLD} 条/分钟，可能存在异常发送方（不中断连接）`);
    }
  }
}

/** 关闭一个 net.Server（未监听/已关闭时安全返回）。 */
function closeServer(server: net.Server | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      // closeAllConnections 在较新的 @types/node 中才有类型定义，这里按可选能力调用
      (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.(); // 强制断开残留连接（探测连接等）
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}
