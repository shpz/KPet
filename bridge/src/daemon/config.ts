/**
 * 守护进程配置。
 *
 * 读取 KIMI_CODE_HOME/kpet/config.json（KIMI_CODE_HOME 未设时回退 ~/.kimi-code）；
 * 文件不存在或字段缺失/类型非法时逐项回退默认值并给出告警（字段级只增不改的配置侧同义）。
 *
 * 注意：配置表把 `session.staleMinutes` 写作带点键，读取时兼容「扁平带点键」与「嵌套对象」两种写法。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LogLevel } from './logger.js';
import type { UiThemeName, UpdateConfigPayload } from '../protocol/types.js';

/** 守护进程自身版本（hello.version / 日志），与 bridge 工程版本保持一致。 */
export const DAEMON_VERSION = '0.1.0';

/** 点击会话后的打开目标（open_target）：cli=唤起 kimi 终端，web=打开浏览器。 */
export type OpenTarget = 'cli' | 'web';

/** 设置 WebUI 主题（ui_theme）：dark-glass 玻璃拟态 / light-minimal 浅色极简 / cute-pet 萌宠。 */
export type UiTheme = UiThemeName;

/** ui_theme 的默认值。 */
export const DEFAULT_UI_THEME: UiTheme = 'dark-glass';

/**
 * web 打开目标的默认 URL 模板（open_web_url）。
 * 直接按会话恢复的 URL 格式未经官方文档验证，这里默认指向本地 kimi web 首页（`kimi web` 默认端口）。
 */
export const DEFAULT_OPEN_WEB_URL = 'http://127.0.0.1:58627/';

export interface DaemonConfig {
  /** 渲染进程路径（缺省按平台取 renderer/Pet.exe 或 renderer/Pet.app/...，见 resolveRendererPath）。 */
  renderer_path: string;
  /** 心跳间隔（毫秒），渲染进程每 heartbeat_interval_ms 发一次 heartbeat。 */
  heartbeat_interval_ms: number;
  /** 心跳超时（毫秒），超过视为渲染进程失联；0 = 不检测。 */
  heartbeat_timeout_ms: number;
  /** 渲染进程崩溃重启：窗口内最大重启次数。 */
  restart_max_attempts: number;
  /** 重启计数窗口（秒）。 */
  restart_window_s: number;
  /** 宿主全部退出后的退出倒计时（秒）。 */
  host_grace_seconds: number;
  /** 倒计时结束是否自动退出（false 时守护进程常驻，等下一个宿主事件）。 */
  auto_quit_with_host: boolean;
  /** 终端唤起方式：wt（Windows 终端）、cmd（传统控制台）或 wsl（WSL 终端，形态一）。 */
  terminal: 'wt' | 'cmd' | 'wsl';
  /** WSL 发行版名（形态一：WSL 路径转换与终端唤起用），缺省空串。 */
  wsl_distro: string;
  /** 点击会话后的打开目标：cli（唤起 kimi 终端）或 web（打开浏览器）。 */
  open_target: OpenTarget;
  /** web 目标下的 URL 模板（open_web_url），支持 {session_id} 占位符；会话 id 为空时替换为空串。 */
  open_web_url: string;
  /** 设置 WebUI 主题（ui_theme），默认 dark-glass。 */
  ui_theme: UiTheme;
  /** 设置 WebUI 是否显示 FPS 监控浮层（fps_monitor），默认关闭。 */
  fps_monitor: boolean;
  session: {
    /** 会话无事件强制转闲的时长（分钟，状态卡死兜底）。 */
    staleMinutes: number;
    /** 会话长期无事件才清理的时长（分钟）；应明显大于 staleMinutes。 */
    cleanupMinutes: number;
  };
  log_level: LogLevel;
}

/** KIMI_CODE_HOME 未设时回退的用户配置目录名（Windows 默认 C:\Users\<用户名>\.kimi-code）。 */
const KIMI_CODE_DIR = '.kimi-code';

