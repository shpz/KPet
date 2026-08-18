/**
 * --stop 停止守护进程流程测试（bridge/stop.ts）。
 * 注入临时抑制标记路径（绝不触碰系统真实 %TEMP%/kimi-pet/pet.disabled）、可控 probe
 * 返回序列与假 sleep；不启动任何真实进程，也不做进程级实测。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { setPetSuppressed } from '../src/bridge/daemon.js';
import { stopDaemon } from '../src/bridge/stop.js';

const TEST_PIPE = '\\\\.\\pipe\\KimiPet.H2D.stop-test';

test('stopDaemon：无运行实例 —— 直接返回 not_running，不写不清标记', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-pet-stop-test-'));
  const suppressionPath = path.join(base, 'pet.disabled');
  let probeCalls = 0;
  let sleepCalls = 0;
  try {
    const result = await stopDaemon({
      suppressionPath,
      pipeName: TEST_PIPE,
      probe: async () => {
        probeCalls++;
        return false; // 探测不到事件管道：无守护进程运行
      },
      sleep: async () => {
        sleepCalls++;
      },
    });
    assert.equal(result, 'not_running');
    assert.equal(probeCalls, 1, '入口探测一次即返回，不进入轮询');
    assert.equal(sleepCalls, 0, '无运行实例时不得轮询等待');
    assert.equal(fs.existsSync(suppressionPath), false, '无运行实例不得留下抑制标记');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('stopDaemon：正常停止 —— 写标记触发优雅退出，管道释放后清除标记', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-pet-stop-test-'));
  const suppressionPath = path.join(base, 'pet.disabled');
  const probes = [true, true, false]; // 入口存在 → 轮询仍存在 → 释放
  let probeCalls = 0;
  const sleepMss: number[] = [];
  try {
    const result = await stopDaemon({
      suppressionPath,
      pipeName: TEST_PIPE,
      probe: async () => {
        const call = probeCalls++;
        if (call === 0) {
          assert.equal(fs.existsSync(suppressionPath), false, '入口探测时尚未写入标记');
        } else {
          assert.equal(fs.existsSync(suppressionPath), true, '轮询期间应已写入标记触发优雅退出');
        }
        return probes[call]!;
      },
      sleep: async (ms) => {
        sleepMss.push(ms);
      },
    });
    assert.equal(result, 'stopped');
    assert.equal(probeCalls, 3, '入口探测 + 两次轮询探测');
    assert.ok(sleepMss.length >= 1, '等待管道释放期间应轮询 sleep');
    assert.equal(fs.existsSync(suppressionPath), false, '停止成功后必须清除本次写入的标记');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('stopDaemon：等待超时 —— 返回 timeout，本次写入的标记仍被清除', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-pet-stop-test-'));
  const suppressionPath = path.join(base, 'pet.disabled');
  let sleepCalls = 0;
  try {
    const result = await stopDaemon({
      suppressionPath,
      pipeName: TEST_PIPE,
      timeoutMs: 300,
      pollIntervalMs: 100,
      probe: async () => true, // 管道始终不释放
      sleep: async () => {
        sleepCalls++;
      },
    });
    assert.equal(result, 'timeout');
    assert.ok(sleepCalls >= 2, '超时窗口内应多次轮询等待（300ms / 100ms 间隔）');
    assert.equal(fs.existsSync(suppressionPath), false, '超时返回后也不得残留本次写入的标记');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('stopDaemon：既有抑制标记（用户手动关闭）—— 不写不清，等待其自然停止', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-pet-stop-test-'));
  const suppressionPath = path.join(base, 'pet.disabled');
  assert.equal(setPetSuppressed(suppressionPath), true, '先模拟用户手动关闭留下的既有标记');
  const probes = [true, false]; // 入口存在 → 管道释放（守护进程经 housekeeping 自行退出）
  let probeCalls = 0;
  try {
    const result = await stopDaemon({
      suppressionPath,
      pipeName: TEST_PIPE,
      probe: async () => probes[probeCalls++]!,
      sleep: async () => {
        // 假 sleep：不消耗真实时间
      },
    });
    assert.equal(result, 'stopped');
    assert.equal(fs.existsSync(suppressionPath), true, '既有标记必须原样保留，不得清除');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});