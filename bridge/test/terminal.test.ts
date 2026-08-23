/**
 * 终端唤起测试。
 * 命令构造为纯函数直接断言；openTui 的 wt 回退路径注入 spawn 模拟 ENOENT；
 * web 目标注入 connect / spawn 模拟「服务已就绪 / 需经可见终端窗口拉起（wt 直拉、
 * wt 缺失回退 cmd）/ 双路径失败 / 超时 / 非回环 / URL 非法」等分支。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  appendServerToken,
  buildOpenTuiCommand,
  buildOpenWebCommand,
  buildOpenWebUrl,
  buildStartWebServiceCommand,
  buildWslFallbackCommand,
  buildWslStartWebServiceFallbackCommand,
  openTui,
  type ConnectFn,
  type SpawnFn,
  type TokenReader,
  type VerifyServerTokenFn,
} from '../src/daemon/terminal.js';

/** 测试用 token 读取：永远 null，避免读真实 ~/.kimi-code/server.token 影响 URL 断言。 */
const noToken: TokenReader = () => null;

/** 测试用验证函数：固定返回指定结果，并记录每次调用参数。 */
function fakeVerify(
  result: 'ok' | 'unauthorized' | 'error',
  calls: Array<{ host: string; port: number; token: string; timeoutMs: number }> = [],
): VerifyServerTokenFn {
  return (host, port, token, timeoutMs) => {
    calls.push({ host, port, token, timeoutMs });
    return Promise.resolve(result);
  };
}

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

test('buildOpenTuiCommand：wt 模式（主路径）', () => {
  const cmd = buildOpenTuiCommand({ terminal: 'wt', cwd: 'D:\\ws', sessionId: 'session_1' });
  assert.deepEqual(cmd, {
    file: 'wt.exe',
    args: ['-d', 'D:\\ws', 'cmd', '/k', 'kimi', '--session', 'session_1'],
    cwd: 'D:\\ws',
  });
});

test('buildOpenTuiCommand：会话 id 为空 → kimi --continue（恢复最近会话）', () => {
  const cmd = buildOpenTuiCommand({ terminal: 'wt', cwd: 'D:\\ws', sessionId: null });
  assert.deepEqual(cmd.args.slice(4), ['kimi', '--continue']);
});

test('buildOpenTuiCommand：cmd 模式 → cmd /c start（备选）', () => {
  const cmd = buildOpenTuiCommand({ terminal: 'cmd', cwd: 'D:\\ws', sessionId: 'session_2' });
  assert.deepEqual(cmd, {
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'cmd', '/k', 'kimi', '--session', 'session_2'],
    cwd: 'D:\\ws',
  });
});

test('buildOpenTuiCommand：wsl 模式（wt 直拉）→ wt -d 用转换后的 Windows cwd、--cd 保留 Linux cwd', () => {
  const cmd = buildOpenTuiCommand({ terminal: 'wsl', cwd: '/mnt/c/Users/me/proj', sessionId: 's1' });
  assert.deepEqual(cmd, {
    file: 'wt.exe',
    args: ['-d', 'C:\\Users\\me\\proj', 'wsl.exe', '--cd', '/mnt/c/Users/me/proj', '--', 'kimi', '--session', 's1'],
    cwd: 'C:\\Users\\me\\proj',
  });
});

test('buildOpenTuiCommand：wsl 模式 + 指定发行版 → wsl.exe -d <发行版>', () => {
  const cmd = buildOpenTuiCommand({ terminal: 'wsl', wslDistro: 'Ubuntu', cwd: '/home/me/proj', sessionId: 's1' });
  assert.deepEqual(cmd, {
    file: 'wt.exe',
    args: ['-d', '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj', 'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/me/proj', '--', 'kimi', '--session', 's1'],
    cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj',
  });
});

test('buildOpenTuiCommand：wsl 模式 + cwd 已是 Windows 路径 → wt -d 原样透传', () => {
  const cmd = buildOpenTuiCommand({ terminal: 'wsl', wslDistro: 'Ubuntu', cwd: 'D:\\ws', sessionId: 's1' });
  assert.deepEqual(cmd, {
    file: 'wt.exe',
    args: ['-d', 'D:\\ws', 'wsl.exe', '-d', 'Ubuntu', '--cd', 'D:\\ws', '--', 'kimi', '--session', 's1'],
    cwd: 'D:\\ws',
  });
});

test('buildOpenTuiCommand：wsl 模式 + 会话 id 为空 → kimi --continue', () => {
  const cmd = buildOpenTuiCommand({ terminal: 'wsl', cwd: '/mnt/c/Users/me/proj', sessionId: null });
  assert.deepEqual(cmd.args.slice(2), ['wsl.exe', '--cd', '/mnt/c/Users/me/proj', '--', 'kimi', '--continue']);
});

test('buildWslFallbackCommand：wsl 回退 → cmd /c start wsl.exe --exec bash -lc 单 argv 打包，cwd 转 Windows', () => {
  const cmd = buildWslFallbackCommand({ terminal: 'wsl', wslDistro: 'Ubuntu', cwd: '/home/me/proj', sessionId: 's1' });
  assert.deepEqual(cmd, {
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/me/proj', '--exec', 'bash', '-lc', 'kimi --session s1'],
    cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj',
  });
});

