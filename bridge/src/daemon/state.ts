/**
 * 宠物状态机（docs/MVP设计.md §3.4 宿主事件 → 宠物语义映射表）。
 *
 * 纯逻辑模块，不碰管道/定时器/进程，时钟与时间窗由调用方注入 now，可完全单测。
 *
 * 规则：
 * - 按会话 id 维护活跃会话集合与任务表；任一会话忙 → Working，全部空闲 → Idle；
 * - 字段取值防御：除 hook_event_name/session_id/cwd 外不依赖任何宿主字段（§3.4）；
 *   任务标题取工具名/命令文本，取不到降级「正在工作…」；事件原始 JSON 由调用方整体透传 _raw；
 * - 状态卡死兜底：会话超过 session.staleMinutes 无事件 → 强制转闲（防丢失的 Stop 导致永远 Working）；
 * - 高频事件节流：PreToolUse/PostToolUse 在 200ms 窗口内合并同会话的连续任务事件再下发
 *   （同窗内 task_start+task_end 折叠为一条 task_end），避免渲染进程 UI 抖动。
 *
 * 行为补充约定（映射表未明说处的合理推导，见各方法注释）：
 * - Stop/StopFailure/Interrupt/卡死兜底转闲时静默清空该会话未完成任务（不发 task_end，避免误弹完成气泡；
 *   尤其 Interrupt 明确「不弹完成气泡」）；
 * - SessionEnd 移除会话并丢弃其节流缓冲中的任务消息；
 * - 会话记录是「按首见创建」的：守护进程中途启动、首个事件不是 SessionStart 时也能正确归属。
 */
import { randomUUID } from 'node:crypto';
import type {
  NotifyPayload,
  PetStateValue,
  SessionEndPayload,
  SessionStartPayload,
  SessionStatePayload,
  TaskEndPayload,
  TaskInfo,
  TaskStartPayload,
  TasksSnapshotPayload,
  TaskStatus,
} from '../protocol/types.js';

/** 高频任务事件合并窗口（毫秒），§3.4：200ms。 */
export const TASK_THROTTLE_MS = 200;

/** 任务标题降级文案（§3.4：取不到工具名/命令文本时）。 */
export const FALLBACK_TASK_TITLE = '正在工作…';

/** 会话记录。 */
export interface Session {
  sessionId: string;
  /** 宿主事件 cwd（§3.1 基础字段），可能缺失。 */
  cwd: string | null;
  /** 是否为恢复会话（SessionStart matcher=resume，§3.2）。 */
  resume: boolean;
  busy: boolean;
  /** 是否有尚未在会话面板中查看的新回复。 */
  unread: boolean;
  /** 最近一次事件时间（epoch ms），用于卡死兜底判定。 */
  lastEventAt: number;
  tasks: Map<string, TaskRecord>;
}

/** 未完成任务记录（§4.3 tasks_snapshot 数据源）。 */
export interface TaskRecord {
  taskId: string;
  title: string;
  tool: string;
  startedAt: string;
}

/** 守护进程下发给渲染进程的消息（尚未包信封，由调用方 createEnvelope）。 */
export type OutgoingMessage =
  | { type: 'session_start'; session_id: string; payload: SessionStartPayload }
  | { type: 'session_end'; session_id: string; payload: SessionEndPayload }
  | { type: 'session_state'; session_id: string; payload: SessionStatePayload }
  | { type: 'pet_state'; session_id: null; payload: { state: PetStateValue; reason: string } }
  | { type: 'task_start'; session_id: string; payload: TaskStartPayload }
  | { type: 'task_end'; session_id: string; payload: TaskEndPayload }
  | { type: 'tasks_snapshot'; session_id: null; payload: TasksSnapshotPayload }
  | { type: 'notify'; session_id: string | null; payload: NotifyPayload };

/** 单条宿主事件的处理结果。 */
export interface ProcessResult {
  ok: boolean;
  /** ok=false 的原因（非法 JSON/缺必要字段），由调用方计入错误计数（§4.4）。 */
  error?: string;
  /** 事件归属的会话 id（ok=true 时），调用方用它调度节流冲刷，不依赖信封字段。 */
  sessionId?: string;
  /** 需立即下发的消息（状态切换/会话事件/气泡）。 */
  out: OutgoingMessage[];
  /** 本次事件是否向某会话的节流缓冲追加了任务消息（调用方据此安排 200ms 冲刷定时器）。 */
  throttled: boolean;
  /** 最后一个 SessionEnd 且无活跃会话 → 调用方应启动退出倒计时（§4.5-6）。 */
  hostIdle: boolean;
}

