/**
 * Kimi Code CLI 会话目录读取与会话展示快照合并。
 *
 * 该模块只负责读取 KIMI_CODE_HOME/session_index.jsonl 及对应的
 * sessionDir/state.json，不依赖守护进程状态机，因此可以用临时目录或
 * 注入的读取函数独立测试。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const SESSION_INDEX_FILE = 'session_index.jsonl';
export const SESSION_STATE_FILE = 'state.json';
export const MAX_SESSION_CATALOG_ENTRIES = 50;
/** 展示字段按字节截断，避免 50 条目录项超过单条协议消息上限。 */
export const MAX_SESSION_TITLE_BYTES = 192;
export const MAX_SESSION_CWD_BYTES = 512;

/** 目录索引文件中的一行。 */
export interface SessionIndexRecord {
  sessionId: string;
  sessionDir: string;
  workDir: string;
}

/** 从 CLI state.json 提取后供守护进程使用的历史会话。 */
export interface SessionCatalogEntry {
  sessionId: string;
  title: string;
  cwd: string;
  /** CLI state.json 的 Int64 毫秒时间戳；ISO 字符串会在读取时转换。 */
  updatedAt: number;
}

/** state.getSnapshot() 中活跃会话的最小形状。 */
export interface ActiveSessionEntry {
  sessionId: string;
  cwd: string | null;
  busy: boolean;
  unread: boolean;
}

/** sessions_snapshot 中单个列表项。 */
export interface SessionSnapshotItem {
  session_id: string;
  title: string;
  cwd: string;
  active: boolean;
  working: boolean;
  unread: boolean;
  updated_at: number;
}

export interface SessionsSnapshotPayload {
  sessions: SessionSnapshotItem[];
}

/** 可注入的文件读取函数，便于单测不依赖实际用户目录。 */
export type SessionCatalogReadFile = (filePath: string) => string;

export interface SessionCatalogOptions {
  /** 显式指定索引文件路径；未指定时按 env/KIMI_CODE_HOME 推导。 */
  indexPath?: string;
  env?: NodeJS.ProcessEnv;
  /** 注入文件读取函数；未指定时使用 fs.readFileSync。 */
  readFile?: SessionCatalogReadFile;
}

/** 供 DaemonApp 注入的目录读取器。 */
export type SessionCatalogReader = () => SessionCatalogEntry[];

/** 返回 CLI 会话索引文件路径。 */
export function resolveSessionIndexPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.KIMI_CODE_HOME;
  const kimiCodeHome = home && home.length > 0 ? home : path.join(os.homedir(), '.kimi-code');
  return path.join(kimiCodeHome, SESSION_INDEX_FILE);
}

/**
 * 读取 CLI 会话目录。
 *
 * 单行或单个 state.json 损坏时跳过该记录，不让目录损坏阻断守护进程握手。
 * 同一个 sessionId 只保留 updatedAt 更新的记录，最终按更新时间倒序并限制
 * 为最多 50 条。
 */
export function readSessionCatalog(options: SessionCatalogOptions = {}): SessionCatalogEntry[] {
  const indexPath = options.indexPath ?? resolveSessionIndexPath(options.env ?? process.env);
  const readFile = options.readFile ?? ((filePath: string) => fs.readFileSync(filePath, 'utf8'));

  let indexText: string;
  try {
    indexText = readFile(indexPath);
  } catch {
    return [];
  }

  const entries = new Map<string, SessionCatalogEntry & { updatedAtMs: number; ordinal: number }>();
  const indexDir = path.dirname(indexPath);
  const lines = indexText.split(/\r?\n/);
  lines.forEach((line, ordinal) => {
    const indexRecord = parseIndexRecord(line);
    if (!indexRecord) return;

    const statePath = path.join(resolveSessionDir(indexRecord.sessionDir, indexDir), SESSION_STATE_FILE);
    let stateText: string;
    try {
      stateText = readFile(statePath);
    } catch {
      return;
    }
    const state = parseState(stateText, indexRecord);
    if (!state || state.archived) return;

    const candidate = {
      sessionId: indexRecord.sessionId,
      title: state.title,
      cwd: state.cwd,
      updatedAt: state.updatedAt,
      updatedAtMs: state.updatedAtMs,
      ordinal,
    };
    const previous = entries.get(candidate.sessionId);
    // 索引是追加式文件；相同 id 以更新时间较新的 state 为准，时间相同则
    // 采用后出现的记录，保证去重结果与文件尾部更新一致。
    if (!previous || candidate.updatedAtMs > previous.updatedAtMs ||
      (candidate.updatedAtMs === previous.updatedAtMs && candidate.ordinal >= previous.ordinal)) {
      entries.set(candidate.sessionId, candidate);
    }
  });

  return [...entries.values()]
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.ordinal - a.ordinal)
    .slice(0, MAX_SESSION_CATALOG_ENTRIES)
    .map(({ updatedAtMs: _updatedAtMs, ordinal: _ordinal, ...entry }) => entry);
}