/** 展开字符串中的 %VAR%、$VAR 与 ${VAR} 环境变量引用（默认 renderer_path 依赖环境变量）。未定义的变量替换为空串。 */
export function expandEnvVars(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  return raw
    .replace(/%([^%]+)%/g, (_, name: string) => env[name] ?? '')
    .replace(/\$\{([^}]+)\}/g, (_, name: string) => env[name] ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => env[name] ?? '');
}

/** 守护进程配置目录：KIMI_CODE_HOME/kpet（KIMI_CODE_HOME 未设回退 ~/.kimi-code）。 */
export function getKPetHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.KIMI_CODE_HOME;
  if (home && home.length > 0) return path.join(home, 'kpet');
  return path.join(os.homedir(), KIMI_CODE_DIR, 'kpet');
}

/** 配置文件路径：KIMI_CODE_HOME/kpet/config.json。 */
export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getKPetHome(env), 'config.json');
}

/** 日志目录：KIMI_CODE_HOME/kpet/logs。 */
export function getLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getKPetHome(env), 'logs');
}

/** 日志文件路径：KIMI_CODE_HOME/kpet/logs/kpetd.log。 */
export function getLogFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getLogDir(env), 'kpetd.log');
}

/** 解析渲染进程路径：显式配置 > 默认（KIMI_PLUGIN_ROOT 优先，其次 cwd() 开发兜底）；默认产物名按平台选择。 */
export function resolveRendererPath(raw: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (raw) {
    const expanded = expandEnvVars(raw, env);
    if (expanded.length > 0) return expanded;
  }
  const root = env.KIMI_PLUGIN_ROOT;
  const exeName =
    process.platform === 'win32' ? 'Pet.exe'
    : process.platform === 'darwin' ? path.join('Pet.app', 'Contents', 'MacOS', 'Pet')
    : 'Pet';
  if (root && root.length > 0) return path.join(root, 'renderer', exeName);
  return path.join(process.cwd(), 'renderer', exeName);
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

/** 读取终端方式（terminal）。 */
function readTerminal(obj: Record<string, unknown>, warnings: string[]): 'wt' | 'cmd' | 'wsl' {
  const v = obj['terminal'];
  if (v === 'wt' || v === 'cmd' || v === 'wsl') return v;
  if (v !== undefined) warnings.push('配置项 terminal 非法（需要 "wt"、"cmd" 或 "wsl"），使用默认值 "wt"');
  return 'wt';
}

/** 读取 WSL 发行版名（形态一：WSL 路径转换与终端唤起用）。 */
function readWslDistro(obj: Record<string, unknown>, warnings: string[]): string {
  const v = obj['wsl_distro'];
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  warnings.push('配置项 wsl_distro 非法（需要字符串），使用默认值 ""');
  return '';
}

/** 读取打开目标（open_target）。 */
function readOpenTarget(obj: Record<string, unknown>, warnings: string[]): OpenTarget {
  const v = obj['open_target'];
  if (v === 'cli' || v === 'web') return v;
  if (v !== undefined) warnings.push('配置项 open_target 非法（需要 "cli" 或 "web"），使用默认值 "cli"');
  return 'cli';
}

/** 读取 web 目标下的 URL 模板（open_web_url）。 */
function readOpenWebUrl(obj: Record<string, unknown>, warnings: string[]): string {
  const v = obj['open_web_url'];
  if (v === undefined) return DEFAULT_OPEN_WEB_URL;
  if (typeof v === 'string' && v.length > 0) return v;
  warnings.push(`配置项 open_web_url 非法（需要非空字符串），使用默认值 ${DEFAULT_OPEN_WEB_URL}`);
  return DEFAULT_OPEN_WEB_URL;
}

/** 读取设置 WebUI 主题（ui_theme，风格与 readOpenTarget/readOpenWebUrl 一致）。 */
function readUiTheme(obj: Record<string, unknown>, warnings: string[]): UiTheme {
  const v = obj['ui_theme'];
  if (v === 'dark-glass' || v === 'light-minimal' || v === 'cute-pet') return v;
  if (v !== undefined) {
    warnings.push('配置项 ui_theme 非法（需要 "dark-glass"、"light-minimal" 或 "cute-pet"），使用默认值 "dark-glass"');
  }
  return DEFAULT_UI_THEME;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** 读取日志级别（log_level）。 */
function readLogLevel(obj: Record<string, unknown>, warnings: string[]): LogLevel {
  const v = obj['log_level'];
  if (typeof v === 'string' && (LOG_LEVELS as readonly string[]).includes(v)) return v as LogLevel;
  if (v !== undefined) warnings.push('配置项 log_level 非法，使用默认值 "info"');
  return 'info';
}

/** 全部配置键 + 默认值。renderer_path 的默认值依赖环境与平台（KIMI_PLUGIN_ROOT）。 */
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
    wsl_distro: '',
    open_target: 'cli',
    open_web_url: DEFAULT_OPEN_WEB_URL,
    ui_theme: DEFAULT_UI_THEME,
    fps_monitor: false,
    session: { staleMinutes: 10, cleanupMinutes: 60 },
    log_level: 'info',
  };
}

