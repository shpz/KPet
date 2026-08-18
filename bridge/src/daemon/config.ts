/**
 * 守护进程配置（docs/MVP设计.md §7）。
 *
 * 读取 %KIMI_CODE_HOME%\kimipet\config.json（KIMI_CODE_HOME 未设时回退 ~/.kimi-code）；
 * 文件不存在或字段缺失/类型非法时逐项回退默认值并给出告警（§4.4 字段级只增不改的配置侧同义）。
 *
 * 注意 §7 表格把 `session.staleMinutes` 写作带点键，读取时兼容「扁平带点键」与「嵌套对象」两种写法。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LogLevel } from './logger.js';

/** 守护进程自身版本（hello.version / 日志），与 bridge 工程版本保持一致。 */
export const DAEMON_VERSION = '0.1.0';

/** 点击会话后的打开目标（§7 open_target）：cli=唤起 kimi 终端，web=打开浏览器。 */
export type OpenTarget = 'cli' | 'web';

/**
 * web 打开目标的默认 URL 模板（§7 open_web_url）。
 * 直接按会话恢复的 URL 格式未经官方文档验证，这里默认指向本地 kimi web 首页（`kimi web` 默认端口）。
 */
export const DEFAULT_OPEN_WEB_URL = 'http://127.0.0.1:58627/';

export interface DaemonConfig {
  /** 渲染进程路径（§7，缺省 %KIMI_PLUGIN_ROOT%\renderer\Pet.exe）。 */
  renderer_path: string;
  /** 心跳间隔（毫秒），渲染进程每 heartbeat_interval_ms 发一次 heartbeat。 */
  heartbeat_interval_ms: number;
  /** 心跳超时（毫秒），超过视为渲染进程失联（§4.5-4）；0 = 不检测。 */
  heartbeat_timeout_ms: number;
  /** 渲染进程崩溃重启：窗口内最大重启次数。 */
  restart_max_attempts: number;
  /** 重启计数窗口（秒）。 */
  restart_window_s: number;
  /** 宿主全部退出后的退出倒计时（秒，§4.5-6）。 */
  host_grace_seconds: number;
  /** 倒计时结束是否自动退出（false 时守护进程常驻，等下一个宿主事件）。 */
  auto_quit_with_host: boolean;
  /** 终端唤起方式：wt（Windows 终端）或 cmd（传统控制台，§4.5-3）。 */
  terminal: 'wt' | 'cmd';
  /** 点击会话后的打开目标：cli（唤起 kimi 终端）或 web（打开浏览器，§7）。 */
  open_target: OpenTarget;
  /** web 目标下的 URL 模板（§7 open_web_url），支持 {session_id} 占位符；会话 id 为空时替换为空串。 */
  open_web_url: string;
  session: {
    /** 会话无事件强制转闲的时长（分钟，§3.4 状态卡死兜底）。 */
    staleMinutes: number;
    /** 会话长期无事件才清理的时长（分钟）；应明显大于 staleMinutes。 */
    cleanupMinutes: number;
  };
  log_level: LogLevel;
}

/** KIMI_CODE_HOME 未设时回退的用户配置目录名（§3.1：Windows 默认 C:\Users\<用户名>\.kimi-code）。 */
const KIMI_CODE_DIR = '.kimi-code';

/** 展开字符串中的 %VAR% 环境变量引用（§7 默认 renderer_path 含 %KIMI_PLUGIN_ROOT%）。未定义的变量替换为空串。 */
export function expandEnvVars(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  return raw.replace(/%([^%]+)%/g, (_, name: string) => env[name] ?? '');
}

/** 守护进程配置目录：%KIMI_CODE_HOME%\kimipet（KIMI_CODE_HOME 未设回退 ~/.kimi-code）。 */
export function getKimipetHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.KIMI_CODE_HOME;
  if (home && home.length > 0) return path.join(home, 'kimipet');
  return path.join(os.homedir(), KIMI_CODE_DIR, 'kimipet');
}

/** 配置文件路径：%KIMI_CODE_HOME%\kimipet\config.json。 */
export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getKimipetHome(env), 'config.json');
}

/** 日志目录：%KIMI_CODE_HOME%\kimipet\logs。 */
export function getLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getKimipetHome(env), 'logs');
}