test('buildWslFallbackCommand：发行版缺省 → 不带 -d；会话 id 为空 → kimi --continue', () => {
  const cmd = buildWslFallbackCommand({ terminal: 'wsl', cwd: '/mnt/c/Users/me/proj', sessionId: null });
  assert.deepEqual(cmd.args, ['/c', 'start', '', 'wsl.exe', '--cd', '/mnt/c/Users/me/proj', '--exec', 'bash', '-lc', 'kimi --continue']);
  assert.equal(cmd.cwd, 'C:\\Users\\me\\proj');
});

test('openTui：wt 成功 → ok + terminal=wt，且 windowsHide=false（SW_HIDE 回归）', async () => {
  let calls = 0;
  const captured: { opts?: { windowsHide: boolean } } = {};
  const spawnFn: SpawnFn = (_file, _args, opts) => {
    calls++;
    captured.opts = opts;
    return fakeChild('ok') as never;
  };
  const res = await openTui({ terminal: 'wt', cwd: 'D:\\ws', sessionId: 's1' }, spawnFn);
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'wt');
  assert.equal(calls, 1);
  // 回归：wt 不能以 windowsHide=true 拉起，否则 libuv 的 SW_HIDE 会隐藏 GUI 窗口
  assert.equal(captured.opts?.windowsHide, false);
});

test('openTui：wt.exe 不存在（ENOENT）→ 回退 cmd /c start（备选）', async () => {
  const behaviors: Array<'enoent' | 'ok'> = ['enoent', 'ok'];
  const seen: Array<{ windowsHide: boolean }> = [];
  const spawnFn: SpawnFn = (_file, _args, opts) => {
    seen.push(opts);
    return fakeChild(behaviors.shift()!) as never;
  };
  const res = await openTui({ terminal: 'wt', cwd: 'D:\\ws', sessionId: 's1' }, spawnFn);
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'cmd', '回退到 cmd');
  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.windowsHide, false, 'wt 不隐藏窗口');
  assert.equal(seen[1]?.windowsHide, true, 'cmd 存根隐藏（start 新开可见窗口）');
});

test('openTui：wsl 首选经 wt.exe 直拉成功 → ok + terminal=wsl，且 windowsHide=false（SW_HIDE 回归）', async () => {
  let calls = 0;
  const captured: { file: string; args: string[]; opts?: { windowsHide: boolean } } = { file: '', args: [] };
  const spawnFn: SpawnFn = (file, args, opts) => {
    calls++;
    captured.file = file;
    captured.args = args;
    captured.opts = opts;
    return fakeChild('ok') as never;
  };
  const res = await openTui({ terminal: 'wsl', wslDistro: 'Ubuntu', cwd: '/home/me/proj', sessionId: 's1' }, spawnFn);
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'wsl');
  assert.equal(calls, 1);
  // 回归：wsl 分支同样经 wt.exe 直拉，不能以 windowsHide=true 拉起，否则 libuv 的 SW_HIDE 会隐藏窗口
  assert.equal(captured.opts?.windowsHide, false);
  assert.deepEqual(captured.args, ['-d', '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj', 'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/me/proj', '--', 'kimi', '--session', 's1']);
});

test('openTui：wsl 首选 wt.exe 不存在（ENOENT）→ 回退 cmd /c start wsl.exe --exec bash -lc', async () => {
  const behaviors: Array<'enoent' | 'ok'> = ['enoent', 'ok'];
  const seen: Array<{ file: string; args: string[]; windowsHide: boolean }> = [];
  const spawnFn: SpawnFn = (file, args, opts) => {
    seen.push({ file, args, windowsHide: opts.windowsHide });
    return fakeChild(behaviors.shift()!) as never;
  };
  const res = await openTui({ terminal: 'wsl', wslDistro: 'Ubuntu', cwd: '/home/me/proj', sessionId: 's1' }, spawnFn);
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'cmd', '回退到 cmd');
  assert.equal(seen.length, 2);
  // wsl 首选经 wt.exe 直拉，不隐藏窗口
  assert.deepEqual(seen[0], {
    file: 'wt.exe',
    args: ['-d', '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj', 'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/me/proj', '--', 'kimi', '--session', 's1'],
    windowsHide: false,
  });
  // cmd 回退：bash -lc 的整条命令打包为单个 argv；回退启动目录同样转为 Windows 路径（避免 spawn 目录无效）
  assert.deepEqual(seen[1], {
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/me/proj', '--exec', 'bash', '-lc', 'kimi --session s1'],
    windowsHide: true,
  });
});

test('openTui：wt 失败且非 ENOENT（如 EACCES）→ 不回退，返回失败', async () => {
  const spawnFn: SpawnFn = () => fakeChild('error') as never;
  const res = await openTui({ terminal: 'wt', cwd: 'D:\\ws', sessionId: 's1' }, spawnFn);
  assert.equal(res.ok, false);
  assert.equal(res.terminal, 'wt');
});

test('buildOpenWebUrl：{session_id} 占位符替换，空会话 id 替换为空串', () => {
  assert.equal(buildOpenWebUrl('http://127.0.0.1:58627/?session={session_id}', 's1'), 'http://127.0.0.1:58627/?session=s1');
  assert.equal(buildOpenWebUrl('http://127.0.0.1:58627/', null), 'http://127.0.0.1:58627/');
  assert.equal(buildOpenWebUrl('http://x/{session_id}/tail', null), 'http://x//tail');
});

