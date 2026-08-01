/**
 * 转发器主程序 kimi-pet-bridge（§3.3 伪代码）。
 *
 * 宿主每发生一个事件拉起本进程一次，流程：
 *   read_all(stdin) → 非法 JSON 直接放行 → 包装 host_event 信封
 *   → 管道不存在则分离拉起守护进程（防并发风暴）
 *   → 连接 + 写入（200ms 超时）→ 失败写本地暂存
 *   → 任何情况 exit(0)（失败放行，§2.2 D4 / §3.1 宿主约定）
 *
 * 消息按 §4.2 为单个 JSON 对象；node:net 的命名管道是字节流模式而非消息模式，
 * 为让守护进程端可靠分帧，每条消息追加一个换行（JSON 文本流惯例，不影响消息模式收端）。
 */
import { createHostEventEnvelope, type MessageEnvelope } from '../protocol/index.js';
import { getEventPipeName } from './user.js';
import { probePipe, writeToPipe, type PipeWriteResult } from './pipe.js';
import { spawnDaemonIfNeeded } from './daemon.js';
import { writeStaging } from './staging.js';

/** 事件管道连接 + 写入总超时（毫秒），§3.3：200ms。 */
export const PIPE_TIMEOUT_MS = 200;

/** 探测管道存在性的超时（毫秒），不消耗主预算。 */
const PIPE_PROBE_TIMEOUT_MS = 100;

/** 帧分隔符：见文件头注释。 */
export const FRAME_DELIMITER = '\n';

export type RelayOutcome = 'invalid_json' | 'delivered' | 'staged';

export interface RelayResult {
  outcome: RelayOutcome;
}

/** 转发器核心逻辑的可注入依赖（测试用；生产环境全部缺省）。 */
export interface RelayOptions {
  /** 事件管道全名，缺省按当前用户名推导（§4.1）。 */
  pipeName?: string;
  /** 连接 + 写入总超时（毫秒），缺省 200ms（§3.3）。 */
  timeoutMs?: number;
  /** 暂存目录，缺省 %TEMP%/kimi-pet-events/（§3.3）。 */
  stagingDir?: string;
  /** 是否允许拉起守护进程，缺省 true（测试置 false）。 */
  spawnDaemon?: boolean;
  probe?: (pipe: string) => Promise<boolean>;
  write?: (pipe: string, data: string, timeoutMs: number) => Promise<PipeWriteResult>;
  staging?: (envelope: MessageEnvelope) => string | null;
}

/**
 * 转发器核心流程（§3.3）：
 * 非法 JSON → 直接放行（返回 'invalid_json'，调用方以 0 退出），永不阻塞宿主（§2.2 D4）。
 */
export async function relayHostEvent(raw: string, opts: RelayOptions = {}): Promise<RelayResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { outcome: 'invalid_json' };
  }
  const envelope = createHostEventEnvelope(raw, parsed);
  return relayEnvelope(envelope, opts);
}

/** 信封 → 管道（含守护进程拉起与暂存兜底）。测试可直接注入信封与依赖。 */
export async function relayEnvelope(envelope: MessageEnvelope, opts: RelayOptions = {}): Promise<RelayResult> {
  const pipeName = opts.pipeName ?? getEventPipeName();
  const timeoutMs = opts.timeoutMs ?? PIPE_TIMEOUT_MS;
  const probe = opts.probe ?? probePipe;
  const write = opts.write ?? writeToPipe;
  const staging = opts.staging ?? ((env) => writeStaging(env, opts.stagingDir));

  const exists = await probe(pipeName, PIPE_PROBE_TIMEOUT_MS);
  if (!exists && opts.spawnDaemon !== false) {
    spawnDaemonIfNeeded(); // 分离拉起，不等待就绪；守护进程启动期间的事件走暂存兜底（§3.4）
  }

  const result = await write(pipeName, JSON.stringify(envelope) + FRAME_DELIMITER, timeoutMs);
  if (result !== 'ok') {
    staging(envelope); // 兜底：写本地暂存，守护进程启动后回收
    return { outcome: 'staged' };
  }
  return { outcome: 'delivered' };
}

/** 读取 stdin 全部内容（宿主事件 JSON，§3.1）。 */
export function readAllStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      data += chunk;
    });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

/** 入口：任何情况都以 0 退出（失败放行，§2.2 D4 / §3.3）。 */
async function main(): Promise<void> {
  try {
    const raw = await readAllStdin();
    await relayHostEvent(raw);
  } catch {
    // 极端异常也放行
  }
  process.exit(0);
}

main();