/** 日志文件路径：%KIMI_CODE_HOME%\kimipet\logs\kimi-petd.log。 */
export function getLogFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getLogDir(env), 'kimi-petd.log');
}

/** 解析渲染进程路径：显式配置 > %KIMI_PLUGIN_ROOT%\renderer\Pet.exe > cwd()/renderer/Pet.exe（开发兜底）。 */
export function resolveRendererPath(raw: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (raw) {
    const expanded = expandEnvVars(raw, env);
    if (expanded.length > 0) return expanded;
  }
  const root = env.KIMI_PLUGIN_ROOT;
  if (root && root.length > 0) return path.join(root, 'renderer', 'Pet.exe');
  return path.join(process.cwd(), 'renderer', 'Pet.exe');
}

/** 配置加载结果：config 为最终生效值；warnings 为逐项回退告警（由调用方记日志）。 */
export interface ConfigResult {
  config: DaemonConfig;
  warnings: string[];
  /** 配置来源：'default'（文件缺失/非法）或 'file'。 */
  source: 'default' | 'file';
}

/** 从原始 JSON 对象读取一个正数数值（含类型校验），非法返回 fallback 并记告警。 */
function readPositiveNumber(obj: Record<string, unknown>, key: string, fallback: number, warnings: string[]): number {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  warnings.push(`配置项 ${key} 非法（需要正数），使用默认值 ${fallback}`);
  return fallback;
}

/** 读取允许为 0 的数值（heartbeat_timeout_ms：0 = 不检测心跳）。 */
function readNonNegativeNumber(obj: Record<string, unknown>, key: string, fallback: number, warnings: string[]): number {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  warnings.push(`配置项 ${key} 非法（需要非负数），使用默认值 ${fallback}`);
  return fallback;
}

/** 读取布尔值。 */
function readBoolean(obj: Record<string, unknown>, key: string, fallback: boolean, warnings: string[]): boolean {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  warnings.push(`配置项 ${key} 非法（需要布尔值），使用默认值 ${fallback}`);
  return fallback;
}

/** 读取终端方式（§7 terminal）。 */
function readTerminal(obj: Record<string, unknown>, warnings: string[]): 'wt' | 'cmd' {
  const v = obj['terminal'];
  if (v === 'wt' || v === 'cmd') return v;
  if (v !== undefined) warnings.push('配置项 terminal 非法（需要 "wt" 或 "cmd"），使用默认值 "wt"');
  return 'wt';
}

/** 读取打开目标（§7 open_target）。 */
function readOpenTarget(obj: Record<string, unknown>, warnings: string[]): OpenTarget {
  const v = obj['open_target'];
  if (v === 'cli' || v === 'web') return v;
  if (v !== undefined) warnings.push('配置项 open_target 非法（需要 "cli" 或 "web"），使用默认值 "cli"');
  return 'cli';
}

/** 读取 web 目标下的 URL 模板（§7 open_web_url）。 */
function readOpenWebUrl(obj: Record<string, unknown>, warnings: string[]): string {
  const v = obj['open_web_url'];
  if (v === undefined) return DEFAULT_OPEN_WEB_URL;
  if (typeof v === 'string' && v.length > 0) return v;
  warnings.push(`配置项 open_web_url 非法（需要非空字符串），使用默认值 ${DEFAULT_OPEN_WEB_URL}`);
  return DEFAULT_OPEN_WEB_URL;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** 读取日志级别（§7 log_level）。 */
function readLogLevel(obj: Record<string, unknown>, warnings: string[]): LogLevel {
  const v = obj['log_level'];
  if (typeof v === 'string' && (LOG_LEVELS as readonly string[]).includes(v)) return v as LogLevel;
  if (v !== undefined) warnings.push('配置项 log_level 非法，使用默认值 "info"');
  return 'info';
}

/** §7 全部键 + 默认值。renderer_path 的默认值依赖环境（%KIMI_PLUGIN_ROOT%）。 */
export function defaultConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  return {
    renderer_path: resolveRendererPath(undefined, env),
    heartbeat_interval_ms: 3000,
    heartbeat_timeout_ms: 10_000,
    restart_max_attempts: 5,
    restart_window_s: 60,
    host_grace_seconds: 120,
    auto_quit_with_host: true,
    terminal: 'wt',
    open_target: 'cli',
    open_web_url: DEFAULT_OPEN_WEB_URL,
    session: { staleMinutes: 10, cleanupMinutes: 60 },
    log_level: 'info',
  };
}