test('buildOpenWebCommand：cmd /c start "" <url> 走系统默认浏览器', () => {
  const cmd = buildOpenWebCommand('http://127.0.0.1:58627/', 'D:\\ws');
  assert.deepEqual(cmd, {
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'http://127.0.0.1:58627/'],
    cwd: 'D:\\ws',
  });
});

test('buildStartWebServiceCommand：wt 模式 → 显式新建标签、刷新环境后启动 kimi web（可见窗口）', () => {
  const cmd = buildStartWebServiceCommand({ terminal: 'wt', cwd: 'D:\\ws', sessionId: null }, 58627);
  assert.deepEqual(cmd, {
    file: 'wt.exe',
    args: ['new-tab', '--reloadEnvironment', '-d', 'D:\\ws', 'cmd', '/k', 'kimi', 'web', '--no-open', '--port', '58627'],
    cwd: 'D:\\ws',
  });
});

test('buildStartWebServiceCommand：cmd 模式 → cmd /c start（备选）', () => {
  const cmd = buildStartWebServiceCommand({ terminal: 'cmd', cwd: 'D:\\ws', sessionId: null }, 58627);
  assert.deepEqual(cmd, {
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'cmd', '/k', 'kimi', 'web', '--no-open', '--port', '58627'],
    cwd: 'D:\\ws',
  });
});

test('buildStartWebServiceCommand：wsl 模式 → wt 进入指定发行版启动 kimi web，启动目录转为 Windows 路径', () => {
  const cmd = buildStartWebServiceCommand({ terminal: 'wsl', wslDistro: 'Ubuntu', cwd: '/home/me/proj', sessionId: null }, 58627);
  assert.deepEqual(cmd, {
    file: 'wt.exe',
    args: [
      '-d', '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj', 'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/me/proj', '--',
      'kimi', 'web', '--no-open', '--port', '58627',
    ],
    cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj',
  });
});

test('buildWslStartWebServiceFallbackCommand：wsl 回退 → cmd start wsl.exe bash 内启动 kimi web', () => {
  const cmd = buildWslStartWebServiceFallbackCommand({ terminal: 'wsl', wslDistro: 'Ubuntu', cwd: '/home/me/proj', sessionId: null }, 58627);
  assert.deepEqual(cmd, {
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/me/proj', '--exec', 'bash', '-lc', 'kimi web --no-open --port 58627'],
    cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj',
  });
});

test('openTui：target=web → 打开浏览器，terminal=web（open_target）', async () => {
  let captured: { file: string; args: string[] } | null = null;
  const spawnFn: SpawnFn = (file, args) => {
    captured = { file, args };
    return fakeChild('ok') as never;
  };
  const res = await openTui({
    target: 'web',
    terminal: 'wt',
    webUrl: 'http://127.0.0.1:58627/?s={session_id}',
    cwd: 'D:\\ws',
    sessionId: 's1',
  }, spawnFn, () => Promise.resolve(true), undefined, noToken);
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.deepEqual(captured, { file: 'cmd.exe', args: ['/c', 'start', '', 'http://127.0.0.1:58627/?s=s1'] });
});

test('openTui：target=web 且未提供 webUrl → 使用默认本地 kimi web 首页', async () => {
  let captured: { file: string; args: string[] } | null = null;
  const spawnFn: SpawnFn = (file, args) => {
    captured = { file, args };
    return fakeChild('ok') as never;
  };
  const res = await openTui({ target: 'web', terminal: 'wt', cwd: 'D:\\ws', sessionId: null }, spawnFn, () => Promise.resolve(true), undefined, noToken);
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.deepEqual(captured, { file: 'cmd.exe', args: ['/c', 'start', '', 'http://127.0.0.1:58627/'] });
});

