/**
 * 插件清单与 WSL relay 脚本一致性测试（跨平台兼容方案 §5 P1-7）。
 * 保证 kimi.plugin.wsl.json 与 Windows 清单（kimi.plugin.json）钩子一一对应，仅 command 指向
 * bin/kimi-pet-relay.sh；并校验 relay 脚本存在、为 LF 行尾（WSL 的 sh 不接受 CR）且包含关键路径解析逻辑。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// 运行期位于 dist-test/test/ 下，向上两级回到 bridge/ 再进 packaging（与源码工程结构一致）
const PACKAGE_DIR = fileURLToPath(new URL('../../packaging/kimi-pet', import.meta.url));
const RELAY_PATH = fileURLToPath(new URL('../../packaging/kimi-pet/bin/kimi-pet-relay.sh', import.meta.url));

interface Hook {
  event: string;
  matcher?: string;
  command: string;
  timeout: number;
}

function loadManifest(name: string): { hooks: Hook[] } {
  return JSON.parse(fs.readFileSync(`${PACKAGE_DIR}/${name}`, 'utf8')) as { hooks: Hook[] };
}

test('kimi.plugin.wsl.json：钩子与 Windows 清单一一对应，command 指向 relay 脚本', () => {
  const win = loadManifest('kimi.plugin.json');
  const wsl = loadManifest('kimi.plugin.wsl.json');
  assert.equal(wsl.hooks.length, win.hooks.length, '钩子数量应与 Windows 清单一致');
  for (let i = 0; i < win.hooks.length; i++) {
    assert.equal(wsl.hooks[i]!.event, win.hooks[i]!.event, `第 ${i} 个钩子 event 一致`);
    assert.equal(wsl.hooks[i]!.matcher, win.hooks[i]!.matcher, `第 ${i} 个钩子 matcher 一致`);
    assert.equal(wsl.hooks[i]!.timeout, win.hooks[i]!.timeout, `第 ${i} 个钩子 timeout 一致`);
    assert.equal(
      wsl.hooks[i]!.command,
      './bin/kimi-pet-relay.sh --relay',
      `第 ${i} 个钩子 command 应指向 relay 脚本且带默认参数 --relay`,
    );
  }
});

test('kimi.plugin.wsl.json：command 使用正斜杠相对路径，无反斜杠/无 .exe（WSL bash 可执行）', () => {
  const wsl = loadManifest('kimi.plugin.wsl.json');
  for (const hook of wsl.hooks) {
    assert.match(hook.command, /^\.\/bin\/kimi-pet-relay\.sh(?: |$)/, `command 使用 ./ 正斜杠前缀: ${hook.command}`);
    assert.ok(!hook.command.includes('\\'), `command 不得含反斜杠: ${hook.command}`);
  }
});

test('kimi-pet-relay.sh：存在且为 LF 行尾，shebang 为 /bin/sh（POSIX sh）', () => {
  const content = fs.readFileSync(RELAY_PATH, 'utf8');
  assert.ok(!content.includes('\r'), '脚本行尾必须为 LF，不得包含 CR（WSL 的 sh 会因 CR 报错）');
  assert.equal(content.split('\n')[0], '#!/bin/sh');
});

test('kimi-pet-relay.sh：优先 KIMI_PLUGIN_ROOT_WIN、wslpath -w 兜底，exec 透传 "$@"', () => {
  const content = fs.readFileSync(RELAY_PATH, 'utf8');
  assert.match(content, /KIMI_PLUGIN_ROOT_WIN/);
  assert.match(content, /wslpath\s+-w/);
  assert.match(content, /kimi-petd\.exe/);
  assert.match(content, /exec\s+["']?\$DAEMON_EXE/);
  assert.match(content, /\$@/);
});