/**
 * 加载守护进程配置（§7）。
 * - 文件不存在/JSON 非法 → 整体使用默认值（warnings 说明原因）；
 * - 字段缺失/类型非法 → 逐项回退默认值；
 * - session.staleMinutes/session.cleanupMinutes 兼容「扁平带点键」与「嵌套 session 对象」两种写法。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, filePath: string = getConfigPath(env)): ConfigResult {
  const warnings: string[] = [];
  const defaults = defaultConfig(env);

  let raw: unknown;
  let source: 'default' | 'file' = 'default';
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    source = 'file';
  } catch {
    warnings.push(`配置文件不可用（${filePath}），使用默认配置`);
    return { config: defaults, warnings, source };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnings.push(`配置文件顶层必须是 JSON 对象（${filePath}），使用默认配置`);
    return { config: defaults, warnings, source };
  }
  const obj = raw as Record<string, unknown>;

  // session.staleMinutes/session.cleanupMinutes：先读扁平带点键，再读嵌套对象
  const flatStale = obj['session.staleMinutes'];
  const nestedSession = typeof obj['session'] === 'object' && obj['session'] !== null && !Array.isArray(obj['session'])
    ? (obj['session'] as Record<string, unknown>)
    : undefined;
  const staleRaw = flatStale ?? nestedSession?.['staleMinutes'];
  let staleMinutes = defaults.session.staleMinutes;
  if (typeof staleRaw === 'number' && Number.isFinite(staleRaw) && staleRaw > 0) {
    staleMinutes = staleRaw;
  } else if (staleRaw !== undefined) {
    warnings.push(`配置项 session.staleMinutes 非法（需要正数），使用默认值 ${defaults.session.staleMinutes}`);
  }

  const flatCleanup = obj['session.cleanupMinutes'];
  const cleanupRaw = flatCleanup ?? nestedSession?.['cleanupMinutes'];
  // 未配置时保持文档默认值 60；只有默认值不大于 staleMinutes 时，才提升到
  // staleMinutes 之后的最小整分钟间隔，确保清理一定晚于卡死转闲。
  const fallbackCleanupMinutes = Math.max(defaults.session.cleanupMinutes, staleMinutes + 1);
  let cleanupMinutes = fallbackCleanupMinutes;
  if (typeof cleanupRaw === 'number' && Number.isFinite(cleanupRaw) && cleanupRaw > staleMinutes) {
    cleanupMinutes = cleanupRaw;
  } else if (cleanupRaw !== undefined) {
    warnings.push(
      `配置项 session.cleanupMinutes 非法（需要大于 staleMinutes 的正数），使用默认值 ${cleanupMinutes}`,
    );
  }

  const rendererPathRaw = obj['renderer_path'];
  let rendererPath: string;
  if (rendererPathRaw === undefined || typeof rendererPathRaw === 'string') {
    rendererPath = resolveRendererPath(rendererPathRaw as string | undefined, env);
  } else {
    warnings.push('配置项 renderer_path 非法（需要字符串），使用默认渲染进程路径');
    rendererPath = resolveRendererPath(undefined, env);
  }

  const config: DaemonConfig = {
    renderer_path: rendererPath,
    heartbeat_interval_ms: readPositiveNumber(obj, 'heartbeat_interval_ms', defaults.heartbeat_interval_ms, warnings),
    heartbeat_timeout_ms: readNonNegativeNumber(obj, 'heartbeat_timeout_ms', defaults.heartbeat_timeout_ms, warnings),
    restart_max_attempts: readPositiveNumber(obj, 'restart_max_attempts', defaults.restart_max_attempts, warnings),
    restart_window_s: readPositiveNumber(obj, 'restart_window_s', defaults.restart_window_s, warnings),
    host_grace_seconds: readPositiveNumber(obj, 'host_grace_seconds', defaults.host_grace_seconds, warnings),
    auto_quit_with_host: readBoolean(obj, 'auto_quit_with_host', defaults.auto_quit_with_host, warnings),
    terminal: readTerminal(obj, warnings),
    open_target: readOpenTarget(obj, warnings),
    open_web_url: readOpenWebUrl(obj, warnings),
    session: { staleMinutes, cleanupMinutes },
    log_level: readLogLevel(obj, warnings),
  };
  return { config, warnings, source };
}
