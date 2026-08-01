/**
 * 集成测试（Windows 命名管道，§4.1）：
 * - echo 管道：本地 net server 充当命名管道服务端，验证转发器送达的 host_event 信封完整正确
 * - 管道不存在 → 写本地暂存兜底（§3.3）
 * - 非法 JSON → 放行，不连管道、不写暂存（§2.2 D4 / §3.3）
 *
 * 非 Windows 平台跳过（命名管道为 Windows 特性）。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { relayHostEvent } from '../src/bridge/main.js';

const isWindows = process.platform === 'win32';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-pet-test-'));
}

function uniquePipeName(): string {
  return `\\\\.\\pipe\\KimiPet.Test.${process.pid}.${randomUUID().slice(0, 8)}`;
}

/** 建一个命名管道服务端，收到一条完整消息后 resolve 消息文本。所有连接与定时器在收尾时清理，保证进程可退出。 */
function listenOnce(pipeName: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<net.Socket>();
    const timer = setTimeout(() => {
      for (const s of sockets) s.destroy();
      server.close();
      reject(new Error('等待管道消息超时'));
    }, timeoutMs);
    timer.unref();

    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {
        // 探测连接的瞬时断开可能带错误，忽略
      });
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.includes('\n')) {
          const line = buf.split('\n')[0]!;
          clearTimeout(timer);
          for (const s of sockets) s.destroy();
          server.close();
          resolve(line);
        }
      });
    });
    server.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    server.listen(pipeName);
  });
}

test('集成：转发器经命名管道送达 host_event（_raw 透传原文）', { skip: !isWindows }, async () => {
  const pipeName = uniquePipeName();
  const received = listenOnce(pipeName);
  const raw = '{"hook_event_name":"PreToolUse","session_id":"session_9","cwd":"D:\\\\ws","tool_input":{"command":"npm test"}}';

  const result = await relayHostEvent(raw, { pipeName, spawnDaemon: false });
  assert.equal(result.outcome, 'delivered');

  const env = JSON.parse(await received);
  assert.equal(env.v, 1);
  assert.equal(env.type, 'host_event');
  assert.equal(env.session_id, 'session_9');
  assert.ok(env.id && typeof env.id === 'string');
  assert.ok(!Number.isNaN(Date.parse(env.ts)));
  assert.equal(env.payload._raw, raw, '_raw 与输入文本逐字符一致');
});

test('集成：管道不存在 → 写本地暂存兜底（§3.3）', { skip: !isWindows }, async () => {
  const stagingDir = tempDir();
  try {
    const raw = '{"hook_event_name":"Stop"}';
    const result = await relayHostEvent(raw, {
      pipeName: uniquePipeName(), // 绝不存在的管道
      spawnDaemon: false,
      stagingDir,
    });
    assert.equal(result.outcome, 'staged');
    const files = fs.readdirSync(stagingDir);
    assert.equal(files.length, 1);
    const env = JSON.parse(fs.readFileSync(path.join(stagingDir, files[0]!), 'utf8'));
    assert.equal(env.type, 'host_event');
    assert.equal(env.payload._raw, raw);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('集成：非法 JSON 直接放行，不连管道、不写暂存（§2.2 D4）', { skip: !isWindows }, async () => {
  const stagingDir = tempDir();
  let probeCalled = false;
  try {
    const result = await relayHostEvent('this is not json', {
      pipeName: uniquePipeName(),
      spawnDaemon: false,
      stagingDir,
      probe: async () => {
        probeCalled = true;
        return true;
      },
    });
    assert.equal(result.outcome, 'invalid_json');
    assert.equal(probeCalled, false, '非法输入不应触碰管道');
    assert.equal(fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir).length : 0, 0, '不应写暂存');
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('集成：管道探测成功但写入失败 → 暂存兜底（§3.3）', { skip: !isWindows }, async () => {
  const stagingDir = tempDir();
  let probeCalled = false;
  try {
    const result = await relayHostEvent('{"hook_event_name":"Interrupt"}', {
      pipeName: uniquePipeName(),
      spawnDaemon: false,
      stagingDir,
      probe: async () => {
        probeCalled = true;
        return true; // 探测到管道存在
      },
      write: async () => 'error', // 写入失败
    });
    assert.equal(probeCalled, true);
    assert.equal(result.outcome, 'staged');
    const files = fs.readdirSync(stagingDir);
    assert.equal(files.length, 1);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});
