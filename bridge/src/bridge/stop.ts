/**
 * 守护进程停止（--stop 分发，与守护进程端优雅退出路径配合）。
 *
 * 停止流程（按共享 --stop 契约，只通过抑制标记触发、不直接杀进程）：
 *   - 无守护进程运行（事件管道不存在）→ 返回 'not_running'，不写也不清抑制标记；
 *   - 有 → 入口先记下既有抑制标记（用户手动关闭宠物留下的，绝不清除），仅当无既有
 *     标记时写入 pet.disabled，触发守护进程优雅退出：
 *       housekeeping 每 1s 检测抑制标记并 requestShutdown('user')（app.ts），
 *       'user' 退出路径自行 forceKill 渲染进程、发送 shutdown 并关闭两条管道（app.ts）；
 *     随后轮询等待事件管道释放；
 *   - 管道在超时内释放 → 'stopped'；否则 → 'timeout'；
 *   - 无论成功与否，finally 只在本次写入过标记时才清除：守护进程 'user' 退出路径会
 *     补写标记（app.ts），且只有管道释放后守护进程才算真正停止，因此清除必须发生在
 *     管道释放之后（finally 兜底），也不能误清用户手动关闭留下的既有标记。
 */
import { clearPetSuppressed, getPetSuppressionPath, isPetSuppressed, setPetSuppressed } from './daemon.js';
import { probePipe } from './pipe.js';
import { getEventPipeName } from './user.js';

/** 等待事件管道释放的总超时（毫秒）；与守护进程优雅退出路径的耗时上限匹配。 */
export const STOP_PIPE_WAIT_MS = 15_000;
/** 轮询事件管道释放的间隔（毫秒）。 */
export const STOP_POLL_INTERVAL_MS = 200;
/** 单次探测管道存在性的超时（毫秒）。 */
const STOP_PROBE_TIMEOUT_MS = 100;

export type StopDaemonResult = 'not_running' | 'stopped' | 'timeout';

/** 停止守护进程核心逻辑的可注入依赖（测试用；生产环境全部缺省）。 */
export interface StopDaemonOptions {
  /** 事件管道全名，缺省按当前用户名推导。 */
  pipeName?: string;
  /** 用户关闭抑制标记路径，缺省系统临时目录下的 kpet/pet.disabled。 */
  suppressionPath?: string;
  /** 探测事件管道存在性的函数；测试可注入可控返回序列。 */
  probe?: (pipe: string, timeoutMs?: number) => Promise<boolean>;
  /** 等待管道释放的总超时（毫秒），缺省 15 秒。 */
  timeoutMs?: number;
  /** 轮询间隔（毫秒），缺省 200ms。 */
  pollIntervalMs?: number;
  /** 延迟函数；测试可注入假 sleep 避免真实等待。 */
  sleep?: (ms: number) => Promise<void>;
}

export async function stopDaemon(opts: StopDaemonOptions = {}): Promise<StopDaemonResult> {
  const pipeName = opts.pipeName ?? getEventPipeName();
  const suppressionPath = opts.suppressionPath ?? getPetSuppressionPath();
  const probe = opts.probe ?? probePipe;
  const timeoutMs = opts.timeoutMs ?? STOP_PIPE_WAIT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? STOP_POLL_INTERVAL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // 用户手动关闭宠物留下的既有标记必须保留；是否写入新标记以此为准。
  const wasSuppressed = isPetSuppressed(suppressionPath);

  if (!(await probe(pipeName, STOP_PROBE_TIMEOUT_MS))) return 'not_running';

  // 仅当此前没有抑制标记才写入，触发守护进程优雅退出；写失败时不短路，继续轮询，
  // 若守护进程恰好自行退出则仍算停止成功。
  const wroteMarker = !wasSuppressed && setPetSuppressed(suppressionPath);
  try {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (!(await probe(pipeName, STOP_PROBE_TIMEOUT_MS))) return 'stopped';
      const remaining = deadline - Date.now();
      if (remaining <= 0) return 'timeout';
      await sleep(Math.min(pollIntervalMs, remaining));
    }
  } finally {
    // 守护进程 'user' 退出路径会补写抑制标记且管道释放后才真正停止；因此清除必须
    // 发生在 finally（管道释放之后），且只清本次写入的标记，不动既有标记。
    if (wroteMarker) clearPetSuppressed(suppressionPath);
  }
}

/** --stop 命令行入口：按契约打印中文结果并以 0/0/1 退出码退出（launcher 分发调用，不读取 stdin）。 */
export async function stopMain(): Promise<void> {
  let result: StopDaemonResult;
  try {
    result = await stopDaemon();
  } catch {
    console.error('停止守护进程失败：等待过程中发生异常');
    process.exit(1);
  }
  if (result === 'not_running') {
    console.log('未发现运行中的守护进程');
    process.exit(0);
  }
  if (result === 'stopped') {
    console.log('已停止守护进程');
    process.exit(0);
  }
  console.error(`等待停止守护进程超时（${STOP_PIPE_WAIT_MS / 1000} 秒内事件管道未释放）`);
  process.exit(1);
}