/** 快照内容（§4.5-1/4 补发：活跃会话 + 当前 pet_state + 未完成任务列表）。 */
export interface SnapshotData {
  sessions: Array<{ sessionId: string; cwd: string | null; resume: boolean; busy: boolean; unread: boolean }>;
  state: PetStateValue;
  reason: string;
  tasks: TaskInfo[];
}

/** 节流缓冲中的单条任务消息（task_start/task_end，drain 时折叠同任务）。 */
interface PendingTaskMsg {
  kind: 'task_start' | 'task_end';
  taskId: string;
  title: string;
  tool: string;
  status?: TaskStatus;
  summary?: string | null;
}

export interface StateMachineOptions {
  /** 会话无事件强制转闲时长（毫秒），§3.4 卡死兜底。 */
  staleMs: number;
  /** 任务事件合并窗口（毫秒），缺省 200ms（§3.4）。 */
  throttleMs?: number;
  /** 任务 id 生成器，测试注入。 */
  genTaskId?: () => string;
  /** 时钟，测试注入。 */
  now?: () => number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** 取 PreToolUse 的命令文本（§3.1：tool_input.command）。 */
function extractCommand(parsed: Record<string, unknown>): string | null {
  const ti = parsed['tool_input'];
  if (!isObject(ti)) return null;
  return str(ti['command']);
}

/** 取工具名（tool_name / tool）。 */
function extractTool(parsed: Record<string, unknown>): string | null {
  return str(parsed['tool_name']) ?? str(parsed['tool']);
}

/** 取子代理名（subagent_name / name），§3.4：SubagentStart 视同 task_start，工具名=子代理名。 */
function extractSubagentName(parsed: Record<string, unknown>): string | null {
  return str(parsed['subagent_name']) ?? str(parsed['name']);
}

/** 取 PostToolUse 摘要（tool_output.summary / summary，均为可选字段，取不到返回 null）。 */
function extractSummary(parsed: Record<string, unknown>): string | null {
  const to = parsed['tool_output'];
  if (isObject(to)) {
    const s = str(to['summary']);
    if (s) return s;
  }
  return str(parsed['summary']);
}

export class PetStateMachine {
  private readonly sessions = new Map<string, Session>();
  /** 当前权威状态（§2.2 D3：守护进程是状态判定的唯一权威）。 */
  private currentState: PetStateValue = 'Idle';
  private stateReasonValue = 'boot';
  private readonly staleMs: number;
  private readonly throttleMs: number;
  private readonly genTaskId: () => string;
  private readonly now: () => number;
  /** 节流缓冲：sessionId → {firstAt, msgs[]}。 */
  private readonly pending = new Map<string, { firstAt: number; msgs: PendingTaskMsg[] }>();

  constructor(opts: StateMachineOptions) {
    this.staleMs = opts.staleMs;
    this.throttleMs = opts.throttleMs ?? TASK_THROTTLE_MS;
    this.genTaskId = opts.genTaskId ?? (() => randomUUID());
    this.now = opts.now ?? Date.now;
  }

  get state(): PetStateValue {
    return this.currentState;
  }

  /** 任务事件合并窗口（毫秒），调用方用它安排冲刷定时器。 */
  get throttleWindowMs(): number {
    return this.throttleMs;
  }

  get stateReason(): string {
    return this.stateReasonValue;
  }

  /** 活跃会话数。 */
  get activeSessions(): number {
    return this.sessions.size;
  }

  hasBusySessions(): boolean {
    for (const s of this.sessions.values()) {
      if (s.busy) return true;
    }
    return false;
  }

  /** 最近活跃会话（open_tui 会话 id 为空时用它恢复最近会话，§4.5-3）。 */
  mostRecentSession(): Session | null {
    let best: Session | null = null;
    for (const s of this.sessions.values()) {
      if (!best || s.lastEventAt > best.lastEventAt) best = s;
    }
    return best;
  }

  getSessionCwd(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.cwd ?? null;
  }

