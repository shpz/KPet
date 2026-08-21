/**
 * 守护进程入口 kpetd（§2.3 / §4.5-6）。
 *
 * 启动：加载配置 → 建两条管道（事件管道被占用 = 已有实例，直接退出，§4.1）→ 拉起渲染进程 →
 * 回收暂存（§3.3）→ 常驻等待事件。
 * 退出：最后一个 SessionEnd → host_grace_seconds 倒计时 → shutdown → 退出（§4.5-6）。
 *
 * 单实例说明：Node 侧没有 Win32 命名互斥体 API（§4.1 原设计），改为「事件管道名占用」实现 ——
 * 同名管道创建失败（EADDRINUSE/EACCES）即视为已有实例，以退出码 0 静默结束（转发器感知不到
 * 失败，不会误报；守护进程是随首个宿主事件由转发器拉起的，重复拉起是常态）。
 *
 * 入口 main 由 src/launcher/main.ts 按 --daemon 参数分发调用。
 */
import { DaemonApp, SingleInstanceError } from './app.js';
import { DAEMON_VERSION, getLogFilePath, loadConfig } from './config.js';
import { Logger } from './logger.js';

export async function main(): Promise<void> {
  const { config, warnings, source } = loadConfig(process.env);
  const logger = new Logger({ level: config.log_level, filePath: getLogFilePath(process.env) });
  logger.info(`守护进程 v${DAEMON_VERSION} 启动（配置来源: ${source === 'file' ? 'config.json' : '默认值'}）`);
  for (const w of warnings) logger.warn(w);

  const app = new DaemonApp({ config, logger });
  try {
    await app.start();
  } catch (err) {
    if (err instanceof SingleInstanceError) {
      // 已有实例：直接退出（§4.1 单实例语义）
      logger.info(`${err.message}，本实例退出`);
      process.exit(0);
    }
    logger.error(`启动失败: ${(err as Error).message}`);
    process.exit(1);
  }

  // 信号与未捕获异常：尽力优雅退出（dev 用 node 直跑时生效；bun compile 后无控制台无信号）
  process.on('SIGINT', () => app.requestShutdown('user'));
  process.on('SIGTERM', () => app.requestShutdown('user'));
  process.on('uncaughtException', (err) => {
    logger.error(`未捕获异常: ${err?.stack ?? String(err)}`);
    app.requestShutdown('error');
  });
}
