import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  isAbsoluteSessionDir,
  MAX_SESSION_CATALOG_ENTRIES,
  mergeSessionSnapshots,
  readSessionCatalog,
  resolveSessionIndexPath,
  SESSION_STATE_FILE,
  type SessionCatalogEntry,
  type SessionCatalogReadFile,
} from '../src/daemon/session-catalog.js';

const SESSION_PANEL_PATH = fileURLToPath(new URL('../../../Pet/Content/UI/Web/session-panel.html', import.meta.url));

class PanelTestClassList {
  add(..._tokens: string[]): void {}
  remove(..._tokens: string[]): void {}
  toggle(_token: string, _force?: boolean): boolean { return false; }
}

class PanelTestElement {
  textContent = '';
  hidden = false;
  type = '';
  title = '';
  className = '';
  dataset: Record<string, string> = {};
  style: { animationDelay?: string; opacity?: string } = {};
  classList = new PanelTestClassList();
  clientHeight = 0;
  scrollHeight = 0;

  get offsetWidth(): number { return 0; }
  append(..._children: PanelTestElement[]): void {}
  appendChild(child: PanelTestElement): PanelTestElement { return child; }
  setAttribute(_name: string, _value: string): void {}
  addEventListener(_name: string, _listener: unknown): void {}
  closest(_selector: string): PanelTestElement | null { return null; }
}

interface PanelSessionState {
  sessionId: string;
  active: boolean;
  working: boolean;
  unread: boolean;
}

interface TestPanelApi {
  applySnapshot(items: Array<Record<string, unknown>>): void;
  setActive(sessionId: string, active: boolean): void;
  __kimiPetTestSnapshot(): PanelSessionState[];
  __kimiPetTestSelect(sessionId: string): void;
}

function loadSessionPanelForTest(): TestPanelApi {
  const elements = new Map<string, PanelTestElement>([
    ['sessionList', new PanelTestElement()],
    ['panelCount', new PanelTestElement()],
    ['emptyState', new PanelTestElement()],
    ['btnClose', new PanelTestElement()],
  ]);
  const panelDocument = {
    body: new PanelTestElement(),
    documentElement: new PanelTestElement(),
    getElementById(id: string): PanelTestElement | null { return elements.get(id) ?? null; },
    createElement(_tagName: string): PanelTestElement { return new PanelTestElement(); },
  };
  const sandbox: Record<string, unknown> = {
    document: panelDocument,
    console: { warn: () => undefined },
    performance: { now: () => 0 },
    requestAnimationFrame: (_callback: () => void) => 0,
    cancelAnimationFrame: (_id: number) => undefined,
  };
  sandbox['window'] = sandbox;

  const html = fs.readFileSync(SESSION_PANEL_PATH, 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('未找到会话面板脚本');
  vm.runInNewContext(
    `${script}\nwindow.KimiPetPanel.__kimiPetTestSnapshot = () => Array.from(sessions.values()).map((item) => ({ ...item }));\nwindow.KimiPetPanel.__kimiPetTestSelect = (sessionId) => { const item = sessions.get(String(sessionId)); if (item) selectSession(item); };`,
    sandbox,
    { filename: SESSION_PANEL_PATH },
  );
  return sandbox['KimiPetPanel'] as TestPanelApi;
}

function panelStates(panel: TestPanelApi): PanelSessionState[] {
  return Array.from(panel.__kimiPetTestSnapshot(), ({ sessionId, active, working, unread }) => ({ sessionId, active, working, unread }));
}

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

test('会话面板：点击与结束只影响目标会话，多会话工作态保持', () => {
  const panel = loadSessionPanelForTest();
  panel.applySnapshot([
    { sessionId: 's1', title: '会话一', cwd: 'D:\\one', active: true, working: true, unread: true },
    { sessionId: 's2', title: '会话二', cwd: 'D:\\two', active: true, working: true, unread: true },
  ]);

  panel.__kimiPetTestSelect('s1');
  assert.deepEqual(panelStates(panel), [
    { sessionId: 's1', active: true, working: true, unread: false },
    { sessionId: 's2', active: true, working: true, unread: true },
  ], '点击行只能清目标 unread，不能覆盖任一会话的 active/working');

  panel.setActive('s1', false);
  assert.deepEqual(panelStates(panel), [
    { sessionId: 's1', active: false, working: false, unread: false },
    { sessionId: 's2', active: true, working: true, unread: true },
  ], '结束 s1 时只能清 s1 的 active/working，s2 必须继续工作');
});

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

test('readSessionCatalog：先按工作目录折叠，再限制 50 条', () => {
  const repeatedCount = MAX_SESSION_CATALOG_ENTRIES + 3;
  const records = [
    ...Array.from({ length: repeatedCount }, (_, index) => ({
      sessionId: `same-workspace-${index}`,
      title: `重复会话${index}`,
      cwd: index % 2 === 0 ? 'D:/Workspace/KimiPet' : 'd:\\workspace\\kimipet\\',
      updatedAt: 10_000 - index,
    })),
    { sessionId: 'older-other-workspace', title: '较早的其他工程', cwd: 'D:\\Workspace\\Other', updatedAt: 1 },
  ];
  const indexPath = writeFixture(records);
  try {
    const result = readSessionCatalog({ indexPath });
    assert.deepEqual(result, [
      {
        sessionId: 'same-workspace-0', title: '重复会话0', cwd: 'D:/Workspace/KimiPet', updatedAt: 10_000,
      },
      {
        sessionId: 'older-other-workspace', title: '较早的其他工程', cwd: 'D:\\Workspace\\Other', updatedAt: 1,
      },
    ]);
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
      session_id: 'active', title: '活跃标题', cwd: 'D:\\current', active: true,
      working: true, unread: true, updated_at: 100,
    },
    {
      session_id: 'new-active', title: '', cwd: 'D:\\new', active: true,
      working: false, unread: false, updated_at: 0,
    },
    {
      session_id: 'h1', title: '历史一', cwd: 'D:\\history1', active: false,
      working: false, unread: false, updated_at: 200,
    },
  ]);
});