  /** 快照（§4.5-1/4 补发内容）。tasks 跨会话汇总，保持各会话内开始时间序。 */
  getSnapshot(): SnapshotData {
    const tasks: TaskInfo[] = [];
    for (const s of this.sessions.values()) {
      for (const t of s.tasks.values()) {
        tasks.push({ task_id: t.taskId, title: t.title, tool: t.tool, started_at: t.startedAt });
      }
    }
    return {
      sessions: [...this.sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
        resume: s.resume,
        busy: s.busy,
        unread: s.unread,
      })),
      state: this.currentState,
      reason: this.stateReason,
      tasks,
    };
  }

  /**
   * 处理一条宿主事件原始 JSON（§3.4 映射表）。
   * 非法 JSON / 非对象 / 缺 hook_event_name / 缺 session_id → {ok:false}，由调用方错误计数（§4.4）。
   * 未知 hook_event_name → 忽略（{ok:true}，向前兼容 §4.2）。
   */
  processHostEvent(raw: string): ProcessResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: '宿主事件非法 JSON', out: [], throttled: false, hostIdle: false };
    }
    if (!isObject(parsed)) {
      return { ok: false, error: '宿主事件必须是 JSON 对象', out: [], throttled: false, hostIdle: false };
    }
    const hook = str(parsed['hook_event_name']);
    if (!hook) {
      return { ok: false, error: '宿主事件缺少 hook_event_name', out: [], throttled: false, hostIdle: false };
    }
    const sessionId = str(parsed['session_id']);
    if (!sessionId) {
      return { ok: false, error: '宿主事件缺少 session_id', out: [], throttled: false, hostIdle: false };
    }

    const now = this.now();
    const out: OutgoingMessage[] = [];
    let throttled = false;
    let hostIdle = false;

    const session = this.ensureSession(sessionId, parsed, now);

    switch (hook) {
      case 'SessionStart':
        // 记录活跃会话；同 id 重开则重置（清空旧任务与节流缓冲）；忙标志复位后重判主状态
        session.busy = false;
        session.unread = false;
        session.resume = extractResume(parsed);
        this.clearSessionTasks(session);
        this.recomputeIdle(out, 'session_start');
        out.push({ type: 'session_start', session_id: sessionId, payload: { cwd: session.cwd ?? '', resume: session.resume } });
        out.push(this.makeSessionState(session));
        break;

      case 'UserPromptSubmit':
        // 该会话标记为忙 → Working（比等 PreToolUse 更早，§3.4）
        session.busy = true;
        session.unread = false;
        this.setWorking(out, 'user_prompt');
        out.push(this.makeSessionState(session));
        break;

      case 'PreToolUse':
      case 'SubagentStart': {
        session.busy = true;
        this.setWorking(out, 'tool_use');
        out.push(this.makeSessionState(session));
        const task = this.addTask(session, parsed);
        this.queuePending(sessionId, {
          kind: 'task_start',
          taskId: task.taskId,
          title: task.title,
          tool: task.tool,
        });
        throttled = true;
        break;
      }

      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'SubagentStop': {
        const ended = this.endTask(session, parsed);
        if (ended) {
          const status: TaskStatus = hook === 'PostToolUseFailure' ? 'failure' : 'success';
          this.queuePending(sessionId, {
            kind: 'task_end',
            taskId: ended.taskId,
            title: ended.title,
            tool: ended.tool,
            status,
            summary: extractSummary(parsed),
          });
          throttled = true;
          if (status === 'failure') {
            // 失败另发 notify（§3.4 表格）；成功不发，避免与 task_end 完成气泡重复
            out.push({
              type: 'notify',
              session_id: sessionId,
              payload: { text: `任务失败：${ended.title}`, level: 'error', task_id: ended.taskId },
            });
          }
        }
        break;
      }

      case 'Stop':
        // 该会话转闲；任务静默清空（不发 task_end：Stop 表示本轮工作已收尾，不弹完成气泡）
        this.idleSession(session);
        session.unread = true;
        this.recomputeIdle(out, 'stop');
        out.push(this.makeSessionState(session));
        break;

      case 'StopFailure':
        this.idleSession(session);
        session.unread = true;
        this.recomputeIdle(out, 'stop_failure');
        out.push(this.makeSessionState(session));
        out.push({ type: 'notify', session_id: sessionId, payload: { text: '任务出错', level: 'error' } });
        break;

      case 'Interrupt':
        // 该会话转闲，不弹完成气泡（§3.4）
        this.idleSession(session);
        this.recomputeIdle(out, 'interrupt');
        // Interrupt 不改变 unread：它表示中断，而不是新的 Agent 回复。
        out.push(this.makeSessionState(session));
        break;

      case 'Notification':
        // task.completed 等完成通知：成功气泡，不改主状态（§3.4）
        out.push({
          type: 'notify',
          session_id: sessionId,
          payload: { text: extractNotificationText(parsed) ?? '后台任务完成', level: 'success' },
        });
        break;

      case 'SessionEnd': {
        out.push({
          type: 'session_end',
          session_id: sessionId,
          payload: { reason: str(parsed['reason']) ?? 'exit' },
        });
        this.sessions.delete(sessionId);
        this.pending.delete(sessionId); // 丢弃已死会话的节流缓冲
        if (this.sessions.size === 0) {
          // 无活跃会话 → Idle 并启动退出倒计时（§3.4 / §4.5-6）
          this.setIdle(out, 'session_end');
          hostIdle = true;
        }
        break;
      }

      default:
        // 未知事件类型：忽略并保持状态（§4.2 向前兼容），调用方 debug 日志
        break;
    }

    return { ok: true, sessionId, out, throttled, hostIdle };
  }

  /**
   * 卡死兜底（§3.4）：扫描所有会话，超过 staleMs 无事件的忙会话强制转闲，并把该会话整体回收删除
   * （10 分钟无任何事件 = 会话已死亡，含「暂存重放的孤儿会话」——其 SessionEnd 可能已随守护进程
   * 不在场期间丢失；不回收会让退出倒计时永远等不到「无活跃会话」）。
   * 返回因此产生的消息（pet_state 切换）。注意：不触发退出倒计时 —— 宿主可能只是长时间空闲。
   */
  markStaleSessions(): OutgoingMessage[] {
    const out: OutgoingMessage[] = [];
    const now = this.now();
    const stale: string[] = [];
    for (const [sid, s] of this.sessions) {
      if (now - s.lastEventAt > this.staleMs) {
        if (s.busy) {
          this.idleSession(s);
          this.recomputeIdle(out, 'stale');
        }
        // 渲染进程必须收到结束事件，否则面板会残留已经被守护进程回收的会话行。
        out.push({ type: 'session_end', session_id: sid, payload: { reason: 'stale' } });
        stale.push(sid);
      }
    }
    for (const sid of stale) this.sessions.delete(sid);
    return out;
  }

  /**
   * 冲刷某会话的节流缓冲（§3.4 200ms 窗口合并）。
   * force=true 由调用方定时器触发（窗口已到）；否则仅当窗口已过才冲刷（测试/兜底路径）。
   * 同窗内同任务 start+end 折叠为一条 task_end；返回待下发消息，缓冲清空。
   */
  drainThrottled(sessionId: string, force = true): OutgoingMessage[] {
    const bucket = this.pending.get(sessionId);
    if (!bucket) return [];
    if (!force && this.now() - bucket.firstAt < this.throttleMs) return [];
    this.pending.delete(sessionId);

    // 折叠：taskId → 合并条目（start+end 同窗 → 只留 end）
    const merged = new Map<string, { kind: 'task_end' | 'task_start'; idx: number; msg: PendingTaskMsg }>();
    bucket.msgs.forEach((msg, idx) => {
      if (msg.kind === 'task_end') {
        merged.set(msg.taskId, { kind: 'task_end', idx, msg });
      } else if (!merged.has(msg.taskId)) {
        merged.set(msg.taskId, { kind: 'task_start', idx, msg });
      }
    });
    const items = [...merged.values()].sort((a, b) => a.idx - b.idx);
    return items.map(({ msg }) =>
      msg.kind === 'task_start'
        ? {
            type: 'task_start' as const,
            session_id: sessionId,
            payload: { task_id: msg.taskId, title: msg.title, tool: msg.tool },
          }
        : {
            type: 'task_end' as const,
            session_id: sessionId,
            payload: {
              task_id: msg.taskId,
              status: msg.status ?? 'success',
              title: msg.title,
              summary: msg.summary ?? null,
            },
          },
    );
  }

  hasPendingThrottle(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  /**
   * 打开指定会话后标记为已读，并返回应下发给渲染进程的状态更新。
   * 会话不存在时返回 null（例如会话已结束或已被 stale 回收）。
   */
  markSessionRead(sessionId: string): OutgoingMessage | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (!session.unread) return null;
    session.unread = false;
    return this.makeSessionState(session);
  }

  /** 所有会话的待冲刷缓冲都丢弃（调用方退出/清场时）。 */
  clearAllPending(): void {
    this.pending.clear();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 会话按首见创建（中途启动也能正确归属）；已有会话只补充缺失的 cwd，不覆盖已记录值（cwd 以首见/SessionStart 为准）。 */
  private ensureSession(sessionId: string, parsed: Record<string, unknown>, now: number): Session {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId,
        cwd: str(parsed['cwd']),
        resume: extractResume(parsed),
        busy: false,
        unread: false,
        lastEventAt: now,
        tasks: new Map(),
      };
      this.sessions.set(sessionId, s);
      return s;
    }
    if (s.cwd === null) {
      const cwd = str(parsed['cwd']);
      if (cwd) s.cwd = cwd;
    }
    s.lastEventAt = now;
    return s;
  }

  /** 新增任务（§3.4 PreToolUse/SubagentStart：任务标题取命令文本/工具名，取不到降级通用文案）。 */
  private addTask(session: Session, parsed: Record<string, unknown>): TaskRecord {
    const tool = str(parsed['subagent_name']) ?? str(parsed['name']) ?? extractTool(parsed) ?? 'tool';
    const command = extractCommand(parsed);
    const title = command ?? (tool !== 'tool' ? tool : null) ?? FALLBACK_TASK_TITLE;
    const task: TaskRecord = {
      taskId: this.genTaskId(),
      title,
      tool,
      startedAt: new Date().toISOString(),
    };
    session.tasks.set(task.taskId, task);
    return task;
  }

  /**
   * 结束任务（PostToolUse/SubagentStop）：宿主事件没有任务 id，按「同会话同工具名/子代理名的最近任务」匹配，
   * 匹配不到再退而取该会话最近开始的任务；仍无则忽略（该任务不是本守护进程可见范围内启动的）。
   */
  private endTask(session: Session, parsed: Record<string, unknown>): TaskRecord | null {
    const tool = extractTool(parsed) ?? str(parsed['subagent_name']) ?? str(parsed['name']);
    let best: TaskRecord | null = null;
    for (const t of session.tasks.values()) {
      if (tool && t.tool === tool) {
        if (!best || t.startedAt > best.startedAt) best = t;
      }
    }
    if (!best) {
      for (const t of session.tasks.values()) {
        if (!best || t.startedAt > best.startedAt) best = t;
      }
    }
    if (!best) return null;
    session.tasks.delete(best.taskId);
    return best;
  }

  /** 会话转闲并静默清空未完成任务（不发 task_end，不弹完成气泡；§3.4 Interrupt 语义推广到全部转闲路径）。 */
  private idleSession(session: Session): void {
    session.busy = false;
    this.clearSessionTasks(session);
  }

  private clearSessionTasks(session: Session): void {
    session.tasks.clear();
    this.pending.delete(session.sessionId); // 会话清了，缓冲中的任务消息一并丢弃
  }

  /** 置为 Working（仅状态实际变化时下发 pet_state，避免重复指令）。 */
  private setWorking(out: OutgoingMessage[], reason: string): void {
    if (this.currentState === 'Working') return;
    this.currentState = 'Working';
    this.stateReasonValue = reason;
    out.push({ type: 'pet_state', session_id: null, payload: { state: 'Working', reason } });
  }

  private setIdle(out: OutgoingMessage[], reason: string): void {
    if (this.currentState === 'Idle') return;
    this.currentState = 'Idle';
    this.stateReasonValue = reason;
    out.push({ type: 'pet_state', session_id: null, payload: { state: 'Idle', reason } });
  }

  /** 会话转闲后重新判定主状态（§3.4：任一会话忙 → Working；全闲 → Idle）。 */
  private recomputeIdle(out: OutgoingMessage[], reason: string): void {
    if (!this.hasBusySessions()) this.setIdle(out, reason);
  }

  private queuePending(sessionId: string, msg: PendingTaskMsg): void {
    let bucket = this.pending.get(sessionId);
    if (!bucket) {
      bucket = { firstAt: this.now(), msgs: [] };
      this.pending.set(sessionId, bucket);
    }
    bucket.msgs.push(msg);
  }

  private makeSessionState(session: Session): { type: 'session_state'; session_id: string; payload: SessionStatePayload } {
    return {
      type: 'session_state',
      session_id: session.sessionId,
      payload: { working: session.busy, unread: session.unread },
    };
  }
}

/** 恢复会话判定：matcher=resume（§3.2）或显式 resume 字段。 */
function extractResume(parsed: Record<string, unknown>): boolean {
  if (parsed['resume'] === true) return true;
  const matcher = parsed['matcher'];
  return typeof matcher === 'string' && matcher.includes('resume');
}

/** Notification 文案取值（字段全集未公开，§3.1 待验证；仅尝试常见字段，取不到降级通用文案）。 */
function extractNotificationText(parsed: Record<string, unknown>): string | null {
  const n = parsed['notification'];
  if (isObject(n)) {
    for (const k of ['text', 'message', 'title']) {
      const v = str(n[k]);
      if (v) return v;
    }
  }
  for (const k of ['text', 'message']) {
    const v = str(parsed[k]);
    if (v) return v;
  }
  return null;
}
