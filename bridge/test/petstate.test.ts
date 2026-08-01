/**
 * pet_moved 持久化测试（docs/MVP设计.md §6.4：%APPDATA%/KimiPet/pet-state.json，防抖 500ms 写入）。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { getPetStatePath, PetStateStore, type PetStateFile } from '../src/daemon/petstate.js';

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-pet-petstate-test-'));
  return path.join(dir, 'pet-state.json');
}

test('updateWindow 防抖合并：500ms 内多次更新只落盘一次，保留最后值（§6.4 防抖 500ms）', async () => {
  const p = tempFile();
  try {
    const store = new PetStateStore(p, { debounceMs: 200 });
    store.updateWindow(10, 20, 'MON1');
    store.updateWindow(30, 40, 'MON1');
    store.updateWindow(50, 60, 'MON1');
    await new Promise((r) => setTimeout(r, 400));
    const disk = JSON.parse(fs.readFileSync(p, 'utf8')) as PetStateFile;
    assert.deepEqual(disk.window, { x: 50, y: 60, monitor_id: 'MON1' });
    assert.equal(disk.version, 1);
  } finally {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

test('flush 强制落盘（守护进程退出前），未到防抖也写入', () => {
  const p = tempFile();
  try {
    const store = new PetStateStore(p, { debounceMs: 60_000 });
    store.updateWindow(1, 2, 'M');
    store.flush();
    const disk = JSON.parse(fs.readFileSync(p, 'utf8')) as PetStateFile;
    assert.deepEqual(disk.window, { x: 1, y: 2, monitor_id: 'M' });
  } finally {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

test('加载已有文件并合并 window（保留 pet 字段）；损坏文件回退默认（§6.4 不阻断启动）', () => {
  const p = tempFile();
  try {
    fs.writeFileSync(
      p,
      JSON.stringify({ window: { x: 7, y: 8, monitor_id: 'MON2' }, pet: { yaw: 15 }, version: 1 }),
    );
    const store = new PetStateStore(p);
    assert.deepEqual(store.window, { x: 7, y: 8, monitor_id: 'MON2' });
    store.updateWindow(9, 10, 'MON2');
    store.flush();
    const disk = JSON.parse(fs.readFileSync(p, 'utf8')) as PetStateFile;
    assert.deepEqual(disk.window, { x: 9, y: 10, monitor_id: 'MON2' });
    assert.deepEqual(disk.pet, { yaw: 15 }, 'pet 字段不被覆盖');
  } finally {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

test('损坏/版本不符文件 → 整体回退默认，不阻断启动（§6.4）', () => {
  const p = tempFile();
  try {
    fs.writeFileSync(p, 'not json');
    const store = new PetStateStore(p);
    assert.equal(store.window, undefined);
    store.flush(); // 损坏文件被合法内容覆盖
    const disk = JSON.parse(fs.readFileSync(p, 'utf8')) as PetStateFile;
    assert.equal(disk.version, 1);
  } finally {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

test('非法坐标/类型 → 丢弃不写入（§4.3 pet_moved 字段防御）', () => {
  const p = tempFile();
  try {
    const store = new PetStateStore(p, { debounceMs: 0 });
    store.updateWindow(Number.NaN, 5, 'M'); // 非法
    store.flush();
    assert.equal(store.window, undefined);
  } finally {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

test('getPetStatePath：%APPDATA%/KimiPet/pet-state.json（§6.4）', () => {
  assert.equal(getPetStatePath('C:\\Users\\x\\AppData\\Roaming'), path.join('C:\\Users\\x\\AppData\\Roaming', 'KimiPet', 'pet-state.json'));
});
