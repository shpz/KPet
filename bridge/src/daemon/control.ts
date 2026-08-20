/**
 * 控制管道会话（§4.1 控制管道为 Windows 命名管道 \\.\pipe\KimiPet.PET.<用户名>，守护进程为服务端，渲染进程主动连入）。
 *
 * - 双向按行分帧（线上约定：JSON + \n）；
 * - 建连后首条必须是 hello（§4.3），由调用方在 onHello 中回 hello + 补发快照（§4.5-1/4）；
 *   首条不是 hello → 回 protocol_error 并断开（§4.4）；
 * - 主版本不一致 → 按较低版本降级并记日志（§4.4，MVP 双方均为 v1，降级无实际影响）；
 * - 非法 JSON / 缺信封字段：跳过该条、回 protocol_error（raw_excerpt 截断 256 字符）、错误计数 +1（§4.4）；
 * - 未知消息类型：忽略并记日志（§4.2 向前兼容）；
 * - 心跳：任意合法消息都视为存活（heartbeat 每 3s 一次），超时判定由调用方的周期检查完成。
 */
import * as net from 'node:net';
import { createEnvelope, validateEnvelope, type MessageEnvelope } from '../protocol/index.js';
import {
  MAX_RAW_EXCERPT_CHARS,
  PROTOCOL_VERSION,
  type ClosePetPayload,
  type HelloPayload,
  type OpenTuiPayload,
  type PetMovedPayload,
  type UpdateConfigPayload,
} from '../protocol/types.js';
import type { Logger } from './logger.js';
import { attachLineFraming, FRAME_DELIMITER } from './pipes.js';

export interface ControlCallbacks {
  /** 握手完成（收到合法 hello）后回调；调用方回 hello 并补发快照。 */
  onHello(payload: HelloPayload): void;
  onOpenTui(payload: OpenTuiPayload): void;
  onPetMoved(payload: PetMovedPayload): void;
  /** 设置 WebUI 保存；守护进程校验合并后写回配置并回推 config_snapshot。 */
  onUpdateConfig(payload: UpdateConfigPayload): void;
  /** 渲染进程请求用户关闭；守护进程应先持久化抑制标记再退出。 */
  onClosePet(payload: ClosePetPayload): void;
  /** 连接关闭（对端断开/主动 close）后回调。 */
  onClosed(): void;
}

export interface ControlSessionOptions {
  logger: Logger;
  /** 非法消息回调：调用方统一计入错误计数（§4.4 连续超阈值告警）。 */
  onProtocolError(description: string): void;
}

export class ControlSession {
  readonly socket: net.Socket;
  private readonly logger: Logger;
  private readonly onProtocolError: (description: string) => void;
  private readonly callbacks: ControlCallbacks;
  private helloReceived = false;
  private closed = false;
  /** 最近一次收到合法消息的时间（epoch ms），调用方周期检查是否超时。 */
  lastRxAt = Date.now();

  constructor(socket: net.Socket, callbacks: ControlCallbacks, opts: ControlSessionOptions) {
    this.socket = socket;
    this.callbacks = callbacks;
    this.logger = opts.logger;
    this.onProtocolError = opts.onProtocolError;

    attachLineFraming(socket, (line) => this.handleLine(line));
    socket.on('error', () => {
      // 对端异常断线：由 close 路径统一收尾
    });
    socket.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.callbacks.onClosed();
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 发送一条信封（+ \n 分帧）。已关闭或写入失败返回 false（调用方记日志，渲染进程失联走重启路径）。 */
  send(envelope: MessageEnvelope): boolean {
    if (this.closed) return false;
    try {
      this.socket.write(JSON.stringify(envelope) + FRAME_DELIMITER, (err) => {
        if (err) {
          this.logger.warn(`控制管道写入失败: ${err.message}`);
          this.close();
        }
      });
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  /** 发送最后一条消息并半关闭写端，确保 shutdown 在销毁管道前刷出。 */
  sendAndClose(envelope: MessageEnvelope): boolean {
    if (this.closed) return false;
    this.closed = true;
    try {
      this.socket.end(JSON.stringify(envelope) + FRAME_DELIMITER);
      return true;
    } catch {
      this.socket.destroy();
      return false;
    }
  }

  /** 主动关闭（心跳超时判死/被新连接替换/守护进程退出）。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.reject(`非法 JSON: ${excerpt(line)}`, line);
      return;
    }
    const validation = validateEnvelope(parsed);
    if (!validation.ok) {
      this.reject(`信封校验失败: ${validation.errors.join('; ')}`, line);
      return;
    }
    const env = validation.envelope;
    this.lastRxAt = Date.now(); // 任意合法消息都视为存活

    switch (env.type) {
      case 'hello': {
        if (this.helloReceived) break; // 重复 hello 忽略
        this.helloReceived = true;
        const payload = env.payload as HelloPayload;
        if (payload.role !== 'renderer') {
          this.reject(`hello.role 必须是 "renderer"，收到 ${JSON.stringify(payload.role)}`, line);
          this.close(); // 握手失败：不是渲染进程，断开
          return;
        }
        if (payload.protocol_version !== PROTOCOL_VERSION) {
          // §4.4：主版本不一致按较低版本降级（MVP 双方均为 v1，全部消息通用）
          this.logger.warn(
            `协议版本协商: 渲染进程 v${payload.protocol_version}，本进程 v${PROTOCOL_VERSION}，按较低版本降级`,
          );
        }
        this.callbacks.onHello(payload);
        break;
      }
      case 'heartbeat':
        this.logger.debug(
          `心跳 pid=${(env.payload as { pid?: unknown }).pid} uptime=${(env.payload as { uptime_s?: unknown }).uptime_s}s`,
        );
        break;
      case 'open_tui':
        this.callbacks.onOpenTui(env.payload as OpenTuiPayload);
        break;
      case 'pet_moved':
        this.callbacks.onPetMoved(env.payload as PetMovedPayload);
        break;
      case 'update_config':
        this.callbacks.onUpdateConfig(env.payload as UpdateConfigPayload);
        break;
      case 'close_pet':
        this.callbacks.onClosePet(env.payload as ClosePetPayload);
        break;
      case 'protocol_error':
        // 对端报告协议错误：仅日志
        this.logger.warn(
          `渲染进程报告 protocol_error: ${JSON.stringify((env.payload as { description?: unknown }).description ?? '')}`,
        );
        break;
      default:
        // 收到守护进程→渲染进程方向的消息类型：记日志忽略（§4.2）
        this.logger.debug(`收到意外消息类型 ${env.type}，忽略`);
        break;
    }
  }

  private reject(description: string, rawLine: string): void {
    this.onProtocolError(description);
    if (this.closed) return;
    this.send(
      createEnvelope('protocol_error', {
        description,
        raw_excerpt: excerpt(rawLine),
      }),
    );
  }
}

/** 摘录截断（§4.3 protocol_error.raw_excerpt：截断 256 字符）。 */
function excerpt(line: string): string {
  return line.length > MAX_RAW_EXCERPT_CHARS ? line.slice(0, MAX_RAW_EXCERPT_CHARS) : line;
}
