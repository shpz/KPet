/**
 * 本地事件暂存（§3.3 兜底：管道写入失败时写 %TEMP%/kimi-pet-events/，守护进程启动后回收）。
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MessageEnvelope } from '../protocol/index.js';

/** 事件暂存目录名（相对 %TEMP%），§3.3：%TEMP%/kimi-pet-events/。 */
export const STAGING_DIR_NAME = 'kimi-pet-events';

/** 随机串截取长度（文件名后缀）。 */
const RAND_SUFFIX_LEN = 8;

/**
 * 暂存文件命名：UTC 时间戳前缀（等宽零填充，字典序 = 时间序，保证可排序回收）
 * + 随机串（防并发冲突）。例：20260731-173530.123-4f2a9c7e.json
 */
export function buildStagingFileName(ts: Date = new Date(), rand: string = randomUUID()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${ts.getUTCFullYear()}${pad(ts.getUTCMonth() + 1)}${pad(ts.getUTCDate())}-` +
    `${pad(ts.getUTCHours())}${pad(ts.getUTCMinutes())}${pad(ts.getUTCSeconds())}.${pad(ts.getUTCMilliseconds(), 3)}`;
  return `${stamp}-${rand.slice(0, RAND_SUFFIX_LEN)}.json`;
}

/** 事件暂存目录路径：%TEMP%/kimi-pet-events/。 */
export function getStagingDir(tmpDir: string = os.tmpdir()): string {
  return path.join(tmpDir, STAGING_DIR_NAME);
}

/**
 * 把信封写入本地暂存文件兜底（§3.3）。
 * 目录不存在则递归创建；单文件单事件，内容为信封的完整 JSON。
 * 任何失败（磁盘只读等）静默返回 null，绝不抛出 —— 转发器任何情况以 0 退出（§2.2 D4）。
 *
 * @returns 写入的文件路径；失败返回 null。
 */
export function writeStaging(
  envelope: MessageEnvelope,
  dir: string = getStagingDir(),
  ts?: Date,
): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, buildStagingFileName(ts ?? nextStagingTimestamp(dir)));
    fs.writeFileSync(file, JSON.stringify(envelope), 'utf8');
    return file;
  } catch {
    return null;
  }
}

/**
 * 在已有暂存文件的最大文件名时间戳后至少递增 1ms。
 * 恢复期写入由 pet.recovering.gate 串行化，因此即使 SessionStart 与后续事件
 * 落在同一毫秒，字典序仍严格等于到达顺序。
 */
function nextStagingTimestamp(dir: string): Date {
  let nextMs = Date.now();
  try {
    for (const file of fs.readdirSync(dir)) {
      const parsed = parseStagingTimestamp(file);
      if (parsed !== null && parsed >= nextMs) nextMs = parsed + 1;
    }
  } catch {
    // 目录刚创建或并发消失时使用当前时间。
  }
  return new Date(nextMs);
}

function parseStagingTimestamp(file: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.(\d{3})-/.exec(file);
  if (!match) return null;
  const values = match.slice(1).map(Number);
  const [year, month, day, hour, minute, second, millisecond] = values;
  if ([year, month, day, hour, minute, second, millisecond].some((value) => value === undefined)) return null;
  const timestamp = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!, millisecond!);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * 清理指定暂存目录中的事件文件。
 * 用户关闭后旧事件不应在下一次 SessionStart 恢复时重放；只删除本目录下的 .json 暂存，
 * 目录中的其他文件保留，避免误伤宿主或调试文件。
 */
export function clearStagingDir(dir: string = getStagingDir(), beforeEach?: () => void): number {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    beforeEach?.();
    try {
      fs.rmSync(path.join(dir, file), { force: true });
      removed++;
    } catch {
      // 删除失败不阻塞恢复；后续启动仍会按正常暂存逻辑处理。
    }
  }
  return removed;
}

/** 按文件名中的事件时间戳清理关闭前暂存，不受文件系统 mtime 精度影响。 */
export function clearStagingBeforeTimestamp(
  dir: string = getStagingDir(),
  beforeMs: number,
  beforeEach?: () => void,
): number {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    beforeEach?.();
    const timestamp = parseStagingTimestamp(file);
    if (timestamp === null) {
      // 兼容旧版/损坏命名：只在 mtime 确认它属于关闭前时才清理。
      try {
        if (fs.statSync(path.join(dir, file)).mtimeMs > beforeMs) continue;
      } catch {
        continue;
      }
    } else if (timestamp > beforeMs) {
      continue;
    }
    try {
      fs.rmSync(path.join(dir, file), { force: true });
      removed++;
    } catch {
      // 删除失败不阻塞恢复。
    }
  }
  return removed;
}