test('mergeSessionSnapshots：同一工程的历史会话只保留最近一条', () => {
  const history: SessionCatalogEntry[] = [
    { sessionId: 'recent', title: '最近会话', cwd: 'D:/Workspace/KimiPet', updatedAt: 300 },
    { sessionId: 'older', title: '旧会话', cwd: 'd:\\workspace\\kimipet\\', updatedAt: 200 },
    { sessionId: 'other', title: '其他工程', cwd: 'D:\\Workspace\\Other', updatedAt: 100 },
  ];

  assert.deepEqual(mergeSessionSnapshots(history, []), [
    {
      session_id: 'recent', title: '最近会话', cwd: 'D:/Workspace/KimiPet', active: false,
      working: false, unread: false, updated_at: 300,
    },
    {
      session_id: 'other', title: '其他工程', cwd: 'D:\\Workspace\\Other', active: false,
      working: false, unread: false, updated_at: 100,
    },
  ]);
});

test('mergeSessionSnapshots：活跃会话不折叠，并覆盖同工程历史副本', () => {
  const history: SessionCatalogEntry[] = [
    { sessionId: 'history', title: '历史副本', cwd: 'D:\\Workspace\\KimiPet', updatedAt: 100 },
    { sessionId: 'other', title: '其他工程', cwd: 'D:\\Workspace\\Other', updatedAt: 90 },
  ];
  const active = [
    { sessionId: 'active-one', cwd: 'D:/Workspace/KimiPet', busy: true, unread: false },
    { sessionId: 'active-two', cwd: 'd:\\workspace\\kimipet\\', busy: false, unread: true },
  ];

  assert.deepEqual(mergeSessionSnapshots(history, active), [
    {
      session_id: 'active-one', title: '', cwd: 'D:/Workspace/KimiPet', active: true,
      working: true, unread: false, updated_at: 0,
    },
    {
      session_id: 'active-two', title: '', cwd: 'd:\\workspace\\kimipet\\', active: true,
      working: false, unread: true, updated_at: 0,
    },
    {
      session_id: 'other', title: '其他工程', cwd: 'D:\\Workspace\\Other', active: false,
      working: false, unread: false, updated_at: 90,
    },
  ]);
});

