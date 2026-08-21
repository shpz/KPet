/**
 * 守护进程主体（kpetd）：把配置/状态机/两条管道/渲染进程守护/终端唤起/暂存回收组装在一起。
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
  applyConfigPatch,
  DAEMON_VERSION,
  type DaemonConfig,
  getConfigPath,
  getLogFilePath,
  saveConfig,
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
  MAX_RAW_EXCERPT_CHARS,
  PROTOCOL_VERSION,
  type HelloPayload,
  type HostEventPayload,
  type OpenTuiPayload,
  type ShutdownReason,
  type UpdateConfigPayload,
  truncate,
} from '../protocol/types.js';
import { clearStagingDir, getStagingDir } from '../bridge/staging.js';
import {
  acquireOwnedDaemonLock,
  clearPetRecoveryPending,
  getDaemonLockPath,
  getPetRecoveryPath,
  getPetRecoveryGatePath,
  getPetSuppressionPath,
  hasActiveDeliveryLeases,
  isPetRecoveryPending,
  isPetSuppressed,
  refreshDaemonLock,
  RECOVERY_GATE_LOCK_TTL_MS,
  setPetSuppressed,
  type OwnedDaemonLock,
} from '../bridge/daemon.js';

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
  /** 暂存目录，缺省 %TEMP%/kpet-events/（§3.3）。 */
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
  /** 用户关闭抑制标记路径，缺省 %TEMP%/kpet/pet.disabled。 */
  suppressionPath?: string;
  /** 拉起锁路径，缺省 %TEMP%/kpet/daemon.lock。 */
  daemonLockPath?: string;
  /** 恢复中标记路径，缺省 %TEMP%/kpet/pet.recovering。 */
  recoveryPath?: string;
  /** 配置文件路径（update_config 持久化写回用），缺省 getConfigPath()。 */
  configPath?: string;
}

export class DaemonApp {
  /** 运行时配置；renderer→daemon 的 update_config 会整体替换启用合并后的新对象。 */
  config: DaemonConfig;
  readonly logger: Logger;
  readonly state: PetStateMachine;
  readonly renderer: RendererSupervisor;
  readonly petState: PetStateStore;

  private readonly eventPipeName: string;
  private readonly controlPipeName: string;
  private readonly stagingDir: string;
  private readonly suppressionPath: string;
  private readonly daemonLockPath: string;
  private readonly recoveryPath: string;
  /** update_config 持久化写回的配置文件路径（缺省 KIMI_CODE_HOME/kpet/config.json）。 */
  private readonly configPath: string;
  /** 启动时已进入恢复批次；该实例必须在锁内回放后才启动 renderer。 */
  private recoveryOwner = false;
  /** 启动回放期只恢复状态，不允许 host event 的重试逻辑提前拉起 renderer。 */
  private replayingStaging = false;
  private readonly onExit: (reason: ShutdownReason) => void;
  private readonly exitGraceMs: number;
  private readonly openTuiFn: (opts: OpenTuiOptions) => Promise<OpenTuiResult>;
  private readonly sessionCatalogFn: SessionCatalogReader;
  private sessionCatalogEntries: SessionCatalogEntry[] = [];
  private sessionCatalogLoaded = false;
  /** 守护进程本轮见过的会话工作目录，供刚结束且目录尚未落盘的 open_tui 使用。 */
  private readonly runtimeSessionCwds = new Map<string, string>();

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
    this.suppressionPath = opts.suppressionPath ?? getPetSuppressionPath();
    this.daemonLockPath = opts.daemonLockPath ?? getDaemonLockPath();
    this.recoveryPath = opts.recoveryPath ?? getPetRecoveryPath();
    this.configPath = opts.configPath ?? getConfigPath();
    this.onExit = opts.onExit ?? (() => process.exit(0));
    this.exitGraceMs = opts.exitGraceMs ?? RENDERER_EXIT_GRACE_MS;
    this.openTuiFn = opts.openTuiFn ?? openTui;
    this.sessionCatalogFn = opts.sessionCatalog ?? (() => readSessionCatalog());
    const now = opts.now ?? Date.now;

