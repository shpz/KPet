/**
 * 打开终端（§4.5-3 点击回传：渲染进程发 open_tui → 守护进程唤起 kimi 终端）。
 *
 * - terminal=wt：`wt.exe -d <cwd> cmd /k kimi --session <会话id>`；wt.exe 不可用（spawn ENOENT）时
 *   回退 `cmd /c start`（§4.5-3 备选）；
 * - terminal=cmd：`cmd /c start "" cmd /k kimi --session <会话id>`；
 * - 会话 id 为空 → `kimi --continue` 恢复最近会话（§4.5-3）；
 * - 分离拉起（detached + unref）：终端不随守护进程生命周期退出。
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface OpenTuiOptions {
  terminal: 'wt' | 'cmd';
  /** kimi 终端的工作目录（§4.5-3：-d <cwd>）。 */
  cwd: string;
  /** 目标会话；null = 最近会话（kimi --continue）。 */
  sessionId: string | null;
}

export interface OpenTuiCommand {
  file: string;
  args: string[];
  cwd: string;
}

/** 构造唤起命令（纯函数，可单测）。 */
export function buildOpenTuiCommand(opts: OpenTuiOptions): OpenTuiCommand {
  const sessionArgs = opts.sessionId ? ['--session', opts.sessionId] : ['--continue'];
  if (opts.terminal === 'wt') {
    return {
      file: 'wt.exe',
      args: ['-d', opts.cwd, 'cmd', '/k', 'kimi', ...sessionArgs],
      cwd: opts.cwd,
    };
  }
  return {
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'cmd', '/k', 'kimi', ...sessionArgs],
    cwd: opts.cwd,
  };
}

export type SpawnFn = (file: string, args: string[], opts: { detached: boolean; stdio: 'ignore'; windowsHide: boolean }) => ChildProcess;

export interface OpenTuiResult {
  /** 实际执行方式：'wt' | 'cmd'（wt 回退/配置 cmd）。 */
  terminal: 'wt' | 'cmd';
  ok: boolean;
  error?: string;
}

/**
 * 唤起终端。wt 拉起失败（未安装/不在 PATH）时回退 cmd /c start（§4.5-3 备选）。
 * 全部失败返回 ok=false（不重试轰炸，调用方记日志，§6.5 发送失败不重试的语义同源）。
 */
export function openTui(
  opts: OpenTuiOptions,
  spawnFn: SpawnFn = (file, args, spawnOpts) => spawn(file, args, spawnOpts),
): Promise<OpenTuiResult> {
  return new Promise((resolve) => {
    const attempt = (terminal: 'wt' | 'cmd', cmd: OpenTuiCommand): void => {
      let child: ChildProcess;
      try {
        child = spawnFn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: true });
      } catch (err) {
        finish(terminal, false, (err as Error).message);
        return;
      }
      child.once('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (terminal === 'wt' && code === 'ENOENT') {
          // wt.exe 不可用：回退 cmd /c start（§4.5-3）
          attempt('cmd', buildOpenTuiCommand({ ...opts, terminal: 'cmd' }));
        } else {
          finish(terminal, false, `${code ?? err.message}`);
        }
      });
      child.once('spawn', () => {
        child.unref(); // 终端不随守护进程退出
        finish(terminal, true);
      });
    };

    const finish = (terminal: 'wt' | 'cmd', ok: boolean, error?: string): void => {
      resolve({ terminal, ok, error });
    };

    attempt(opts.terminal, buildOpenTuiCommand(opts));
  });
}