test('openTui：target=web 且本地服务已在运行 → 不拉起 kimi web，直接开浏览器', async () => {
  const spawned: Array<{ file: string; args: string[] }> = [];
  let probes = 0;
  const connectFn: ConnectFn = () => {
    probes++;
    return Promise.resolve(true);
  };
  const spawnFn: SpawnFn = (file, args) => {
    spawned.push({ file, args });
    return fakeChild('ok') as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/?s={session_id}', cwd: 'D:\\ws', sessionId: 's1' },
    spawnFn,
    connectFn,
    undefined,
    noToken,
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.equal(probes, 1, '只探测一次，未进入轮询');
  assert.equal(spawned.length, 1, '只开浏览器，未拉起 kimi web');
  assert.deepEqual(spawned[0], { file: 'cmd.exe', args: ['/c', 'start', '', 'http://127.0.0.1:58627/?s=s1'] });
});

test('openTui：target=web 服务未运行 → 经 wt.exe 可见窗口拉起 kimi web 并就绪后开浏览器', async () => {
  const spawned: Array<{ file: string; args: string[]; windowsHide?: boolean }> = [];
  let probes = 0;
  const connectFn: ConnectFn = () => {
    probes++;
    // 拉起前的首次探测返回 false，后续轮询返回 true
    return Promise.resolve(probes > 1);
  };
  const spawnFn: SpawnFn = (file, args, opts) => {
    spawned.push({ file, args, windowsHide: opts.windowsHide });
    return fakeChild('ok') as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/', cwd: 'D:\\ws', sessionId: null },
    spawnFn,
    connectFn,
    { pollMs: 1, waitMs: 100 },
    noToken,
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.equal(spawned.length, 2, '先拉起 kimi web，再打开浏览器');
  // 回归：wt 不能以 windowsHide=true 拉起，否则 libuv 的 SW_HIDE 会隐藏 GUI 窗口（服务窗口不可见）
  assert.deepEqual(spawned[0], {
    file: 'wt.exe',
    args: ['new-tab', '--reloadEnvironment', '-d', 'D:\\ws', 'cmd', '/k', 'kimi', 'web', '--no-open', '--port', '58627'],
    windowsHide: false,
  });
  assert.deepEqual(spawned[1], {
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'http://127.0.0.1:58627/'],
    windowsHide: true,
  });
});

test('openTui：target=web + terminal=wsl → 在 WSL 内拉起 kimi web，就绪后才打开浏览器', async () => {
  const spawned: Array<{ file: string; args: string[]; windowsHide?: boolean }> = [];
  let probes = 0;
  const connectFn: ConnectFn = () => {
    probes++;
    return Promise.resolve(probes > 1);
  };
  const spawnFn: SpawnFn = (file, args, opts) => {
    spawned.push({ file, args, windowsHide: opts.windowsHide });
    return fakeChild('ok') as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wsl', wslDistro: 'Ubuntu', webUrl: 'http://127.0.0.1:58627/', cwd: '/home/me/proj', sessionId: null },
    spawnFn,
    connectFn,
    { pollMs: 1, waitMs: 100 },
    noToken,
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.equal(spawned.length, 2, '先在 WSL 内拉起 kimi web，再打开浏览器');
  assert.deepEqual(spawned[0], {
    file: 'wt.exe',
    args: [
      '-d', '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj', 'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/me/proj', '--',
      'kimi', 'web', '--no-open', '--port', '58627',
    ],
    windowsHide: false,
  });
  assert.deepEqual(spawned[1], {
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'http://127.0.0.1:58627/'],
    windowsHide: true,
  });
});

test('openTui：target=web wt.exe 不存在（ENOENT）→ 回退 cmd /c start 可见窗口拉起', async () => {
  const behaviors: Array<'enoent' | 'ok'> = ['enoent', 'ok', 'ok'];
  const spawned: Array<{ file: string; args: string[]; windowsHide?: boolean }> = [];
  let probes = 0;
  const connectFn: ConnectFn = () => {
    probes++;
    // 拉起前的首次探测返回 false，后续轮询返回 true
    return Promise.resolve(probes > 1);
  };
  const spawnFn: SpawnFn = (file, args, opts) => {
    spawned.push({ file, args, windowsHide: opts.windowsHide });
    return fakeChild(behaviors.shift()!) as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/', cwd: 'D:\\ws', sessionId: null },
    spawnFn,
    connectFn,
    { pollMs: 1, waitMs: 100 },
    noToken,
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.equal(spawned.length, 3, 'wt 拉起失败 → cmd 回退拉起 → 打开浏览器');
  assert.deepEqual(spawned[0], {
    file: 'wt.exe',
    args: ['new-tab', '--reloadEnvironment', '-d', 'D:\\ws', 'cmd', '/k', 'kimi', 'web', '--no-open', '--port', '58627'],
    windowsHide: false,
  });
  // cmd 回退路径：外层 cmd 存根隐藏，真正的服务窗口由 start 新开
  assert.deepEqual(spawned[1], {
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'cmd', '/k', 'kimi', 'web', '--no-open', '--port', '58627'],
    windowsHide: true,
  });
  assert.deepEqual(spawned[2], { file: 'cmd.exe', args: ['/c', 'start', '', 'http://127.0.0.1:58627/'], windowsHide: true });
});

test('openTui：target=web + terminal=wsl 且 wt.exe 缺失 → 回退后仍在 WSL 内拉起 kimi web', async () => {
  const behaviors: Array<'enoent' | 'ok'> = ['enoent', 'ok', 'ok'];
  const spawned: Array<{ file: string; args: string[]; windowsHide?: boolean }> = [];
  let probes = 0;
  const connectFn: ConnectFn = () => {
    probes++;
    return Promise.resolve(probes > 1);
  };
  const spawnFn: SpawnFn = (file, args, opts) => {
    spawned.push({ file, args, windowsHide: opts.windowsHide });
    return fakeChild(behaviors.shift()!) as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wsl', wslDistro: 'Ubuntu', webUrl: 'http://127.0.0.1:58627/', cwd: '/home/me/proj', sessionId: null },
    spawnFn,
    connectFn,
    { pollMs: 1, waitMs: 100 },
    noToken,
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.equal(spawned.length, 3, 'wt 失败后经 WSL 回退拉起服务，再打开浏览器');
  assert.deepEqual(spawned[0], {
    file: 'wt.exe',
    args: [
      '-d', '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj', 'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/me/proj', '--',
      'kimi', 'web', '--no-open', '--port', '58627',
    ],
    windowsHide: false,
  });
  assert.deepEqual(spawned[1], {
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/me/proj', '--exec', 'bash', '-lc', 'kimi web --no-open --port 58627'],
    windowsHide: true,
  });
  assert.deepEqual(spawned[2], {
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'http://127.0.0.1:58627/'],
    windowsHide: true,
  });
});

test('openTui：target=web 拉起后服务一直未就绪 → 超时返回 ok=false', async () => {
  const spawned: Array<{ file: string; args: string[] }> = [];
  const connectFn: ConnectFn = () => Promise.resolve(false);
  const spawnFn: SpawnFn = (file, args) => {
    spawned.push({ file, args });
    return fakeChild('ok') as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/', cwd: 'D:\\ws', sessionId: null },
    spawnFn,
    connectFn,
    { pollMs: 1, waitMs: 30 },
    noToken,
  );
  assert.equal(res.ok, false);
  assert.equal(res.terminal, 'web');
  assert.match(res.error ?? '', /未就绪/);
  assert.equal(spawned.length, 1, '只拉起 kimi web，超时后未开浏览器');
  assert.deepEqual(spawned[0], { file: 'wt.exe', args: ['new-tab', '--reloadEnvironment', '-d', 'D:\\ws', 'cmd', '/k', 'kimi', 'web', '--no-open', '--port', '58627'] });
});

test('openTui：target=web wt 与 cmd 两条拉起路径均失败（ENOENT）→ 返回 ok=false（中文错误描述）', async () => {
  const connectFn: ConnectFn = () => Promise.resolve(false);
  const seen: Array<{ file: string; args: string[] }> = [];
  const spawnFn: SpawnFn = (file, args) => {
    seen.push({ file, args });
    return fakeChild('enoent') as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/', cwd: 'D:\\ws', sessionId: null },
    spawnFn,
    connectFn,
    undefined,
    noToken,
  );
  assert.equal(res.ok, false);
  assert.equal(res.terminal, 'web');
  assert.match(res.error ?? '', /未安装或不在 PATH/);
  assert.equal(seen.length, 2, 'wt 失败后回退 cmd，两条路径都失败才判失败');
  assert.deepEqual(seen[0], { file: 'wt.exe', args: ['new-tab', '--reloadEnvironment', '-d', 'D:\\ws', 'cmd', '/k', 'kimi', 'web', '--no-open', '--port', '58627'] });
  assert.deepEqual(seen[1], { file: 'cmd.exe', args: ['/c', 'start', '', 'cmd', '/k', 'kimi', 'web', '--no-open', '--port', '58627'] });
});

test('openTui：target=web 非回环 URL → 不探测不拉起，直接开浏览器', async () => {
  let probes = 0;
  const spawned: Array<{ file: string; args: string[] }> = [];
  const connectFn: ConnectFn = () => {
    probes++;
    return Promise.resolve(false);
  };
  const spawnFn: SpawnFn = (file, args) => {
    spawned.push({ file, args });
    return fakeChild('ok') as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'https://example.com/session/{session_id}', cwd: 'D:\\ws', sessionId: 's9' },
    spawnFn,
    connectFn,
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.equal(probes, 0, '非回环地址不探测');
  assert.equal(spawned.length, 1, '只开浏览器，未拉起 kimi web');
  assert.deepEqual(spawned[0], { file: 'cmd.exe', args: ['/c', 'start', '', 'https://example.com/session/s9'] });
});

test('openTui：target=web URL 非法 → 返回 ok=false 且不探测不拉起', async () => {
  let probes = 0;
  let spawned = 0;
  const connectFn: ConnectFn = () => {
    probes++;
    return Promise.resolve(false);
  };
  const spawnFn: SpawnFn = () => {
    spawned++;
    return fakeChild('ok') as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'not-a-url', cwd: 'D:\\ws', sessionId: null },
    spawnFn,
    connectFn,
  );
  assert.equal(res.ok, false);
  assert.equal(res.terminal, 'web');
  assert.match(res.error ?? '', /无法解析/);
  assert.equal(probes, 0);
  assert.equal(spawned, 0);
});