    this.state = new PetStateMachine({
      staleMs: this.config.session.staleMinutes * 60_000,
      cleanupMs: this.config.session.cleanupMinutes * 60_000,
      now,
    });
    this.renderer = new RendererSupervisor({
      rendererPath: this.config.renderer_path,
      restartMaxAttempts: this.config.restart_max_attempts,
      restartWindowMs: this.config.restart_window_s * 1000,
      logger: this.logger,
      spawnFn: opts.rendererSpawn,
      now,
      isSuppressed: () => isPetSuppressed(this.suppressionPath),
      onSuppressed: () => this.requestShutdown('user'),
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

    // 3. 启动判定与暂存回放统一放进恢复 gate。Bridge 无法在 daemon 已扫描目录后、
    // 清恢复标记前再写入文件；第一次抑制检查之后才发生的关闭也会在锁内被看见。
    const gatePath = getPetRecoveryGatePath(this.recoveryPath);
    const gate = await acquireStartupGate(gatePath, this.recoveryPath);
    if (!gate) throw new Error('恢复交接锁超时');
    let replayed = 0;
    let suppressedDuringStartup = false;
    this.replayingStaging = true;
    try {
      suppressedDuringStartup = isPetSuppressed(this.suppressionPath);
      if (!suppressedDuringStartup) {
        // worker 可能在对象构造后、管道监听完成前才消费 suppression；恢复所有权必须
        // 在启动临界点重新判定，不能使用构造时的过早快照。
        this.recoveryOwner = isPetRecoveryPending(this.recoveryPath);
        replayed = replayStagingDir(
          this.stagingDir,
          (env) => this.handleHostEnvelope(env),
          this.logger,
          () => assertGateOwnership(gatePath, gate),
        );
        assertGateOwnership(gatePath, gate);
        suppressedDuringStartup = isPetSuppressed(this.suppressionPath);
        if (this.recoveryOwner && !suppressedDuringStartup
          && !clearPetRecoveryPending(this.recoveryPath)) {
          throw new Error('无法清除恢复标记');
        }
      }
    } finally {
      gate.release();
      this.replayingStaging = false;
    }
    if (suppressedDuringStartup) {
      this.logger.info('启动交接期检测到用户关闭标记，守护进程立即按 user 退出并释放管道');
      this.doExit('user');
      return;
    }
    if (this.recoveryOwner) {
      this.logger.info('恢复期暂存已完成有序重放，清除恢复标记并开放直接投递');
    }
    if (replayed > 0) this.logger.info(`回收并重放 ${replayed} 条暂存事件`);

    // 4. 先完成状态回放，再拉起 renderer，使其首次握手必然获得完整快照。
    this.renderer.start();

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
    if (this.exiting || isPetSuppressed(this.suppressionPath)) {
      // Bridge 是正常入口，但守护进程自身也要防御绕过 Bridge 的旧事件，避免关闭后复活。
      this.logger.debug('用户关闭抑制期或退出中，丢弃事件管道输入');
      return;
    }
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
    if (this.exiting) {
      this.logger.debug('守护进程正在退出，丢弃宿主事件');
      return;
    }
    this.cancelCountdown(); // 倒计时内新宿主事件取消退出（§4.5-6）
    // SessionEnd 会在状态机处理时删除会话；先保存已知 cwd，避免用户随后立刻
    // 从面板打开该会话时因 CLI 目录尚未落盘而退回用户主目录。
    const previousCwd = env.session_id ? this.state.getSessionCwd(env.session_id) : null;
    const result = this.state.processHostEvent((env.payload as HostEventPayload)._raw);
    if (!result.ok) {
      this.countError(`host_event 处理失败: ${result.error}`);
      return;
    }
    if (result.sessionId) {
      const runtimeCwd = this.state.getSessionCwd(result.sessionId) ?? previousCwd;
      if (runtimeCwd) this.runtimeSessionCwds.set(result.sessionId, runtimeCwd);
    }
    // 启动回放只恢复状态，renderer 在全部回放完成后统一拉起；
    // 实时宿主事件仍可在停手/缺失时触发新一轮尝试（§4.5-4）。
    if (!this.replayingStaging) this.renderer.onHostEvent();
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
    if (this.exiting || isPetSuppressed(this.suppressionPath)) {
      socket.destroy();
      if (!this.exiting) this.requestShutdown('user');
      return;
    }
    this.logger.info('渲染进程连入控制管道');
    if (this.controlSession && !this.controlSession.isClosed) {
      this.logger.warn('已有渲染进程连接，替换旧连接');
      this.controlSession.close();
    }
    const callbacks: ControlCallbacks = {
      onHello: (payload) => this.onRendererHello(session, payload),
      onOpenTui: (payload) => this.onOpenTui(payload),
      onPetMoved: (payload) => this.petState.updateWindow(payload.x, payload.y, payload.monitor_id),
      onUpdateConfig: (payload) => this.onUpdateConfig(payload),
      onClosePet: (payload) => this.onClosePet(payload),
      onClosed: () => {
        if (this.controlSession === session) this.controlSession = null;
        if (isPetSuppressed(this.suppressionPath)) {
          // UE 可能先写标记后因断线未送达 close_pet；此时也必须走用户关闭退出路径。
          this.logger.info('控制管道断开且检测到用户关闭标记，守护进程退出');
          this.requestShutdown('user');
          return;
        }
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
    this.pushConfigSnapshot(session);
    this.logger.info(
      `快照回放: ${sessionsSnapshot.length} 个目录会话（${snap.sessions.length} 个活跃）, pet_state=${snap.state}(${snap.reason}), ${snap.tasks.length} 个未完成任务`,
    );
  }

  /** update_config（设置 WebUI 保存）：校验合并进内存配置 → 写回 config.json → 推送 config_snapshot。 */
  private onUpdateConfig(payload: UpdateConfigPayload): void {
    const { config, applied, warnings } = applyConfigPatch(this.config, payload);
    for (const w of warnings) this.logger.warn(w);
    if (Object.keys(applied).length === 0) {
      // 无任何合法字段：按 §4.4 回 protocol_error，配置保持原样
      this.countError(`update_config 无合法字段: ${JSON.stringify(payload)}`);
      const cs = this.controlSession;
      if (cs && !cs.isClosed) {
        cs.send(
          createEnvelope('protocol_error', {
            description: 'update_config 至少需要一个合法字段',
            raw_excerpt: truncate(JSON.stringify(payload), MAX_RAW_EXCERPT_CHARS),
          }),
        );
      }
      return;
    }
    this.config = config;
    if (!saveConfig(this.configPath, applied)) {
      this.logger.warn(`update_config 写回配置文件失败（${this.configPath}），仅本次运行时生效`);
    } else {
      this.logger.info(`update_config 已应用并持久化: ${JSON.stringify(applied)}`);
    }
    this.pushConfigSnapshot();
  }

  /** 下发全量配置快照（握手收尾与 update_config 生效后调用；未连接时跳过）。 */
  private pushConfigSnapshot(session?: ControlSession): void {
    const cs = session ?? this.controlSession;
    if (!cs || cs.isClosed) {
      this.logger.debug('渲染进程未连接，跳过 config_snapshot');
      return;
    }
    cs.send(
      createEnvelope('config_snapshot', {
        open_target: this.config.open_target,
        ui_theme: this.config.ui_theme,
        fps_monitor: this.config.fps_monitor,
        open_web_url: this.config.open_web_url,
      }),
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
    const cwd = (sessionId ? this.state.getSessionCwd(sessionId) : null)
      ?? (sessionId ? this.runtimeSessionCwds.get(sessionId) : null)
      ?? catalogEntry?.cwd
      ?? recentActive?.cwd
      ?? os.homedir();
    if (sessionId) {
      const readUpdate = this.state.markSessionRead(sessionId);
      if (readUpdate) this.sendToRenderer(readUpdate);
    }
    this.logger.info(
      `open_tui source=${payload.source} target=${this.config.open_target} session=${sessionId ?? '(最近会话)'} cwd=${cwd}`,
    );
    void this.openTuiFn({
      target: this.config.open_target,
      terminal: this.config.terminal,
      webUrl: this.config.open_web_url,
      cwd,
      sessionId,
      // wsl_distro 配置项（空串 = 未指定 WSL 发行版）；terminal=wsl 时 buildOpenTuiCommand 用它
      // 把 Linux cwd 转成 \\wsl.localhost\<distro>\... 形态。此处直接透传配置，
      // cwd 的转换在 terminal.ts 内部完成（跨平台兼容方案 §3.1）。
      wslDistro: this.config.wsl_distro,
    }).then((res) => {
      if (res.ok) {
        this.logger.info(`open_tui 唤起成功（${res.terminal}）`);
      } else {
        // 失败不能只写日志让用户无感知：补发一条 error 气泡（§4.5-3 / §6.5 语义同源）。
        this.logger.warn(`open_tui 唤起失败（${res.terminal}）: ${res.error ?? ''}`);
        this.sendToRenderer({
          type: 'notify',
          session_id: sessionId,
          payload: { text: `打开会话失败：${res.error ?? '未知原因'}`, level: 'error' },
        });
      }
    }).catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`open_tui 异常: ${detail}`);
      this.sendToRenderer({
        type: 'notify',
        session_id: sessionId,
        payload: { text: '打开会话失败：内部错误', level: 'error' },
      });
    });
  }

  /** 用户从渲染进程请求关闭：持久化抑制、清理旧事件，再发送 shutdown(user)。 */
  private onClosePet(payload: { reason: 'user' }): void {
    if (payload.reason !== 'user') {
      this.logger.warn(`忽略未知 close_pet.reason=${String(payload.reason)}`);
      return;
    }
    this.requestShutdown('user');
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
    if (reason === 'user') {
      // 退出是同步回调，不能阻塞等锁；恢复标记用于区分真正的新恢复批次。
      const gatePath = getPetRecoveryGatePath(this.recoveryPath);
      const gate = acquireOwnedDaemonLock(gatePath, RECOVERY_GATE_LOCK_TTL_MS);
      const suppressionAlreadyPresent = isPetSuppressed(this.suppressionPath);
      const recoveryInFlight = isPetRecoveryPending(this.recoveryPath)
        || (!gate && suppressionAlreadyPresent);
      try {
        // 无恢复交接时，即使本实例最初由上一批恢复拉起，也要正常记录新的用户关闭。
        // 一旦下一批恢复已经建立，则当前这次 close_pet 必然是延迟到达的旧关闭；
        // 不得重写 suppression，也不得清掉新 SessionStart 的暂存。
        const delayedOldClose = recoveryInFlight;
        if (!delayedOldClose && !setPetSuppressed(this.suppressionPath)) {
          this.logger.warn(`无法写入用户关闭标记: ${this.suppressionPath}`);
        }
        if (!delayedOldClose && gate) {
          try {
            clearStagingDir(this.stagingDir, () => assertGateOwnership(gatePath, gate));
          } catch {
            this.logger.warn('清理关闭前暂存时恢复交接锁已被接管，停止清理以保护新事件');
          }
        } else if (!delayedOldClose) {
          // 普通 Bridge 投递也会短暂持有 gate。此时抑制标记已经补写，不能把拿不到锁
          // 误判成旧 close；暂存由下一次 SessionStart 按标记时间戳安全清理。
          this.logger.debug('关闭时恢复交接锁正忙，跳过即时暂存清理');
        }
      } finally {
        gate?.release();
      }
      // 不在旧 daemon 退出线程中无条件删除拉起锁：恢复 worker 会在确认旧事件管道
      // 已释放后清理。否则旧进程延迟执行到这里，可能误删新 daemon 刚取得的锁。
    }
    this.petState.flush();
    this.state.clearAllPending();
    if (this.countdownTimer) clearTimeout(this.countdownTimer);
    for (const t of this.throttleTimers.values()) clearTimeout(t);
    this.throttleTimers.clear();
    if (this.housekeepingTimer) clearInterval(this.housekeepingTimer);

    // 先停止任何渲染进程重启，再发送最后一条 shutdown；随后释放两条服务端管道，
    // 避免恢复期 SessionStart 写入正在退出的旧守护进程。
    const eventServer = this.eventServer;
    this.eventServer = null;
    const controlServer = this.controlServer;
    this.controlServer = null;
    const controlSession = this.controlSession;
    this.controlSession = null;
    this.renderer.shutdown();
    controlSession?.sendAndClose(createEnvelope('shutdown', { reason }, {}));
    void closeServer(eventServer);
    void closeServer(controlServer, false);

    // 宽限后强制结束渲染进程并退出（§2.3：渲染进程随守护进程退出）
    setTimeout(() => {
      this.renderer.forceKill();
      this.onExit(reason);
    }, this.exitGraceMs);
  }

  // -------------------------------------------------------------------------
  // 周期任务与错误计数
  // -------------------------------------------------------------------------

  private housekeeping(): void {
    if (this.exiting) return;
    // UE 落标记与 close_pet 送达之间也可能没有连接关闭或 renderer 退出事件；
    // 周期兜底保证 daemon 最迟一秒内停止重启并释放管道。
    if (isPetSuppressed(this.suppressionPath)) {
      this.requestShutdown('user');
      return;
    }
    // 心跳超时判死（§4.5-4：heartbeat 3s，heartbeat_timeout_ms 10s；任意合法消息都刷新存活时间）
    const cs = this.controlSession;
    if (cs && !cs.isClosed && this.config.heartbeat_timeout_ms > 0) {
      if (Date.now() - cs.lastRxAt > this.config.heartbeat_timeout_ms) {
        this.logger.warn(`渲染进程心跳超时（${this.config.heartbeat_timeout_ms}ms），按崩溃处理`);
        cs.close(); // close → onClosed → 渲染进程重启路径
      }
    }
    // 会话卡死兜底（§3.4）：超时会话强制转闲，状态切换消息下发
    const staleMessages = this.state.markStaleSessions();
    for (const msg of staleMessages) this.sendToRenderer(msg);
    if (staleMessages.some((msg) => msg.type === 'session_end') && this.state.activeSessions === 0) {
      this.startCountdown();
    }
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

/** daemon 启动可等待交接锁；持锁方崩溃时由 TTL 自动接管。 */
async function acquireRecoveryGate(lockPath: string): Promise<OwnedDaemonLock | null> {
  const deadline = Date.now() + 20_000;
  while (true) {
    const gate = acquireOwnedDaemonLock(lockPath, RECOVERY_GATE_LOCK_TTL_MS);
    if (gate) return gate;
    if (Date.now() >= deadline) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 启动回放必须等已登记的正常投递完成。无租约检查与持有 gate 是同一个原子判定：
 * 新投递只有取得同一把 gate 才能登记，因此不会在扫描暂存目录时再插入一个在途写入。
 */
async function acquireStartupGate(lockPath: string, recoveryPath: string): Promise<OwnedDaemonLock | null> {
  const deadline = Date.now() + 20_000;
  while (true) {
    const gate = acquireOwnedDaemonLock(lockPath, RECOVERY_GATE_LOCK_TTL_MS);
    if (gate) {
      if (!hasActiveDeliveryLeases(recoveryPath)) return gate;
      gate.release();
    }
    if (Date.now() >= deadline) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function assertGateOwnership(lockPath: string, gate: OwnedDaemonLock): void {
  if (!refreshDaemonLock(lockPath, gate.owner)) throw new Error('恢复交接锁所有权已丢失');
}

/** 关闭一个 net.Server（未监听/已关闭时安全返回）。 */
function closeServer(server: net.Server | null, forceConnections = true): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      // closeAllConnections 在较新的 @types/node 中才有类型定义，这里按可选能力调用
      if (forceConnections) {
        (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.(); // 强制断开残留连接（探测连接等）
      }
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}