test('mergeSessionSnapshots：活跃会话优先且合并后仍严格限制为 50 条', () => {
  const history: SessionCatalogEntry[] = Array.from({ length: MAX_SESSION_CATALOG_ENTRIES }, (_, index) => ({
    sessionId: `history-${index}`,
    title: `历史 ${index}`,
    cwd: `D:\\history-${index}`,
    updatedAt: MAX_SESSION_CATALOG_ENTRIES - index,
  }));
  const merged = mergeSessionSnapshots(history, [
    { sessionId: 'active-only', cwd: 'D:\\active', busy: true, unread: false },
  ]);

  assert.equal(merged.length, MAX_SESSION_CATALOG_ENTRIES);
  assert.deepEqual(merged[0], {
    session_id: 'active-only', title: '', cwd: 'D:\\active', active: true,
    working: true, unread: false, updated_at: 0,
  });
  assert.equal(merged.some((item) => item.session_id === 'history-49'), false, '最旧历史项被淘汰');
});

test('isAbsoluteSessionDir：识别 POSIX、盘符与 UNC 绝对路径，相对路径不误判', () => {
  // POSIX 绝对路径（WSL 与 macOS 的会话目录）
  assert.equal(isAbsoluteSessionDir('/home/user/.kimi-code/sessions/x'), true);
  assert.equal(isAbsoluteSessionDir('/mnt/c/Users/user/proj'), true);
  // Windows 盘符路径（正反斜杠均可）与 UNC
  assert.equal(isAbsoluteSessionDir('D:\\projects\\pet'), true);
  assert.equal(isAbsoluteSessionDir('D:/projects/pet'), true);
  assert.equal(isAbsoluteSessionDir('\\\\wsl.localhost\\Ubuntu\\home\\user\\proj'), true);
  // 相对路径保持相对，交由 indexDir 解析
  assert.equal(isAbsoluteSessionDir('sessions/x'), false);
  assert.equal(isAbsoluteSessionDir('.kimi-code/sessions/x'), false);
});

test('readSessionCatalog：POSIX 绝对路径 sessionDir 按原样拼接 state.json 读取', () => {
  const indexPath = path.join('catalog-index', 'session_index.jsonl');
  const records = [
    { sessionId: 'posix-home', sessionDir: '/home/user/.kimi-code/sessions/posix-home', workDir: '/home/user/proj' },
    { sessionId: 'posix-mnt', sessionDir: '/mnt/c/Users/user/.kimi-code/sessions/posix-mnt', workDir: '/mnt/c/Users/user/proj' },
  ];
  const requestedPaths: string[] = [];
  const readFile: SessionCatalogReadFile = (filePath) => {
    requestedPaths.push(filePath);
    if (filePath === indexPath) return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    const record = records.find((candidate) => filePath === path.join(candidate.sessionDir, SESSION_STATE_FILE));
    if (record) return JSON.stringify({ title: record.sessionId, cwd: record.workDir, updatedAt: 1, archived: false });
    throw new Error(`读取了预期外的路径: ${filePath}`);
  };
  const entries = readSessionCatalog({ indexPath, readFile });
  // 两条记录 updatedAt 相同，按排序规则（updatedAtMs 倒序、同值按 ordinal 倒序）
  // 后写入索引的 posix-mnt 应排在 posix-home 之前。
  assert.deepEqual(entries, records.map((record) => ({
    sessionId: record.sessionId,
    title: record.sessionId,
    cwd: record.workDir,
    updatedAt: 1,
  })).reverse());
  // state.json 应按 POSIX 绝对路径原样请求，而不是被归并到 indexDir 下。
  assert.deepEqual(
    requestedPaths.filter((filePath) => filePath.endsWith(SESSION_STATE_FILE)),
    records.map((record) => path.join(record.sessionDir, SESSION_STATE_FILE)),
  );
});
