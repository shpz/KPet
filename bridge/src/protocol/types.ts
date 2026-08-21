/**
 * KPet 进程间通信协议 —— 消息类型与 payload 定义。
 * 严格对应 docs/MVP设计.md §4.3「协议消息表」。
 *
 * 方向缩写：转→守 = 转发器→守护进程（事件管道）；守→渲 / 渲→守 = 守护进程↔渲染进程（控制管道）。
 */

/** 信封协议主版本，MVP 固定为 1（§4.2）。 */
export const PROTOCOL_VERSION = 1 as const;

/** 消息类型全集（§4.3，按表内顺序）。 */
export const MESSAGE_TYPES = [
  'host_event', // 转→守 | 每次事件钩子触发 | 唯一入站类型，守护进程内部解析映射
  'hello', // 双向 | 连接建立后首条 | 握手与版本协商
  'session_start', // 守→渲 | SessionStart
  'session_end', // 守→渲 | SessionEnd
  'session_state', // 守→渲 | 单个会话的工作/未读状态
  'pet_state', // 守→渲 | 守护进程状态推导 | 状态切换的唯一权威消息
  'task_start', // 守→渲 | PreToolUse / SubagentStart | 悬浮卡列表项
  'task_end', // 守→渲 | PostToolUse(Failure) / SubagentStop | 触发完成气泡
  'tasks_snapshot', // 守→渲 | 连接建立 / 渲染进程重启后 | 全量状态恢复
  'sessions_snapshot', // 守→渲 | 连接建立 / 渲染进程重启后 | CLI 历史与活跃会话目录
  'config_snapshot', // 守→渲 | 连接建立 / 配置更新后 | 全量配置快照（设置 WebUI 初始化）
  'notify', // 守→渲 | 任务完成/失败、Notification | 消息气泡
  'open_tui', // 渲→守 | 点击宠物 / 点击气泡 | 请求打开终端
  'heartbeat', // 渲→守 | 每 3 秒 | 保活心跳
  'pet_moved', // 渲→守 | 拖拽结束 | 位置持久化
  'close_pet', // 渲→守 | 用户请求关闭宠物；payload.reason=user
  'update_config', // 渲→守 | 设置 WebUI 保存 | 请求更新守护进程配置
  'shutdown', // 守→渲 | 守护进程退出前 | 通知渲染进程退出
  'protocol_error', // 双向 | 收到非法消息 | 仅日志用途
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

/** 判断字符串是否为协议已知的消息类型（§4.2：收到未知类型必须忽略并记日志）。 */
export function isKnownType(type: string): type is MessageType {
  return (MESSAGE_TYPES as readonly string[]).includes(type);
}

// ---------------------------------------------------------------------------
// 各消息 payload（字段与 §4.3 表一一对应）
// ---------------------------------------------------------------------------

/** host_event：宿主原始 JSON 文本整体透传（§3.4 字段取值防御策略，不解析不重排）。 */
export interface HostEventPayload {
  _raw: string;
}

/** hello.role：控制管道两端。转发器不发 hello。 */
export type Role = 'daemon' | 'renderer';

export interface HelloPayload {
  protocol_version: number;
  role: Role;
  pid: number;
  version: string;
  capabilities: string[];
}

export interface SessionStartPayload {
  cwd: string;
  resume: boolean;
}

export interface SessionEndPayload {
  reason: string;
}

/** 单个会话的展示状态（通过信封 session_id 关联会话）。 */
export interface SessionStatePayload {
  working: boolean;
  unread: boolean;
}

export type PetStateValue = 'Idle' | 'Working';

export interface PetStatePayload {
  state: PetStateValue;
  reason: string;
}

export interface TaskStartPayload {
  task_id: string;
  title: string;
  tool: string;
}

export type TaskStatus = 'success' | 'failure';

export interface TaskEndPayload {
  task_id: string;
  status: TaskStatus;
  /** 取不到标题时由守护进程降级为通用文案（§3.4）。 */
  title: string;
  summary?: string | null;
}

/** tasks_snapshot 中的单条任务（§4.3）。 */
export interface TaskInfo {
  task_id: string;
  title: string;
  tool: string;
  started_at: string;
}

export interface TasksSnapshotPayload {
  tasks: TaskInfo[];
}

/** sessions_snapshot 中的单条 CLI 会话展示项。 */
export interface SessionSnapshotItem {
  session_id: string;
  title: string;
  cwd: string;
  active: boolean;
  working: boolean;
  unread: boolean;
  /** CLI state.json 的 updatedAt，统一为 Int64 毫秒时间戳；未落盘的活跃会话为 0。 */
  updated_at: number;
}

export interface SessionsSnapshotPayload {
  sessions: SessionSnapshotItem[];
}

/** config_snapshot：守护进程全量有效配置，供设置 WebUI 初始化 / 更新后刷新。 */
export interface ConfigSnapshotPayload {
  open_target: OpenTarget;
  ui_theme: UiThemeName;
  fps_monitor: boolean;
  open_web_url: string;
}

export type NotifyLevel = 'info' | 'success' | 'error';

export interface NotifyPayload {
  text: string;
  level: NotifyLevel;
  /** 气泡停留时长（毫秒），缺省 5000（§6.6 bubble.durationMs）。 */
  ttl_ms?: number;
  task_id?: string | null;
}

export type OpenTuiSource = 'pet' | 'bubble';

export interface OpenTuiPayload {
  /** 目标会话，null/缺省 = 最近会话（§4.5-3）。 */
  session_id?: string | null;
  source: OpenTuiSource;
  task_id?: string | null;
}

export interface HeartbeatPayload {
  pid: number;
  uptime_s: number;
  /** 渲染进程只上报 Idle/Working（§6.7）。 */
  state: PetStateValue;
}

export interface PetMovedPayload {
  x: number;
  y: number;
  monitor_id: string;
}

/** 渲染进程请求关闭宠物；关闭后由下一次 SessionStart 恢复。 */
export interface ClosePetPayload {
  reason: 'user';
}

/** update_config 可更新的配置值。 */
export type OpenTarget = 'cli' | 'web';
/** 设置 WebUI 主题（ui_theme）：dark-glass / light-minimal / cute-pet。 */
export type UiThemeName = 'dark-glass' | 'light-minimal' | 'cute-pet';

/**
 * update_config：设置 WebUI 保存时由渲染进程下发的部分配置。
 * 字段可缺省，至少要有一个合法字段，否则守护进程回 protocol_error。
 */
export interface UpdateConfigPayload {
  open_target?: OpenTarget;
  ui_theme?: UiThemeName;
  fps_monitor?: boolean;
}

export type ShutdownReason = 'host_gone' | 'user' | 'error';

export interface ShutdownPayload {
  reason: ShutdownReason;
}

export interface ProtocolErrorPayload {
  description: string;
  /** 非法消息原文摘录，截断 256 字符（§4.3）。 */
  raw_excerpt: string;
}

/** type → payload 类型映射表，供类型安全构造/校验。 */
export interface PayloadMap {
  host_event: HostEventPayload;
  hello: HelloPayload;
  session_start: SessionStartPayload;
  session_end: SessionEndPayload;
  session_state: SessionStatePayload;
  pet_state: PetStatePayload;
  task_start: TaskStartPayload;
  task_end: TaskEndPayload;
  tasks_snapshot: TasksSnapshotPayload;
  sessions_snapshot: SessionsSnapshotPayload;
  config_snapshot: ConfigSnapshotPayload;
  notify: NotifyPayload;
  open_tui: OpenTuiPayload;
  heartbeat: HeartbeatPayload;
  pet_moved: PetMovedPayload;
  close_pet: ClosePetPayload;
  update_config: UpdateConfigPayload;
  shutdown: ShutdownPayload;
  protocol_error: ProtocolErrorPayload;
}

/** 单条管道消息上限 64KB（§4.1 消息模式单条上限 / §4.2）。 */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/** protocol_error.raw_excerpt 的最大字符数（§4.3：截断 256 字符）。 */
export const MAX_RAW_EXCERPT_CHARS = 256;

/** 截断任意字符串到指定字符数（UTF-16 码元计），供 raw_excerpt 使用。 */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
