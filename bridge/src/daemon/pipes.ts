/**
 * 命名管道服务端与行分帧（线上约定）。
 *
 * 线上约定：全部进程间消息 = UTF-8 JSON 对象 + \n 行分帧（node:net 命名管道是字节流而非消息模式，
 * 转发器每条消息已追加 \n —— 见 bridge/src/bridge/main.ts 文件头注释）。守护进程两端都按行分帧解析。
 *
 * 管道访问控制：node:net 创建的命名管道继承进程默认安全描述符 —— 守护进程以当前用户
 * 身份运行，其默认 DACL 只允许当前用户访问，天然满足「仅当前用户可读写」；不做额外 ACL 设置。
 *
 * 分帧注意：
 * - 用 StringDecoder 解码，避免多字节 UTF-8 字符（如命令文本中的中文）跨 chunk 断裂成乱码；
 * - 每条连接独立缓冲（PreToolUse 风暴时多条转发器并发连接互不干扰）；
 * - 单行超过 2×64KB（消息上限的两倍）视为异常帧：丢弃缓冲并计错误。
 */
import * as net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { MAX_MESSAGE_BYTES } from '../protocol/index.js';

/** 帧分隔符（与转发器约定的行分帧换行符）。 */
export const FRAME_DELIMITER = '\n';

/** 单行缓冲上限：协议单条消息 64KB，留一倍余量后仍超则判异常帧。 */
export const MAX_LINE_BYTES = MAX_MESSAGE_BYTES * 2;

/**
 * 给单个 socket 挂接行分帧（线上约定）：
 * 每条连接独立累积缓冲，按 \n 切出完整行回调 onLine（空行跳过）；连接断开时若还有未换行的残留
 * 也回调一次（多半是非法 JSON，由收方错误计数）。
 * 供事件管道服务端（createLineFramedServer）与控制管道会话（ControlSession）共用。
 */
export function attachLineFraming(socket: net.Socket, onLine: (line: string) => void): void {
  const decoder = new StringDecoder('utf8');
  let buf = '';

  socket.on('data', (chunk: Buffer) => {
    buf += decoder.write(chunk);
    // 异常帧防御：超长且未换行，丢弃缓冲（该连接大概率是恶意/损坏发送方）
    if (buf.length > MAX_LINE_BYTES) {
      buf = '';
      return;
    }
    let idx = buf.indexOf(FRAME_DELIMITER);
    while (idx >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, ''); // 宽容处理 \r\n
      buf = buf.slice(idx + 1);
      if (line.length > 0) onLine(line);
      idx = buf.indexOf(FRAME_DELIMITER);
    }
  });

  socket.on('end', () => {
    buf += decoder.end();
    const tail = buf.replace(/\r$/, '');
    if (tail.length > 0) onLine(tail); // 未换行的残留帧：多为非法 JSON，交由收方计数
    buf = '';
  });
}

/**
 * 创建一个按行分帧的命名管道服务端（事件管道：转发器 → 守护进程）。
 * 瞬时探测连接（转发器 probePipe 连接后立即断开）与对端异常断线都可能带错误，静默忽略。
 */
export function createLineFramedServer(pipeName: string, onLine: (line: string) => void): net.Server {
  const server = net.createServer((socket) => {
    attachLineFraming(socket, onLine);
    socket.on('error', () => {});
  });
  server.on('error', () => {});
  return server;
}
