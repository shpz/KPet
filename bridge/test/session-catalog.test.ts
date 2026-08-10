import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  MAX_SESSION_CATALOG_ENTRIES,
  mergeSessionSnapshots,
  readSessionCatalog,
  resolveSessionIndexPath,
  type SessionCatalogEntry,
} from '../src/daemon/session-catalog.js';

function writeFixture(records: Array<{ sessionId: string; title: string; cwd: string; updatedAt: number; archived?: boolean }>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-pet-session-catalog-'));
  const lines: string[] = [];
  for (const record of records) {
    const dir = path.join(root, record.sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        title: record.title,
        cwd: record.cwd,
        updatedAt: record.updatedAt,
        archived: record.archived ?? false,
      }),
      'utf8',
    );
    lines.push(JSON.stringify({ sessionId: record.sessionId, sessionDir: dir, workDir: record.cwd }));
  }
  const indexPath = path.join(root, 'session_index.jsonl');
  fs.writeFileSync(indexPath, `${lines.join('\n')}\n`, 'utf8');
  return indexPath;
}

test('resolveSessionIndexPath：优先 KIMI_CODE_HOME，否则回退用户目录', () => {
  assert.equal(resolveSessionIndexPath({ KIMI_CODE_HOME: 'D:\\kimi' }), path.join('D:\\kimi', 'session_index.jsonl'));
  assert.equal(resolveSessionIndexPath({}), path.join(os.homedir(), '.kimi-code', 'session_index.jsonl'));
});

test('readSessionCatalog：读取 state、过滤非法和归档、去重并按更新时间倒序限制 50 条', () => {
  const indexPath = writeFixture([
    { sessionId: 'old', title: '旧', cwd: 'D:\\old', updatedAt: 1000 },
    { sessionId: 'new', title: '新', cwd: 'D:\\new', updatedAt: 3000 },
    { sessionId: 'old', title: '旧更新', cwd: 'D:\\old2', updatedAt: 2000 },
    { sessionId: 'archived', title: '归档', cwd: 'D:\\archived', updatedAt: 4000, archived: true },
  ]);
  try {
    const result = readSessionCatalog({ indexPath });
    assert.deepEqual(result, [
      { sessionId: 'new', title: '新', cwd: 'D:\\new', updatedAt: 3000 },
      { sessionId: 'old', title: '旧更新', cwd: 'D:\\old2', updatedAt: 2000 },
    ]);
  } finally {
    fs.rmSync(path.dirname(indexPath), { recursive: true, force: true });
  }
});

test('readSessionCatalog：坏行、缺少 state 和错误字段不会阻断其他记录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-pet-session-catalog-invalid-'));
  const goodDir = path.join(root, 'good');
  fs.mkdirSync(goodDir);
  fs.writeFileSync(path.join(goodDir, 'state.json'), JSON.stringify({ title: '正常', cwd: 'D:\\good', updatedAt: 10, archived: false }));
  const missingDir = path.join(root, 'missing');
  const indexPath = path.join(root, 'session_index.jsonl');
  fs.writeFileSync(
    indexPath,
    [
      '{not-json}',
      JSON.stringify({ sessionId: 'missing-fields', sessionDir: missingDir, workDir: 'D:\\missing' }),
      JSON.stringify({ sessionId: 'good', sessionDir: goodDir, workDir: 'D:\\good' }),
      JSON.stringify({ sessionId: '', sessionDir: goodDir, workDir: 'D:\\bad' }),
    ].join('\n'),
  );
  try {
    assert.deepEqual(readSessionCatalog({ indexPath }), [
      { sessionId: 'good', title: '正常', cwd: 'D:\\good', updatedAt: 10 },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionCatalog：兼容旧版 state 缺少 cwd/archived，使用索引 workDir 和未归档默认值', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-pet-session-catalog-legacy-'));
  const dir = path.join(root, 'legacy');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ title: '旧版', updatedAt: '2026-08-10T00:00:00.000Z' }));
  const indexPath = path.join(root, 'session_index.jsonl');
  fs.writeFileSync(indexPath, JSON.stringify({ sessionId: 'legacy', sessionDir: dir, workDir: 'D:\\legacy' }));
  try {
    assert.deepEqual(readSessionCatalog({ indexPath }), [
      { sessionId: 'legacy', title: '旧版', cwd: 'D:\\legacy', updatedAt: Date.parse('2026-08-10T00:00:00.000Z') },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionCatalog：最多返回 50 条', () => {
  const records = Array.from({ length: MAX_SESSION_CATALOG_ENTRIES + 3 }, (_, i) => ({
    sessionId: `s${i}`,
    title: `会话${i}`,
    cwd: `D:\\w${i}`,
    updatedAt: i,
  }));
  const indexPath = writeFixture(records);
  try {
    const result = readSessionCatalog({ indexPath });
    assert.equal(result.length, MAX_SESSION_CATALOG_ENTRIES);
    assert.equal(result[0]!.sessionId, `s${records.length - 1}`);
    assert.equal(result.at(-1)!.sessionId, 's3');
  } finally {
    fs.rmSync(path.dirname(indexPath), { recursive: true, force: true });
  }
});

test('mergeSessionSnapshots：合并历史与活跃状态，保持 active/working/unread 且活跃 cwd 优先', () => {
  const history: SessionCatalogEntry[] = [
    { sessionId: 'h1', title: '历史一', cwd: 'D:\\history1', updatedAt: 200 },
    { sessionId: 'active', title: '活跃标题', cwd: 'D:\\history', updatedAt: 100 },
  ];
  const merged = mergeSessionSnapshots(history, [
    { sessionId: 'active', cwd: 'D:\\current', busy: true, unread: true },
    { sessionId: 'new-active', cwd: 'D:\\new', busy: false, unread: false },
  ]);
  assert.deepEqual(merged, [
    {
      session_id: 'h1', title: '历史一', cwd: 'D:\\history1', active: false,
      working: false, unread: false, updated_at: 200,
    },
    {
      session_id: 'active', title: '活跃标题', cwd: 'D:\\current', active: true,
      working: true, unread: true, updated_at: 100,
    },
    {
      session_id: 'new-active', title: 'new-active', cwd: 'D:\\new', active: true,
      working: false, unread: false, updated_at: 0,
    },
  ]);
});
