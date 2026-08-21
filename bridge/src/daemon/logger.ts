/**
 * 守护进程日志（§2.3/§11 约定：用户配置目录 KIMI_CODE_HOME 下的 kpet/logs/kpetd.log，log_level 可配）。
 *
 * 关键事件（状态切换/渲染进程重启/快照回放/open_tui/退出）必须走 info 及以上级别；
 * 普通管道收发与内部细节走 debug，默认不落盘刷屏。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LoggerOptions {
  level: LogLevel;
  /** 日志文件路径；null 表示不写文件（测试用）。 */
  filePath: string | null;
}

/**
 * 同步追加写日志文件（低频小消息，同步写避免异步交错与丢行）；
 * 首次写入时递归创建目录。console 镜像输出便于 node 直跑调试（bun compile 后无控制台）。
 */
export class Logger {
  readonly level: LogLevel;
  private readonly filePath: string | null;
  private dirCreated = false;

  constructor(opts: LoggerOptions) {
    this.level = opts.level;
    this.filePath = opts.filePath;
  }

  debug(msg: string): void {
    this.write('debug', msg);
  }

  info(msg: string): void {
    this.write('info', msg);
  }

  warn(msg: string): void {
    this.write('warn', msg);
  }

  error(msg: string): void {
    this.write('error', msg);
  }

  private write(level: LogLevel, msg: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const line = `${new Date().toISOString()} [${level}] ${msg}`;
    // console 镜像：dev 用 node 直跑时可见，bun compile 后无控制台自然不可见
    console.log(line);
    if (!this.filePath) return;
    try {
      if (!this.dirCreated) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        this.dirCreated = true;
      }
      fs.appendFileSync(this.filePath, line + '\n', 'utf8');
    } catch {
      // 日志写失败不影响守护进程主流程
    }
  }
}
