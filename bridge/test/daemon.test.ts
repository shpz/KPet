/**
 * 守护进程拉起防并发风暴测试：独占锁互斥、释放后可重抢、陈旧锁 TTL 接管。
 * 不真正 spawn 进程，只测锁文件语义。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  DELIVERY_LEASE_TTL_MS,
  DAEMON_LOCK_TTL_MS,
  acquireDeliveryLease,
  acquireDaemonLock,
  acquireOwnedDaemonLock,
  clearDaemonLockIfOwner,
  getDaemonExeName,
  getDaemonLockPath,
  getDeliveryLeaseDir,
  hasActiveDeliveryLeases,
  isStandaloneExecutable,
  refreshDaemonLock,
  resolveDaemonPath,
  scheduleDaemonRecovery,
  setPetSuppressed,
  spawnDaemonIfNeeded,
} from '../src/bridge/daemon.js';

function tempLockPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-lock-test-'));
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

test('acquireDaemonLock：陈旧持有者不得删除已被新持有者接管的锁', () => {
  const lock = tempLockPath();
  try {
    const releaseOld = acquireDaemonLock(lock);
    assert.ok(releaseOld);
    fs.utimesSync(lock, new Date(Date.now() - DAEMON_LOCK_TTL_MS - 1000), new Date(Date.now() - DAEMON_LOCK_TTL_MS - 1000));
    const releaseNew = acquireDaemonLock(lock);
    assert.ok(releaseNew);
    releaseOld();
    assert.equal(fs.existsSync(lock), true, '旧持有者的 release 不得删除新锁');
    releaseNew();
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(path.dirname(lock), { recursive: true, force: true });
  }
});

test('worker 锁令牌：旧持有者不得续租或清理新持有者的锁', () => {
  const lock = tempLockPath();
  try {
    const oldLock = acquireOwnedDaemonLock(lock);
    assert.ok(oldLock);
    fs.utimesSync(lock, new Date(Date.now() - DAEMON_LOCK_TTL_MS - 1000), new Date(Date.now() - DAEMON_LOCK_TTL_MS - 1000));
    const newLock = acquireOwnedDaemonLock(lock);
    assert.ok(newLock);
    assert.equal(refreshDaemonLock(lock, oldLock!.owner), false);
    assert.equal(clearDaemonLockIfOwner(lock, oldLock!.owner), false);
    assert.equal(fs.existsSync(lock), true);
    assert.equal(refreshDaemonLock(lock, newLock!.owner), true);
    assert.equal(clearDaemonLockIfOwner(lock, newLock!.owner), true);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(path.dirname(lock), { recursive: true, force: true });
  }
});

test('恢复 worker：异步 spawn 失败时释放锁并在同一 hook 内重试', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-recovery-spawn-test-'));
  const recoveryPath = path.join(base, 'pet.recovering');
  const workerLockPath = path.join(base, 'pet.recovering.worker.lock');
  let attempts = 0;
  const spawnFn = (() => {
    attempts++;
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    queueMicrotask(() => {
      if (attempts < 3) child.emit('error', new Error('模拟异步 spawn 失败'));
      else child.emit('spawn');
    });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;

  try {
    const scheduled = await scheduleDaemonRecovery({
      pipeName: 'test-event-pipe',
      recoveryPath,
      lockPath: path.join(base, 'daemon.lock'),
      suppressionPath: path.join(base, 'pet.disabled'),
      daemonPath: path.join(base, 'kpetd.exe'),
      workerLockPath,
      spawnFn,
    });
    assert.equal(scheduled, true);
    assert.equal(attempts, 3, '前两次异步失败后应由当前 hook 继续重试');
    assert.equal(fs.existsSync(workerLockPath), true, '成功启动后应把 worker 锁交给子进程');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('daemon 拉起竞态：spawn 调用期间出现抑制标记时结束子进程并接住异步错误', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-daemon-spawn-race-test-'));
  const lockPath = path.join(base, 'daemon.lock');
  const suppressionPath = path.join(base, 'pet.disabled');
  let killed = false;
  let unrefed = false;
  const child = new EventEmitter() as EventEmitter & { kill: () => boolean; unref: () => void };
  child.kill = () => {
    killed = true;
    return true;
  };
  child.unref = () => {
    unrefed = true;
  };
  const spawnFn = (() => {
    assert.equal(setPetSuppressed(suppressionPath), true);
    return child;
  }) as unknown as typeof import('node:child_process').spawn;

  try {
    assert.equal(spawnDaemonIfNeeded({
      daemonPath: path.join(base, 'kpetd.exe'),
      lockPath,
      suppressionPath,
      spawnFn,
    }), false);
    assert.equal(killed, true);
    assert.equal(unrefed, true);
    assert.equal(child.listenerCount('error'), 1, 'kill 后潜在异步 error 必须已有监听器');
    assert.doesNotThrow(() => child.emit('error', new Error('模拟 kill 后异步启动错误')));
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('在途投递租约：正常释放后消失，崩溃残留超过 TTL 后自动回收', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-delivery-lease-test-'));
  const recoveryPath = path.join(base, 'pet.recovering');
  try {
    const first = acquireDeliveryLease(recoveryPath);
    assert.ok(first);
    assert.equal(hasActiveDeliveryLeases(recoveryPath), true);
    first!.release();
    assert.equal(hasActiveDeliveryLeases(recoveryPath), false);

    const stale = acquireDeliveryLease(recoveryPath);
    assert.ok(stale);
    const staleAt = new Date(Date.now() - DELIVERY_LEASE_TTL_MS - 1000);
    fs.utimesSync(stale!.path, staleAt, staleAt);
    assert.equal(hasActiveDeliveryLeases(recoveryPath), false, '超时残留不得永久阻塞恢复 worker');
    assert.deepEqual(fs.readdirSync(getDeliveryLeaseDir(recoveryPath)), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('acquireDaemonLock：父目录不存在时自动创建', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kpet-lock-test-'));
  const lock = path.join(base, 'kpet', 'daemon.lock'); // 父目录不存在
  try {
    const release = acquireDaemonLock(lock);
    assert.ok(release, '父目录不存在也应能拿到锁（自动创建目录）');
    assert.ok(fs.existsSync(lock), '锁文件已创建');
    release!();
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolveDaemonPath：优先 KIMI_PLUGIN_ROOT，缺省相对 cwd() 推导（win32）', () => {
  const env = { KIMI_PLUGIN_ROOT: 'C:\\plugins\\kpet' } as NodeJS.ProcessEnv;
  assert.equal(resolveDaemonPath(env, 'win32'), path.join('C:\\plugins\\kpet', 'bin', 'kpetd.exe'));
  assert.equal(resolveDaemonPath({}, 'win32'), path.join(process.cwd(), 'bin', 'kpetd.exe'));
});

test('resolveDaemonPath：非 win32 平台产物名为 kpetd', () => {
  const env = { KIMI_PLUGIN_ROOT: '/opt/kpet' } as NodeJS.ProcessEnv;
  assert.equal(resolveDaemonPath(env, 'linux'), path.join('/opt/kpet', 'bin', 'kpetd'));
  assert.equal(resolveDaemonPath({}, 'linux'), path.join(process.cwd(), 'bin', 'kpetd'));
  assert.equal(resolveDaemonPath(env, 'darwin'), path.join('/opt/kpet', 'bin', 'kpetd'));
});

test('getDaemonExeName：win32 返回 kpetd.exe，其余平台返回 kpetd', () => {
  assert.equal(getDaemonExeName('win32'), 'kpetd.exe');
  assert.equal(getDaemonExeName('linux'), 'kpetd');
  assert.equal(getDaemonExeName('darwin'), 'kpetd');
});

test('isStandaloneExecutable：win32 只认非 bun/node 的 .exe 自身', () => {
  assert.equal(isStandaloneExecutable('C:\\plugins\\kpet\\bin\\kpetd.exe', 'win32'), true);
  assert.equal(isStandaloneExecutable('C:\\tools\\node.exe', 'win32'), false, 'node 开发宿主不算产物自身');
  assert.equal(isStandaloneExecutable('C:\\tools\\bun.exe', 'win32'), false, 'bun 开发宿主不算产物自身');
  assert.equal(isStandaloneExecutable('C:\\plugins\\kpet\\bin\\kpetd', 'win32'), false, 'win32 下无 .exe 后缀不算产物自身');
});

test('isStandaloneExecutable：非 win32 按 basename 排除 bun/node 宿主', () => {
  assert.equal(isStandaloneExecutable('/opt/kpet/bin/kpetd', 'linux'), true);
  assert.equal(isStandaloneExecutable('kpetd', 'linux'), true, '裸文件名（argv[0] 无路径）也按 basename 判定');
  assert.equal(isStandaloneExecutable('/usr/local/bin/node', 'linux'), false, 'node 开发宿主不算产物自身');
  assert.equal(isStandaloneExecutable('/usr/local/bin/bun', 'darwin'), false, 'bun 开发宿主不算产物自身');
  assert.equal(isStandaloneExecutable('/usr/bin/node.exe', 'linux'), false, '带 .exe 后缀的 node 宿主同样排除');
});

test('getDaemonLockPath 默认路径：系统临时目录（Windows 为 %TEMP%）/kpet/daemon.lock（独立于事件暂存目录）', () => {
  assert.equal(getDaemonLockPath('C:\\Temp'), path.join('C:\\Temp', 'kpet', 'daemon.lock'));
});
