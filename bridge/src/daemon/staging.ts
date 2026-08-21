/**
 * 启动时回收本地事件暂存（§3.3 兜底：转发器写管道失败时把信封落到系统临时目录下的 kpet-events/，
 * 守护进程启动后按字典序（= 时间序，见 bridge/src/bridge/staging.ts 的命名规则）重放并删除）。
 *
 * 只处理列表瞬间已存在的文件；重放期间新到的暂存文件留到下次启动（守护进程运行中转发器
 * 写不进事件管道的概率极低，且重放失败放行，不阻塞启动）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateEnvelope, type MessageEnvelope } from '../protocol/index.js';
import { getStagingDir } from '../bridge/staging.js';
import type { Logger } from './logger.js';

/**
 * 重放暂存目录中的全部信封（字典序 = 时间序），每个文件处理（或解析失败）后删除。
 * @returns 成功解析并回调的信封数。
 */
export function replayStagingDir(
  dir: string = getStagingDir(),
  onEnvelope: (env: MessageEnvelope) => void,
  logger?: Logger,
  beforeEach?: () => void,
): number {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return 0; // 目录不存在：没有暂存
  }
  files.sort(); // 字典序 = 时间序（buildStagingFileName 零填充时间戳前缀）

  let replayed = 0;
  for (const file of files) {
    const p = path.join(dir, file);
    if (!file.endsWith('.json')) {
      // 非暂存格式的杂项文件不动
      continue;
    }
    // 恢复交接锁可能需要在大量文件回放期间续租；该回调失败必须向上传播，
    // 不能被当成坏暂存文件吞掉并删除。
    beforeEach?.();
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const validation = validateEnvelope(JSON.parse(raw));
      if (validation.ok && validation.envelope.type === 'host_event') {
        onEnvelope(validation.envelope);
        replayed++;
      } else {
        logger?.warn(`暂存文件 ${file} 不是合法 host_event 信封，丢弃`);
      }
    } catch {
      logger?.warn(`暂存文件 ${file} 解析失败，丢弃`);
    }
    try {
      fs.rmSync(p, { force: true }); // 重放后删除（§3.3）
    } catch {
      // 删除失败无妨：文件带时间戳前缀，不会重复重放造成副作用
    }
  }
  return replayed;
}
