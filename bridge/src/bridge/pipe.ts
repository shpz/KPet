/**
 * 事件管道客户端（node:net，Windows 命名管道）。
 * 转发器只做客户端：探测管道存在性、连接并写入一条消息，总超时 200ms。
 */
import * as net from 'node:net';

/** 连接 + 写入的总超时（毫秒），规定 200ms。 */
export const DEFAULT_PIPE_TIMEOUT_MS = 200;

/** 探测超时（毫秒）：探测本身不应消耗主预算。 */
const PROBE_TIMEOUT_MS = 100;

/** 视为「管道不存在」的错误码：Windows 命名管道不存在时 node:net 报告 ENOENT / ECONNREFUSED。 */
const PIPE_NOT_FOUND_CODES = new Set(['ENOENT', 'ECONNREFUSED']);

export type PipeWriteResult = 'ok' | 'not_found' | 'timeout' | 'error';

/**
 * 探测命名管道是否存在：瞬时连接，成功立即断开。
 * 返回 false 涵盖「不存在 / 连接被拒 / 超时」等一切不可用情形（伪代码 pipe_exists）。
 */
export function probePipe(pipePath: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect(pipePath);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();

    function finish(exists: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(exists);
    }

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * 连接命名管道并写入一条完整消息。
 * - 连接 + 写入在 timeoutMs 内完成才返回 'ok'（写入回调即数据已提交系统管道缓冲）；
 * - 超时返回 'timeout'；管道不存在返回 'not_found'；其余失败返回 'error'。
 * 永不 reject，调用方无需 try/catch（转发器失败放行）。
 */
export function writeToPipe(
  pipePath: string,
  data: string,
  timeoutMs: number = DEFAULT_PIPE_TIMEOUT_MS,
): Promise<PipeWriteResult> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect(pipePath);
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    timer.unref();

    function finish(result: PipeWriteResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    }

    socket.once('connect', () => {
      socket.write(data, (err) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code ?? '';
          finish(PIPE_NOT_FOUND_CODES.has(code) ? 'not_found' : 'error');
        } else {
          finish('ok');
        }
      });
    });

    socket.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      finish(PIPE_NOT_FOUND_CODES.has(code) ? 'not_found' : 'error');
    });
  });
}