/**
 * 加载守护进程配置。
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
    wsl_distro: readWslDistro(obj, warnings),
    open_target: readOpenTarget(obj, warnings),
    open_web_url: readOpenWebUrl(obj, warnings),
    ui_theme: readUiTheme(obj, warnings),
    fps_monitor: readBoolean(obj, 'fps_monitor', defaults.fps_monitor, warnings),
    session: { staleMinutes, cleanupMinutes },
    log_level: readLogLevel(obj, warnings),
  };
  return { config, warnings, source };
}

/** 运行时配置更新结果：config 为合并后的生效配置；applied 为实际合法的更新字段（供持久化）；warnings 为非法字段告警。 */
export interface ApplyConfigPatchResult {
  config: DaemonConfig;
  applied: UpdateConfigPayload;
  warnings: string[];
}

/**
 * 把渲染进程 update_config 的部分配置合并进内存配置（设置 WebUI 配置下发）。
 * - 每个已知字段单独校验：合法才覆盖；非法记告警并保持当前值（运行时不回退默认，避免误操作重置用户选择）；
 * - 返回实际应用的字段子集（applied），调用方用它写回配置文件；applied 为空表示无任何合法字段（调用方回 protocol_error）。
 */
export function applyConfigPatch(base: DaemonConfig, patch: UpdateConfigPayload): ApplyConfigPatchResult {
  const config = { ...base };
  const applied: UpdateConfigPayload = {};
  const warnings: string[] = [];

  if (patch.open_target !== undefined) {
    if (patch.open_target === 'cli' || patch.open_target === 'web') {
      config.open_target = patch.open_target;
      applied.open_target = patch.open_target;
    } else {
      warnings.push(`配置项 open_target 非法（需要 "cli" 或 "web"），保持当前值 ${config.open_target}`);
    }
  }
  if (patch.ui_theme !== undefined) {
    if (patch.ui_theme === 'dark-glass' || patch.ui_theme === 'light-minimal' || patch.ui_theme === 'cute-pet') {
      config.ui_theme = patch.ui_theme;
      applied.ui_theme = patch.ui_theme;
    } else {
      warnings.push(`配置项 ui_theme 非法（需要 "dark-glass"、"light-minimal" 或 "cute-pet"），保持当前值 ${config.ui_theme}`);
    }
  }
  if (patch.fps_monitor !== undefined) {
    if (typeof patch.fps_monitor === 'boolean') {
      config.fps_monitor = patch.fps_monitor;
      applied.fps_monitor = patch.fps_monitor;
    } else {
      warnings.push(`配置项 fps_monitor 非法（需要布尔值），保持当前值 ${config.fps_monitor}`);
    }
  }

  return { config, applied, warnings };
}

/**
 * 把运行时配置更新合并写回配置文件（设置 WebUI 持久化）。
 * - 读原 JSON（不存在/非法/非对象时按空对象），保留所有未知字段（字段级只增不改）；
 * - 只合并本次实际合法应用的字段；2 空格缩进写回，缺目录时自动创建；
 * - 返回是否写成功；任何失败都不抛异常，由调用方记日志（写失败不崩守护进程）。
 */
export function saveConfig(filePath: string, patch: UpdateConfigPayload): boolean {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    raw = {};
  }
  const merged = { ...raw, ...patch };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}
