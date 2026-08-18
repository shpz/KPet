/**
 * WSL ↔ Windows 路径转换测试（跨平台兼容方案 §3.1 形态一）。
 * 纯字符串转换，覆盖盘符挂载（/mnt/<盘符>）、WSL 原生 ext4（/home/...）、
 * 反向 UNC（\\wsl.localhost\<distro>\ 与 \\wsl$\<distro>\）与幂等/降级返回。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wslToWindowsPath, windowsToWslPath } from '../src/daemon/wsl-path.js';

test('wslToWindowsPath：/mnt/<盘符> → 盘符大写 + 反斜杠 Windows 路径', () => {
  assert.equal(wslToWindowsPath('/mnt/c/Users/me'), 'C:\\Users\\me');
  assert.equal(wslToWindowsPath('/mnt/d/projects/kimi'), 'D:\\projects\\kimi');
  assert.equal(wslToWindowsPath('/mnt/c'), 'C:\\');
});

test('wslToWindowsPath：/home 等原生路径 + 发行版 → \\wsl.localhost\<distro>\...', () => {
  assert.equal(
    wslToWindowsPath('/home/me/.kimi-code', 'Ubuntu'),
    '\\\\wsl.localhost\\Ubuntu\\home\\me\\.kimi-code',
  );
  assert.equal(wslToWindowsPath('/usr/local/bin', 'Debian'), '\\\\wsl.localhost\\Debian\\usr\\local\\bin');
});

test('wslToWindowsPath：发行版为空/未指定 → 原生路径原样返回（无法确定归属）', () => {
  assert.equal(wslToWindowsPath('/home/me', ''), '/home/me');
  assert.equal(wslToWindowsPath('/home/me'), '/home/me');
});

test('wslToWindowsPath：非 / 开头输入（Windows 路径 / 相对路径）→ 原样返回', () => {
  assert.equal(wslToWindowsPath('D:\\ws'), 'D:\\ws');
  assert.equal(wslToWindowsPath('relative/path', 'Ubuntu'), 'relative/path');
});

test('windowsToWslPath：盘符路径 → /mnt/<小写盘符>/...', () => {
  assert.equal(windowsToWslPath('C:\\Users\\me'), '/mnt/c/Users/me');
  assert.equal(windowsToWslPath('D:\\projects'), '/mnt/d/projects');
  assert.equal(windowsToWslPath('C:\\'), '/mnt/c');
});

test('windowsToWslPath：盘符路径分隔符为正斜杠同样转换', () => {
  assert.equal(windowsToWslPath('C:/Users/me'), '/mnt/c/Users/me');
});

test('windowsToWslPath：\\wsl.localhost\<distro>\ → 去掉发行版段的正斜杠路径', () => {
  assert.equal(windowsToWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me'), '/home/me');
  assert.equal(windowsToWslPath('\\\\wsl.localhost\\Debian\\usr\\local\\bin'), '/usr/local/bin');
});

test('windowsToWslPath：\\wsl$\<distro>\ 历史别名同样转换', () => {
  assert.equal(windowsToWslPath('\\\\wsl$\\Ubuntu\\home\\me'), '/home/me');
});

test('windowsToWslPath：已属 Linux 形态/相对路径/仅发行版无路径 → 原样返回（幂等）', () => {
  assert.equal(windowsToWslPath('/mnt/c/Users/me'), '/mnt/c/Users/me');
  assert.equal(windowsToWslPath('relative/path'), 'relative/path');
  assert.equal(windowsToWslPath('\\\\wsl.localhost\\Ubuntu'), '\\\\wsl.localhost\\Ubuntu');
});

test('双向互转：/mnt 盘符与 Windows 盘符往返一致', () => {
  const linux = '/mnt/c/Users/me/proj';
  const win = 'C:\\Users\\me\\proj';
  assert.equal(wslToWindowsPath(linux), win);
  assert.equal(windowsToWslPath(win), linux);
});

test('双向互转：原生 ext4 路径与 UNC 往返一致（同一发行版）', () => {
  const linux = '/home/me/proj';
  const unc = '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj';
  assert.equal(wslToWindowsPath(linux, 'Ubuntu'), unc);
  assert.equal(windowsToWslPath(unc), linux);
});