/**
 * 本地暂存写入单测（§3.3 兜底：%TEMP%/kpet-events/，文件名时间戳+随机，可排序回收）。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createEnvelope } from '../src/protocol/index.js';
import {
  buildStagingFileName,
  clearStagingBeforeTimestamp,
  getStagingDir,
  writeStaging,
} from '../src/bridge/staging.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-test-'));
}

test('writeStaging：目录不存在时自动创建并写入信封完整 JSON', () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'nested', 'kpet-events');
    const env = createEnvelope('host_event', { _raw: '{"hook_event_name":"Stop"}' });
    const file = writeStaging(env, target, new Date('2026-07-30T10:00:00.123Z'));
    assert.ok(file, '应返回写入的文件路径');
    assert.equal(path.dirname(file!), target);

    const saved = JSON.parse(fs.readFileSync(file!, 'utf8'));
    assert.equal(saved.v, 1);
    assert.equal(saved.type, 'host_event');
    assert.equal(saved.payload._raw, '{"hook_event_name":"Stop"}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildStagingFileName：时间戳前缀等宽零填充，字典序 = 时间序（可排序回收）', () => {
  const t1 = new Date('2026-07-30T09:59:59.999Z');
  const t2 = new Date('2026-07-31T00:00:00.000Z');
  const f1 = buildStagingFileName(t1, 'aaaaaaaa-0000-0000-0000-000000000000');
  const f2 = buildStagingFileName(t2, 'bbbbbbbb-0000-0000-0000-000000000000');
  assert.match(f1, /^\d{8}-\d{6}\.\d{3}-[0-9a-f]{8}\.json$/);
  assert.ok(f1 < f2, '时间早的文件名字典序在前');
});

test('buildStagingFileName：同时间戳不同随机串不冲突', () => {
  const t = new Date('2026-07-31T10:00:00.000Z');
  const f1 = buildStagingFileName(t, 'aaaaaaaa-0000-0000-0000-000000000000');
  const f2 = buildStagingFileName(t, 'bbbbbbbb-0000-0000-0000-000000000000');
  assert.notEqual(f1, f2);
});

test('writeStaging：多个事件写入后按文件名排序即按时间排序', () => {
  const dir = makeTempDir();
  try {
    const env = createEnvelope('host_event', { _raw: '{}' });
    writeStaging(env, dir, new Date('2026-07-31T01:00:00.000Z'));
    writeStaging(env, dir, new Date('2026-07-31T03:00:00.000Z'));
    writeStaging(env, dir, new Date('2026-07-31T02:00:00.000Z'));
    const files = fs.readdirSync(dir).sort();
    assert.equal(files.length, 3);
    for (let i = 1; i < files.length; i++) {
      assert.ok(files[i - 1]! < files[i]!, '排序后时间递增');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeStaging：默认时间戳严格递增，同一毫秒也保持事件顺序', () => {
  const dir = makeTempDir();
  try {
    writeStaging(createEnvelope('host_event', { _raw: '{"hook_event_name":"SessionStart"}' }), dir);
    writeStaging(createEnvelope('host_event', { _raw: '{"hook_event_name":"UserPromptSubmit"}' }), dir);
    const hooks = fs.readdirSync(dir).sort().map((file) => {
      const env = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as { payload: { _raw: string } };
      return (JSON.parse(env.payload._raw) as { hook_event_name: string }).hook_event_name;
    });
    assert.deepEqual(hooks, ['SessionStart', 'UserPromptSubmit']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clearStagingBeforeTimestamp：按文件名时间清理关闭前事件，保留恢复期新事件', () => {
  const dir = makeTempDir();
  try {
    const env = createEnvelope('host_event', { _raw: '{}' });
    writeStaging(env, dir, new Date('2026-08-12T01:00:00.000Z'));
    writeStaging(env, dir, new Date('2026-08-12T01:00:02.000Z'));
    const files = fs.readdirSync(dir).sort();
    // 故意把新文件 mtime 调到很早，验证判定不依赖 mtime。
    fs.utimesSync(path.join(dir, files[1]!), new Date(0), new Date(0));
    assert.equal(clearStagingBeforeTimestamp(dir, Date.parse('2026-08-12T01:00:01.000Z')), 1);
    assert.deepEqual(fs.readdirSync(dir), [files[1]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeStaging：目标路径不可用（已存在同名文件）时静默返回 null 不抛出', () => {
  const dir = makeTempDir();
  try {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x'); // 让 mkdirSync(recursive) 失败
    const env = createEnvelope('host_event', { _raw: '{}' });
    const result = writeStaging(env, blocker);
    assert.equal(result, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStagingDir：%TEMP%/kpet-events/', () => {
  assert.equal(getStagingDir('C:\\Temp'), path.join('C:\\Temp', 'kpet-events'));
});
