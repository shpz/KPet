/**
 * 守护进程拉起防并发风暴测试：独占锁互斥、释放后可重抢、陈旧锁 TTL 接管（§3.3）。
 * 不真正 spawn 进程，只测锁文件语义。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { DAEMON_LOCK_TTL_MS, acquireDaemonLock, getDaemonLockPath, resolveDaemonPath } from '../src/bridge/daemon.js';

function tempLockPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-pet-lock-test-'));
  return path.join(dir, 'daemon.lock');
}

test('acquireDaemonLock：并发互斥 —— 已持有锁时第二次获取失败', () => {
  const lock = tempLockPath();
  try {
    const release = acquireDaemonLock(lock);
    assert.ok(release, '第一次应拿到锁');
    assert.equal(acquireDaemonLock(lock), null, '锁未释放时第二次应失败（防并发风暴）');
    release!();
    assert.ok(acquireDaemonLock(lock), '释放后可重新获取');
  } finally {
    fs.rmSync(path.dirname(lock), { recursive: true, force: true });
  }
});

test('acquireDaemonLock：陈旧锁（超过 TTL）可接管', () => {
  const lock = tempLockPath();
  try {
    fs.writeFileSync(lock, ''); // 模拟持有者崩溃残留的锁文件（未走 release 删除路径）
    assert.equal(acquireDaemonLock(lock), null, '刚残留的锁仍有效期内，不可接管');
    fs.utimesSync(lock, new Date(Date.now() - DAEMON_LOCK_TTL_MS - 1000), new Date(Date.now() - DAEMON_LOCK_TTL_MS - 1000));
    assert.ok(acquireDaemonLock(lock), '超过 TTL 的陈旧锁可接管（崩溃残留不阻塞拉起）');
  } finally {
    fs.rmSync(path.dirname(lock), { recursive: true, force: true });
  }
});

test('acquireDaemonLock：父目录不存在时自动创建', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-pet-lock-test-'));
  const lock = path.join(base, 'kimi-pet', 'daemon.lock'); // 父目录不存在
  try {
    const release = acquireDaemonLock(lock);
    assert.ok(release, '父目录不存在也应能拿到锁（自动创建目录）');
    assert.ok(fs.existsSync(lock), '锁文件已创建');
    release!();
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolveDaemonPath：优先 KIMI_PLUGIN_ROOT，缺省相对 cwd() 推导（§3.1）', () => {
  const env = { KIMI_PLUGIN_ROOT: 'C:\\plugins\\kimi-pet' } as NodeJS.ProcessEnv;
  assert.equal(resolveDaemonPath(env), path.join('C:\\plugins\\kimi-pet', 'bin', 'kimi-petd.exe'));
  assert.equal(resolveDaemonPath({}), path.join(process.cwd(), 'bin', 'kimi-petd.exe'));
});

test('getDaemonLockPath：%TEMP%/kimi-pet/daemon.lock（独立于事件暂存目录）', () => {
  assert.equal(getDaemonLockPath('C:\\Temp'), path.join('C:\\Temp', 'kimi-pet', 'daemon.lock'));
});