/** 把 CLI 历史与状态机活跃会话合并为 sessions_snapshot 列表。 */
export function mergeSessionSnapshots(
  history: readonly SessionCatalogEntry[],
  active: readonly ActiveSessionEntry[],
): SessionSnapshotItem[] {
  const activeById = new Map(active.map((entry) => [entry.sessionId, entry]));
  const result: SessionSnapshotItem[] = [];
  const emitted = new Set<string>();

  // 先保持 CLI 目录的时间顺序；活跃状态覆盖同 id 的展示状态，但保留
  // CLI 提供的标题、更新时间，保证历史点击仍然使用目录 cwd。
  for (const item of history) {
    const current = activeById.get(item.sessionId);
    result.push({
      session_id: item.sessionId,
      title: truncateUtf8(item.title, MAX_SESSION_TITLE_BYTES),
      cwd: truncateUtf8(current?.cwd ?? item.cwd, MAX_SESSION_CWD_BYTES),
      active: current !== undefined,
      working: current?.busy ?? false,
      unread: current?.unread ?? false,
      updated_at: item.updatedAt,
    });
    emitted.add(item.sessionId);
  }

  // 活跃事件可能先于 CLI 索引落盘，不能因目录暂无记录而丢失活跃会话。
  for (const current of active) {
    if (emitted.has(current.sessionId)) continue;
    result.push({
      session_id: current.sessionId,
      title: truncateUtf8(current.sessionId, MAX_SESSION_TITLE_BYTES),
      cwd: truncateUtf8(current.cwd ?? '', MAX_SESSION_CWD_BYTES),
      active: true,
      working: current.busy,
      unread: current.unread,
      updated_at: 0,
    });
  }
  return result;
}

function parseIndexRecord(line: string): SessionIndexRecord | null {
  if (line.trim().length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const sessionId = nonEmptyString(value.sessionId);
  const sessionDir = nonEmptyString(value.sessionDir);
  const workDir = nonEmptyString(value.workDir);
  if (!sessionId || !sessionDir || !workDir) return null;
  return { sessionId, sessionDir, workDir };
}

interface ParsedState {
  title: string;
  cwd: string;
  updatedAt: number;
  updatedAtMs: number;
  archived: boolean;
}

function parseState(text: string, indexRecord: SessionIndexRecord): ParsedState | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const title = nonEmptyString(value.title);
  const cwd = nonEmptyString(value.cwd) ?? indexRecord.workDir;
  const updatedAtMs = parseUpdatedAt(value.updatedAt);
  const archived = value.archived;
  // 旧版 CLI 的 state.json 没有 archived/cwd 字段：cwd 回退 workDir，
  // archived 缺省视为未归档；出现其他类型仍视为非法记录。
  if (!title || !cwd || Number.isNaN(updatedAtMs) ||
    (archived !== undefined && typeof archived !== 'boolean')) return null;
  return { title, cwd, updatedAt: updatedAtMs, updatedAtMs, archived: archived === true };
}

function parseUpdatedAt(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value.length > 0) {
    if (/^\d+$/.test(value)) {
      const numeric = Number(value);
      if (Number.isSafeInteger(numeric) && numeric >= 0) return numeric;
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Number.NaN;
}

function resolveSessionDir(sessionDir: string, indexDir: string): string {
  if (path.isAbsolute(sessionDir) || /^[A-Za-z]:[\\/]/.test(sessionDir) || sessionDir.startsWith('\\\\')) {
    return sessionDir;
  }
  return path.resolve(indexDir, sessionDir);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** 按 UTF-8 字节数安全截断，避免截断多字节字符。 */
function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result;
}
