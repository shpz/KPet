/**
 * 守护进程配置测试（docs/MVP设计.md §7）。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  defaultConfig,
  expandEnvVars,
  getConfigPath,
  getKimipetHome,
  getLogFilePath,
  loadConfig,
  resolveRendererPath,
} from '../src/daemon/config.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-pet-config-test-'));
}

function writeConfig(dir: string, obj: unknown): string {
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

test('默认配置：§7 全部键与默认值', () => {
  const cfg = defaultConfig({ KIMI_PLUGIN_ROOT: 'C:\\plugins\\kimi-pet' });
  assert.equal(cfg.renderer_path, path.join('C:\\plugins\\kimi-pet', 'renderer', 'Pet.exe'));
  assert.equal(cfg.heartbeat_interval_ms, 3000);
  assert.equal(cfg.heartbeat_timeout_ms, 10_000);
  assert.equal(cfg.restart_max_attempts, 5);
  assert.equal(cfg.restart_window_s, 60);
  assert.equal(cfg.host_grace_seconds, 120);
  assert.equal(cfg.auto_quit_with_host, true);
  assert.equal(cfg.terminal, 'wt');
  assert.equal(cfg.session.staleMinutes, 10);
  assert.equal(cfg.log_level, 'info');
});

test('配置文件缺失 → 默认配置 + 告警（§7：不存在则用默认值）', () => {
  const { config, warnings, source } = loadConfig({}, path.join(tempDir(), 'nope', 'config.json'));
  assert.equal(source, 'default');
  assert.equal(config.session.staleMinutes, 10);
  assert.equal(warnings.length, 1);
});

test('配置文件 JSON 非法 → 默认配置 + 告警', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, 'not json', 'utf8');
  const { config, source } = loadConfig({}, p);
  assert.equal(source, 'default');
  assert.equal(config.host_grace_seconds, 120);
});

test('部分键覆盖：其余键保持默认', () => {
  const dir = tempDir();
  const p = writeConfig(dir, { host_grace_seconds: 30, terminal: 'cmd', log_level: 'debug' });
  const { config, source } = loadConfig({}, p);
  assert.equal(source, 'file');
  assert.equal(config.host_grace_seconds, 30);
  assert.equal(config.terminal, 'cmd');
  assert.equal(config.log_level, 'debug');
  assert.equal(config.heartbeat_interval_ms, 3000, '未配置键保持默认');
  assert.equal(config.auto_quit_with_host, true);
});

test('类型非法逐项回退：字符串数字/负数/非法枚举 → 默认值 + 告警', () => {
  const dir = tempDir();
  const p = writeConfig(dir, {
    host_grace_seconds: 'abc',
    restart_max_attempts: -1,
    terminal: 'xterm',
    auto_quit_with_host: 'yes',
    log_level: 'verbose',
  });
  const { config, warnings } = loadConfig({}, p);
  assert.equal(config.host_grace_seconds, 120);
  assert.equal(config.restart_max_attempts, 5);
  assert.equal(config.terminal, 'wt');
  assert.equal(config.auto_quit_with_host, true);
  assert.equal(config.log_level, 'info');
  assert.ok(warnings.length >= 5, `应有逐项告警，实际 ${warnings.length} 条`);
});

test('session.staleMinutes：嵌套对象与扁平带点键两种写法都支持', () => {
  const dir = tempDir();
  const p1 = writeConfig(dir, { session: { staleMinutes: 3 } });
  const r1 = loadConfig({}, p1);
  assert.equal(r1.config.session.staleMinutes, 3);
  const p2 = writeConfig(dir, { 'session.staleMinutes': 5 });
  const r2 = loadConfig({}, p2);
  assert.equal(r2.config.session.staleMinutes, 5);
  const p3 = writeConfig(dir, { session: { staleMinutes: 'x' } });
  assert.equal(loadConfig({}, p3).config.session.staleMinutes, 10, '非法值回退默认');
});

test('heartbeat_timeout_ms 允许 0（关闭心跳检测）', () => {
  const dir = tempDir();
  const p = writeConfig(dir, { heartbeat_timeout_ms: 0 });
  assert.equal(loadConfig({}, p).config.heartbeat_timeout_ms, 0);
});

test('renderer_path：%KIMI_PLUGIN_ROOT% 环境展开；KIMI_PLUGIN_ROOT 未设时回退 cwd', () => {
  const env = { KIMI_PLUGIN_ROOT: 'C:\\plugins\\kimi-pet' };
  assert.equal(resolveRendererPath(undefined, env), path.join('C:\\plugins\\kimi-pet', 'renderer', 'Pet.exe'));
  assert.equal(expandEnvVars('%KIMI_PLUGIN_ROOT%\\renderer\\Pet.exe', env), 'C:\\plugins\\kimi-pet\\renderer\\Pet.exe');
  const noRoot = resolveRendererPath(undefined, {});
  assert.equal(noRoot, path.join(process.cwd(), 'renderer', 'Pet.exe'));
});

test('getKimipetHome / getConfigPath / getLogFilePath：KIMI_CODE_HOME 优先，缺省 ~/.kimi-code', () => {
  assert.equal(getKimipetHome({ KIMI_CODE_HOME: 'C:\\kc' }), path.join('C:\\kc', 'kimipet'));
  assert.equal(getConfigPath({ KIMI_CODE_HOME: 'C:\\kc' }), path.join('C:\\kc', 'kimipet', 'config.json'));
  assert.equal(getLogFilePath({ KIMI_CODE_HOME: 'C:\\kc' }), path.join('C:\\kc', 'kimipet', 'logs', 'kimi-petd.log'));
  assert.equal(getKimipetHome({}), path.join(os.homedir(), '.kimi-code', 'kimipet'));
});
