/**
 * 终端唤起测试（docs/MVP设计.md §4.5-3）。
 * 命令构造为纯函数直接断言；openTui 的 wt 回退路径注入 spawn 模拟 ENOENT。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { buildOpenTuiCommand, openTui, type SpawnFn } from '../src/daemon/terminal.js';

/** 模拟 spawn 的假子进程（只实现用到的接口）。 */
function fakeChild(behavior: 'ok' | 'enoent' | 'error'): EventEmitter {
  const child = new EventEmitter() as EventEmitter & { unref(): void };
  child.unref = () => {};
  // error 在 spawn 事件之前触发（模拟 exe 缺失）
  queueMicrotask(() => {
    if (behavior === 'enoent') {
      child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    } else if (behavior === 'error') {
      child.emit('error', Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    } else {
      child.emit('spawn');
    }
  });
  return child;
}

test('buildOpenTuiCommand：wt 模式（§4.5-3 主路径）', () => {
  const cmd = buildOpenTuiCommand({ terminal: 'wt', cwd: 'D:\\ws', sessionId: 'session_1' });
  assert.deepEqual(cmd, {
    file: 'wt.exe',
    args: ['-d', 'D:\\ws', 'cmd', '/k', 'kimi', '--session', 'session_1'],
    cwd: 'D:\\ws',
  });
});

test('buildOpenTuiCommand：会话 id 为空 → kimi --continue（§4.5-3 恢复最近会话）', () => {
  const cmd = buildOpenTuiCommand({ terminal: 'wt', cwd: 'D:\\ws', sessionId: null });
  assert.deepEqual(cmd.args.slice(4), ['kimi', '--continue']);
});

test('buildOpenTuiCommand：cmd 模式 → cmd /c start（§4.5-3 备选）', () => {
  const cmd = buildOpenTuiCommand({ terminal: 'cmd', cwd: 'D:\\ws', sessionId: 'session_2' });
  assert.deepEqual(cmd, {
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'cmd', '/k', 'kimi', '--session', 'session_2'],
    cwd: 'D:\\ws',
  });
});

test('openTui：wt 成功 → ok + terminal=wt', async () => {
  let calls = 0;
  const spawnFn: SpawnFn = () => {
    calls++;
    return fakeChild('ok') as never;
  };
  const res = await openTui({ terminal: 'wt', cwd: 'D:\\ws', sessionId: 's1' }, spawnFn);
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'wt');
  assert.equal(calls, 1);
});

test('openTui：wt.exe 不存在（ENOENT）→ 回退 cmd /c start（§4.5-3 备选）', async () => {
  const behaviors: Array<'enoent' | 'ok'> = ['enoent', 'ok'];
  let calls = 0;
  const spawnFn: SpawnFn = () => {
    calls++;
    return fakeChild(behaviors.shift()!) as never;
  };
  const res = await openTui({ terminal: 'wt', cwd: 'D:\\ws', sessionId: 's1' }, spawnFn);
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'cmd', '回退到 cmd');
  assert.equal(calls, 2);
});

test('openTui：wt 失败且非 ENOENT（如 EACCES）→ 不回退，返回失败', async () => {
  const spawnFn: SpawnFn = () => fakeChild('error') as never;
  const res = await openTui({ terminal: 'wt', cwd: 'D:\\ws', sessionId: 's1' }, spawnFn);
  assert.equal(res.ok, false);
  assert.equal(res.terminal, 'wt');
});
