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
  ts: Date = new Date(),
): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, buildStagingFileName(ts));
    fs.writeFileSync(file, JSON.stringify(envelope), 'utf8');
    return file;
  } catch {
    return null;
  }
}
