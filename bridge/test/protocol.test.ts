/**
 * 协议包单测：信封构造 / 校验 / _raw 透传 / session_id 提取 / 消息类型表。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  createEnvelope,
  createHostEventEnvelope,
  extractHostSessionId,
  isKnownType,
  validateEnvelope,
} from '../src/protocol/index.js';

test('createEnvelope 构造合法信封（§4.2 字段齐全）', () => {
  const env = createEnvelope('task_start', { task_id: 't1', title: '运行测试', tool: 'Bash' });
  assert.equal(env.v, PROTOCOL_VERSION);
  assert.equal(env.type, 'task_start');
  assert.ok(env.id, 'id 缺省自动生成');
  assert.match(env.id!, /^[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(env.ts)), 'ts 为可解析时间');
  assert.equal(new Date(env.ts).toISOString(), env.ts, 'ts 为 ISO 8601 UTC');
  assert.equal(env.session_id, null, 'payload 无 session_id 时信封 session_id 为 null');
  assert.deepEqual(env.payload, { task_id: 't1', title: '运行测试', tool: 'Bash' });
});

test('createEnvelope 支持显式 id / session_id / ts', () => {
  const env = createEnvelope('notify', { text: '完成', level: 'success' }, {
    id: 'fixed-id',
    session_id: 'session_abc',
    ts: '2026-07-30T10:00:00.000Z',
  });
  assert.equal(env.id, 'fixed-id');
  assert.equal(env.session_id, 'session_abc');
  assert.equal(env.ts, '2026-07-30T10:00:00.000Z');
});

test('createEnvelope 从 payload.session_id 自动提取（open_tui 场景）', () => {
  const env = createEnvelope('open_tui', { session_id: 'session_xyz', source: 'pet' });
  assert.equal(env.session_id, 'session_xyz');
});

test('createHostEventEnvelope：_raw 整体透传原始文本（不解析不重排）', () => {
  const raw = '{"hook_event_name":"PreToolUse","session_id":"session_1","cwd":"D:\\\\ws", "tool_input": {"command": "npm test"}}';
  const env = createHostEventEnvelope(raw, JSON.parse(raw));
  assert.equal(env.type, 'host_event');
  assert.equal(env.payload._raw, raw, '_raw 必须与输入文本逐字符一致');
  assert.equal(env.session_id, 'session_1');
});

test('createHostEventEnvelope：宿主事件缺 session_id 时信封 session_id 为 null（字段防御）', () => {
  const raw = '{"hook_event_name":"Stop"}';
  const env = createHostEventEnvelope(raw, JSON.parse(raw));
  assert.equal(env.session_id, null);
});

test('createHostEventEnvelope：session_id 非字符串按缺失处理', () => {
  const raw = '{"hook_event_name":"Stop","session_id":123}';
  const env = createHostEventEnvelope(raw, JSON.parse(raw));
  assert.equal(env.session_id, null);
});

test('extractHostSessionId 边界', () => {
  assert.equal(extractHostSessionId({ session_id: 's' }), 's');
  assert.equal(extractHostSessionId({ session_id: 1 }), null);
  assert.equal(extractHostSessionId(null), null);
  assert.equal(extractHostSessionId('x'), null);
  assert.equal(extractHostSessionId({}), null);
});

test('validateEnvelope：合法信封通过', () => {
  const env = createEnvelope('pet_state', { state: 'Working', reason: 'user_prompt' });
  const result = validateEnvelope(JSON.parse(JSON.stringify(env)));
  assert.equal(result.ok, true);
});

test('validateEnvelope：缺信封字段逐个报错（§4.4）', () => {
  const bad = [
    [null, /必须是 JSON 对象/],
    ['str', /必须是 JSON 对象/],
    [{ v: 2, type: 'a', ts: '2026-07-30T00:00:00.000Z', session_id: null, payload: {} }, /v 必须为/],
    [{ v: 1, type: '', ts: '2026-07-30T00:00:00.000Z', session_id: null, payload: {} }, /type 必须/],
    [{ v: 1, type: 'a', ts: 'not-a-time', session_id: null, payload: {} }, /ts 必须/],
    [{ v: 1, type: 'a', ts: '2026-07-30T00:00:00.000Z', session_id: 3, payload: {} }, /session_id 必须/],
    [{ v: 1, type: 'a', ts: '2026-07-30T00:00:00.000Z', session_id: null, payload: [] }, /payload 必须/],
    [{ v: 1, type: 'a', ts: '2026-07-30T00:00:00.000Z', session_id: null, payload: {}, id: 3 }, /id 若存在/],
  ] as const;
  for (const [input, pattern] of bad) {
    const result = validateEnvelope(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.ok(result.ok === false && result.errors.some((e) => pattern.test(e)), JSON.stringify(result));
  }
});

test('validateEnvelope：未知 type 结构合法（收方按 §4.2 忽略并记日志）', () => {
  const input = { v: 1, type: 'future_msg', ts: '2026-07-30T00:00:00.000Z', session_id: null, payload: {} };
  const result = validateEnvelope(input);
  assert.equal(result.ok, true);
  assert.equal(isKnownType('future_msg'), false);
});

test('validateEnvelope：id 可选，缺省信封通过（§4.2 id 可选）', () => {
  const input = { v: 1, type: 'hello', ts: '2026-07-30T00:00:00.000Z', session_id: null, payload: { protocol_version: 1, role: 'daemon', pid: 1, version: 'x', capabilities: [] } };
  const result = validateEnvelope(input);
  assert.equal(result.ok, true);
  assert.equal('id' in input, false);
});

test('isKnownType 覆盖协议全部 16 种消息类型', () => {
  assert.equal(MESSAGE_TYPES.length, 16);
  for (const t of MESSAGE_TYPES) assert.equal(isKnownType(t), true);
  assert.equal(isKnownType('nope'), false);
});
