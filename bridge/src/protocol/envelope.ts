/**
 * 消息信封：
 *
 *   { "v": 1, "type": "task_start", "id": "9f2c1a-…", "ts": "2026-07-30T10:00:00.123Z",
 *     "session_id": "session_abc", "payload": {} }
 *
 * - v：协议主版本，当前固定 1
 * - type：消息类型
 * - id：消息唯一标识（可选，用于去重和日志关联）
 * - ts：ISO 8601 UTC 时间戳
 * - session_id：关联的宿主会话，与会话无关的消息为 null
 * - payload：消息体，字段与消息类型表一一对应
 *
 * 编码 UTF-8；一条管道消息 = 一个完整 JSON 对象（单条上限 64KB）。
 */
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type MessageType, type PayloadMap } from './types.js';

export interface MessageEnvelope<T extends MessageType = MessageType> {
  v: typeof PROTOCOL_VERSION;
  type: T;
  id?: string;
  ts: string;
  session_id: string | null;
  payload: PayloadMap[T];
}

export interface CreateEnvelopeOptions {
  /** 消息唯一标识；缺省自动生成 UUID（id 为可选字段）。 */
  id?: string;
  /** 关联的宿主会话；缺省取 payload.session_id（如 open_tui），都没有则为 null。 */
  session_id?: string | null;
  /** 时间戳；缺省当前 UTC 时间。 */
  ts?: string;
}

/** 构造一个协议信封。id 缺省自动生成，便于去重与日志关联。 */
export function createEnvelope<T extends MessageType>(
  type: T,
  payload: PayloadMap[T],
  options: CreateEnvelopeOptions = {},
): MessageEnvelope<T> {
  const payloadSessionId = (payload as { session_id?: unknown }).session_id;
  const sessionId =
    options.session_id !== undefined ? options.session_id : typeof payloadSessionId === 'string' ? payloadSessionId : null;
  return {
    v: PROTOCOL_VERSION,
    type,
    id: options.id ?? randomUUID(),
    ts: options.ts ?? new Date().toISOString(),
    session_id: sessionId,
    payload,
  };
}

/**
 * 从宿主事件对象提取 session_id（宿主事件基础字段之一）。
 * 缺失或非字符串一律返回 null —— 转发器不依赖任何具体字段。
 */
export function extractHostSessionId(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const sid = (parsed as Record<string, unknown>).session_id;
  return typeof sid === 'string' ? sid : null;
}

/**
 * 把宿主事件原始 JSON 包装成 host_event 信封：
 * - payload._raw：宿主事件 JSON 的原始文本，整体透传，不解析、不重排、不做任何语义处理
 * - session_id：从解析后的宿主事件中提取，缺失为 null
 */
export function createHostEventEnvelope(
  rawJson: string,
  parsed?: unknown,
  options: Omit<CreateEnvelopeOptions, 'session_id'> = {},
): MessageEnvelope<'host_event'> {
  return createEnvelope('host_event', { _raw: rawJson }, {
    ...options,
    session_id: extractHostSessionId(parsed),
  });
}

/** 信封校验结果。 */
export type EnvelopeValidation =
  | { ok: true; envelope: MessageEnvelope }
  | { ok: false; errors: string[] };

/**
 * 校验一个反序列化后的对象是否为合法信封。
 *
 * 规则：
 * - v 必须为 1；type 必须为非空字符串（未知类型视为结构合法，由收方按「忽略并记日志」处理）；
 * - ts 必须为可解析的时间字符串；session_id 必须为 string 或 null；payload 必须为普通对象；
 * - id 可选；字段级只增不改，未知字段一律忽略。
 *
 * payload 内字段不做深校验：解析端按「缺失取默认值、未知忽略」处理。
 */
export function validateEnvelope(input: unknown): EnvelopeValidation {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['envelope 必须是 JSON 对象'] };
  }
  const obj = input as Record<string, unknown>;

  if (obj.v !== PROTOCOL_VERSION) errors.push(`v 必须为 ${PROTOCOL_VERSION}`);
  if (typeof obj.type !== 'string' || obj.type.length === 0) errors.push('type 必须为非空字符串');
  if (typeof obj.ts !== 'string' || Number.isNaN(Date.parse(obj.ts))) errors.push('ts 必须为可解析的时间字符串');
  if (obj.session_id !== null && typeof obj.session_id !== 'string') errors.push('session_id 必须为字符串或 null');
  if (obj.id !== undefined && typeof obj.id !== 'string') errors.push('id 若存在必须为字符串');
  if (typeof obj.payload !== 'object' || obj.payload === null || Array.isArray(obj.payload)) {
    errors.push('payload 必须为对象');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, envelope: obj as unknown as MessageEnvelope };
}