// ---- web token 自动鉴权：回环 URL 拼 #token=（实测裸 URL 停在「Server token required」）----

test('openTui：target=web 回环 + token 读取成功 → 浏览器 URL 末尾带 #token=（fragment 位于 query 之后）', async () => {
  const spawned: Array<{ file: string; args: string[] }> = [];
  const verifyCalls: Array<{ host: string; port: number; token: string; timeoutMs: number }> = [];
  const spawnFn: SpawnFn = (file, args) => {
    spawned.push({ file, args });
    return fakeChild('ok') as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/?s={session_id}', cwd: 'D:\\ws', sessionId: 's1' },
    spawnFn,
    () => Promise.resolve(true),
    undefined,
    () => 'AbC-123_xYz',
    fakeVerify('ok', verifyCalls),
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.deepEqual(spawned[0], { file: 'cmd.exe', args: ['/c', 'start', '', 'http://127.0.0.1:58627/?s=s1#token=AbC-123_xYz'] });
});

test('openTui：target=web 回环 + token 读取返回 null → 裸 URL 打开，流程不失败', async () => {
  const spawned: Array<{ file: string; args: string[] }> = [];
  const spawnFn: SpawnFn = (file, args) => {
    spawned.push({ file, args });
    return fakeChild('ok') as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/?s={session_id}', cwd: 'D:\\ws', sessionId: 's1' },
    spawnFn,
    () => Promise.resolve(true),
    undefined,
    noToken,
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.deepEqual(spawned[0], { file: 'cmd.exe', args: ['/c', 'start', '', 'http://127.0.0.1:58627/?s=s1'] });
});

test('openTui：target=web 回环 + token 读取抛错 → 静默回退裸 URL，流程不失败', async () => {
  const spawned: Array<{ file: string; args: string[] }> = [];
  const spawnFn: SpawnFn = (file, args) => {
    spawned.push({ file, args });
    return fakeChild('ok') as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/', cwd: 'D:\\ws', sessionId: null },
    spawnFn,
    () => Promise.resolve(true),
    undefined,
    () => { throw new Error('EACCES'); },
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.deepEqual(spawned[0], { file: 'cmd.exe', args: ['/c', 'start', '', 'http://127.0.0.1:58627/'] });
});

test('openTui：target=web 非回环 URL + token 存在 → 不拼 token 不做验证（防泄漏到远端）', async () => {
  const spawned: Array<{ file: string; args: string[] }> = [];
  const verifyCalls: Array<{ host: string; port: number; token: string; timeoutMs: number }> = [];
  const spawnFn: SpawnFn = (file, args) => {
    spawned.push({ file, args });
    return fakeChild('ok') as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'https://example.com/session/{session_id}', cwd: 'D:\\ws', sessionId: 's9' },
    spawnFn,
    () => Promise.resolve(true),
    undefined,
    () => 'SECRET-TOKEN',
    fakeVerify('ok', verifyCalls),
  );
  assert.equal(res.ok, true);
  assert.equal(spawned.length, 1, '只开浏览器，未拉起 kimi web');
  assert.deepEqual(spawned[0], { file: 'cmd.exe', args: ['/c', 'start', '', 'https://example.com/session/s9'] });
  assert.equal(verifyCalls.length, 0, '非回环 URL 不调用验证');
});

test('openTui：target=web 回环 + URL 已有 fragment → 替换而非叠加', async () => {
  const spawned: Array<{ file: string; args: string[] }> = [];
  const verifyCalls: Array<{ host: string; port: number; token: string; timeoutMs: number }> = [];
  const spawnFn: SpawnFn = (file, args) => {
    spawned.push({ file, args });
    return fakeChild('ok') as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/?s=s1#old-frag', cwd: 'D:\\ws', sessionId: null },
    spawnFn,
    () => Promise.resolve(true),
    undefined,
    () => 'tok123',
    fakeVerify('ok', verifyCalls),
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.deepEqual(spawned[0], { file: 'cmd.exe', args: ['/c', 'start', '', 'http://127.0.0.1:58627/?s=s1#token=tok123'] });
});

test('appendServerToken：token 空 → 原样返回；已有 fragment 替换；正常拼到 query 之后', () => {
  assert.equal(appendServerToken('http://127.0.0.1:58627/?s=1', null), 'http://127.0.0.1:58627/?s=1');
  assert.equal(appendServerToken('http://127.0.0.1:58627/?s=1', ''), 'http://127.0.0.1:58627/?s=1');
  assert.equal(appendServerToken('http://127.0.0.1:58627/?s=1#old', 'tok'), 'http://127.0.0.1:58627/?s=1#token=tok');
  assert.equal(appendServerToken('http://127.0.0.1:58627/?s=1', 'tok'), 'http://127.0.0.1:58627/?s=1#token=tok');
  assert.equal(appendServerToken('http://127.0.0.1:58627/', 'tok-x_Y'), 'http://127.0.0.1:58627/#token=tok-x_Y');
});

// ---- web 端口顺延与 token 验证：被占端口先验证再决定顺延（区分同 home 与异构占用如 WSL）----

test('openTui：target=web 回环 + token 可用且首个候选端口空闲 → 原端口拉起服务，浏览器带 #token=，未调用验证', async () => {
  const spawned: Array<{ file: string; args: string[]; windowsHide?: boolean }> = [];
  const probes: number[] = [];
  const connectFn: ConnectFn = (port) => {
    probes.push(port);
    // 首次探测为空闲，后续轮询该端口返回就绪
    return Promise.resolve(probes.filter((p) => p === port).length > 1);
  };
  const spawnFn: SpawnFn = (file, args, opts) => {
    spawned.push({ file, args, windowsHide: opts.windowsHide });
    return fakeChild('ok') as never;
  };
  const verifyCalls: Array<{ host: string; port: number; token: string; timeoutMs: number }> = [];
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/foo?x=1', cwd: 'D:\\ws', sessionId: null },
    spawnFn,
    connectFn,
    { pollMs: 1, waitMs: 100 },
    () => 'tokA',
    fakeVerify('ok', verifyCalls),
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.deepEqual(probes, [58627, 58627], '先探测、再轮询确认就绪，均落在原端口');
  assert.equal(verifyCalls.length, 0, '端口空闲直接拉起，不调用验证');
  assert.equal(spawned.length, 2, '拉起服务后开浏览器');
  assert.deepEqual(spawned[0], {
    file: 'wt.exe',
    args: ['new-tab', '--reloadEnvironment', '-d', 'D:\\ws', 'cmd', '/k', 'kimi', 'web', '--no-open', '--port', '58627'],
    windowsHide: false,
  });
  assert.deepEqual(spawned[1], { file: 'cmd.exe', args: ['/c', 'start', '', 'http://127.0.0.1:58627/foo?x=1#token=tokA'], windowsHide: true });
});

test('openTui：target=web 回环 + 原端口被占且验证通过（同 home 服务）→ 不拉起，直接开带 #token= 的浏览器', async () => {
  const spawned: Array<{ file: string; args: string[] }> = [];
  const verifyCalls: Array<{ host: string; port: number; token: string; timeoutMs: number }> = [];
  const spawnFn: SpawnFn = (file, args) => {
    spawned.push({ file, args });
    return fakeChild('ok') as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/?s={session_id}', cwd: 'D:\\ws', sessionId: 's1' },
    spawnFn,
    () => Promise.resolve(true),
    undefined,
    () => 'AbC-123_xYz',
    fakeVerify('ok', verifyCalls),
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.equal(spawned.length, 1, '只开浏览器，未拉起 kimi web');
  assert.deepEqual(spawned[0], { file: 'cmd.exe', args: ['/c', 'start', '', 'http://127.0.0.1:58627/?s=s1#token=AbC-123_xYz'] });
  assert.equal(verifyCalls.length, 1, '被占端口验证一次后直接开');
});

test('openTui：target=web 回环 + 原端口 401（异构占用）→ 顺延 +1 拉起服务，浏览器用顺延端口并带 #token=', async () => {
  const spawned: Array<{ file: string; args: string[]; windowsHide?: boolean }> = [];
  const probesByPort: Record<number, number> = {};
  const connectFn: ConnectFn = (port) => {
    probesByPort[port] = (probesByPort[port] ?? 0) + 1;
    if (port === 58627) return Promise.resolve(true); // 原端口被异构占用
    return Promise.resolve(probesByPort[port] > 1); // 顺延端口：首次探测空闲，轮询后就绪
  };
  const spawnFn: SpawnFn = (file, args, opts) => {
    spawned.push({ file, args, windowsHide: opts.windowsHide });
    return fakeChild('ok') as never;
  };
  const verifyCalls: Array<{ host: string; port: number; token: string; timeoutMs: number }> = [];
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/', cwd: 'D:\\ws', sessionId: null },
    spawnFn,
    connectFn,
    { pollMs: 1, waitMs: 100 },
    () => 'tokB',
    fakeVerify('unauthorized', verifyCalls),
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.deepEqual(verifyCalls, [{ host: '127.0.0.1', port: 58627, token: 'tokB', timeoutMs: 1500 }], '只验证被占的原端口一次');
  assert.equal(spawned.length, 2, '顺延端口拉起服务后再开浏览器');
  assert.deepEqual(spawned[0], {
    file: 'wt.exe',
    args: ['new-tab', '--reloadEnvironment', '-d', 'D:\\ws', 'cmd', '/k', 'kimi', 'web', '--no-open', '--port', '58628'],
    windowsHide: false,
  });
  assert.deepEqual(spawned[1], { file: 'cmd.exe', args: ['/c', 'start', '', 'http://127.0.0.1:58628/#token=tokB'], windowsHide: true });
});

test('openTui：target=web 回环 + 前两个候选端口连续 401 → 顺延 +2 在第三个端口拉起', async () => {
  const spawned: Array<{ file: string; args: string[]; windowsHide?: boolean }> = [];
  const probesByPort: Record<number, number> = {};
  const connectFn: ConnectFn = (port) => {
    probesByPort[port] = (probesByPort[port] ?? 0) + 1;
    if (port <= 58628) return Promise.resolve(true); // 前两个候选均被占
    return Promise.resolve(probesByPort[port] > 1); // 顺延端口：首次探测空闲，轮询后就绪
  };
  const spawnFn: SpawnFn = (file, args, opts) => {
    spawned.push({ file, args, windowsHide: opts.windowsHide });
    return fakeChild('ok') as never;
  };
  const verifyCalls: Array<{ host: string; port: number; token: string; timeoutMs: number }> = [];
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/', cwd: 'D:\\ws', sessionId: null },
    spawnFn,
    connectFn,
    { pollMs: 1, waitMs: 100 },
    () => 'tokC',
    fakeVerify('unauthorized', verifyCalls),
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.deepEqual(verifyCalls.map((c) => c.port), [58627, 58628], '两个被占端口各验证一次');
  assert.deepEqual(spawned[0], {
    file: 'wt.exe',
    args: ['new-tab', '--reloadEnvironment', '-d', 'D:\\ws', 'cmd', '/k', 'kimi', 'web', '--no-open', '--port', '58629'],
    windowsHide: false,
  });
  assert.deepEqual(spawned[1], { file: 'cmd.exe', args: ['/c', 'start', '', 'http://127.0.0.1:58629/#token=tokC'], windowsHide: true });
});

test('openTui：target=web 回环 + 10 个候选端口全部 401 → 返回 ok=false，未拉起任何服务/浏览器，错误不含 token', async () => {
  let probes = 0;
  let spawned = 0;
  const verifyCalls: Array<{ host: string; port: number; token: string; timeoutMs: number }> = [];
  const connectFn: ConnectFn = () => {
    probes++;
    return Promise.resolve(true);
  };
  const spawnFn: SpawnFn = () => {
    spawned++;
    return fakeChild('ok') as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/', cwd: 'D:\\ws', sessionId: null },
    spawnFn,
    connectFn,
    undefined,
    () => 'tokX',
    fakeVerify('unauthorized', verifyCalls),
  );
  assert.equal(res.ok, false);
  assert.equal(res.terminal, 'web');
  assert.equal(probes, 10, '10 个候选端口各探测一次');
  assert.equal(verifyCalls.length, 10, '每个被占端口都验证一次');
  assert.equal(spawned, 0, '未拉起服务也未开浏览器');
  assert.match(res.error ?? '', /58627-58636/, '错误说明端口范围');
  assert.ok(!(res.error ?? '').includes('tokX'), '错误信息不得含 token');
});

test('openTui：target=web 回环 + 验证出错/超时（error）→ 同样顺延下一候选端口', async () => {
  const spawned: Array<{ file: string; args: string[] }> = [];
  const probesByPort: Record<number, number> = {};
  const connectFn: ConnectFn = (port) => {
    probesByPort[port] = (probesByPort[port] ?? 0) + 1;
    if (port === 58627) return Promise.resolve(true);
    return Promise.resolve(probesByPort[port] > 1);
  };
  const spawnFn: SpawnFn = (file, args) => {
    spawned.push({ file, args });
    return fakeChild('ok') as never;
  };
  const verifyCalls: Array<{ host: string; port: number; token: string; timeoutMs: number }> = [];
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/', cwd: 'D:\\ws', sessionId: null },
    spawnFn,
    connectFn,
    { pollMs: 1, waitMs: 100 },
    () => 'tokE',
    fakeVerify('error', verifyCalls),
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.deepEqual(verifyCalls.map((c) => c.port), [58627], '只验证被占的原端口一次');
  assert.deepEqual(spawned[1], { file: 'cmd.exe', args: ['/c', 'start', '', 'http://127.0.0.1:58628/#token=tokE'] });
});

test('openTui：target=web 回环 + token 为 null → 保持旧行为（被占直接开裸 URL），verifyFn 未被调用', async () => {
  const spawned: Array<{ file: string; args: string[] }> = [];
  let probes = 0;
  const verifyCalls: Array<{ host: string; port: number; token: string; timeoutMs: number }> = [];
  const connectFn: ConnectFn = () => {
    probes++;
    return Promise.resolve(true);
  };
  const spawnFn: SpawnFn = (file, args) => {
    spawned.push({ file, args });
    return fakeChild('ok') as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/?s={session_id}', cwd: 'D:\\ws', sessionId: 's1' },
    spawnFn,
    connectFn,
    undefined,
    noToken,
    fakeVerify('ok', verifyCalls),
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.equal(probes, 1, '只探测原端口一次（token 缺失无顺延）');
  assert.deepEqual(spawned[0], { file: 'cmd.exe', args: ['/c', 'start', '', 'http://127.0.0.1:58627/?s=s1'] }, '裸 URL，不拼 token');
  assert.equal(verifyCalls.length, 0, 'token 缺失不得调用验证');
});

test('openTui：target=web 回环 + verifyFn 收到正确参数（host 去 IPv6 括号、port、token、timeoutMs）', async () => {
  const spawned: Array<{ file: string; args: string[] }> = [];
  const verifyCalls: Array<{ host: string; port: number; token: string; timeoutMs: number }> = [];
  const spawnFn: SpawnFn = (file, args) => {
    spawned.push({ file, args });
    return fakeChild('ok') as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://[::1]:58627/x?y=1', cwd: 'D:\\ws', sessionId: null },
    spawnFn,
    () => Promise.resolve(true),
    undefined,
    () => 'tok6',
    fakeVerify('ok', verifyCalls),
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.deepEqual(verifyCalls, [{ host: '::1', port: 58627, token: 'tok6', timeoutMs: 1500 }], 'host 去掉 IPv6 方括号，超时用 VERIFY_TIMEOUT_MS');
  assert.deepEqual(spawned[0], { file: 'cmd.exe', args: ['/c', 'start', '', 'http://[::1]:58627/x?y=1#token=tok6'] });
});

test('openTui：target=web 回环 + 带路径与 query 的 URL 顺延 → 重写端口且保留路径与 query 后再拼 #token=', async () => {
  const spawned: Array<{ file: string; args: string[] }> = [];
  const probesByPort: Record<number, number> = {};
  const connectFn: ConnectFn = (port) => {
    probesByPort[port] = (probesByPort[port] ?? 0) + 1;
    if (port === 58627) return Promise.resolve(true);
    return Promise.resolve(probesByPort[port] > 1);
  };
  const spawnFn: SpawnFn = (file, args) => {
    spawned.push({ file, args });
    return fakeChild('ok') as never;
  };
  const res = await openTui(
    { target: 'web', terminal: 'wt', webUrl: 'http://127.0.0.1:58627/foo?x=1&y={session_id}', cwd: 'D:\\ws', sessionId: 's2' },
    spawnFn,
    connectFn,
    { pollMs: 1, waitMs: 100 },
    () => 'tokF',
    fakeVerify('unauthorized'),
  );
  assert.equal(res.ok, true);
  assert.equal(res.terminal, 'web');
  assert.deepEqual(spawned[1], { file: 'cmd.exe', args: ['/c', 'start', '', 'http://127.0.0.1:58628/foo?x=1&y=s2#token=tokF'] });
});
