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
  assert.equal(cfg.wsl_distro, '');
  assert.equal(cfg.open_target, 'cli');
  assert.equal(cfg.open_web_url, 'http://127.0.0.1:58627/');
  assert.equal(cfg.session.staleMinutes, 10);
  assert.equal(cfg.session.cleanupMinutes, 60);
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
    renderer_path: 123,
    host_grace_seconds: 'abc',
    restart_max_attempts: -1,
    terminal: 'xterm',
    auto_quit_with_host: 'yes',
    log_level: 'verbose',
  });
  const { config, warnings } = loadConfig({}, p);
  assert.equal(config.host_grace_seconds, 120);
  assert.equal(config.renderer_path, path.join(process.cwd(), 'renderer', 'Pet.exe'));
  assert.equal(config.restart_max_attempts, 5);
  assert.equal(config.terminal, 'wt');
  assert.equal(config.auto_quit_with_host, true);
  assert.equal(config.log_level, 'info');
  assert.ok(warnings.length >= 6, `应有逐项告警，实际 ${warnings.length} 条`);
});

test('open_target / open_web_url：默认值、合法覆盖与非法回退（§7）', () => {
  const dir = tempDir();
  const p1 = writeConfig(dir, { open_target: 'web', open_web_url: 'https://example.com/s/{session_id}' });
  const r1 = loadConfig({}, p1);
  assert.equal(r1.config.open_target, 'web');
  assert.equal(r1.config.open_web_url, 'https://example.com/s/{session_id}');

  const p2 = writeConfig(dir, { open_target: 'browser', open_web_url: '' });
  const r2 = loadConfig({}, p2);
  assert.equal(r2.config.open_target, 'cli', '非法 open_target 回退默认 cli');
  assert.equal(r2.config.open_web_url, 'http://127.0.0.1:58627/', '空字符串 open_web_url 回退默认');
  assert.ok(r2.warnings.some((w) => w.includes('open_target')));
  assert.ok(r2.warnings.some((w) => w.includes('open_web_url')));

  const p3 = writeConfig(dir, { open_web_url: 123 });
  const r3 = loadConfig({}, p3);
  assert.equal(r3.config.open_web_url, 'http://127.0.0.1:58627/', '非字符串 open_web_url 回退默认');
});

test('session.staleMinutes/session.cleanupMinutes：嵌套对象与扁平带点键两种写法都支持', () => {
  const dir = tempDir();
  const p1 = writeConfig(dir, { session: { staleMinutes: 3 } });
  const r1 = loadConfig({}, p1);
  assert.equal(r1.config.session.staleMinutes, 3);
  const p2 = writeConfig(dir, { 'session.staleMinutes': 5 });
  const r2 = loadConfig({}, p2);
  assert.equal(r2.config.session.staleMinutes, 5);
  const p3 = writeConfig(dir, { session: { staleMinutes: 'x' } });
  assert.equal(loadConfig({}, p3).config.session.staleMinutes, 10, '非法值回退默认');
  const p4 = writeConfig(dir, { session: { staleMinutes: 3, cleanupMinutes: 30 } });
  const r4 = loadConfig({}, p4);
  assert.equal(r4.config.session.cleanupMinutes, 30);
  const p5 = writeConfig(dir, { 'session.staleMinutes': 3, 'session.cleanupMinutes': 40 });
  const r5 = loadConfig({}, p5);
  assert.equal(r5.config.session.cleanupMinutes, 40);
  const p6 = writeConfig(dir, { session: { staleMinutes: 10, cleanupMinutes: 5 } });
  assert.equal(loadConfig({}, p6).config.session.cleanupMinutes, 60, '清理时长必须大于 staleMinutes');
  const p7 = writeConfig(dir, { session: { staleMinutes: 60 } });
  assert.equal(
    loadConfig({}, p7).config.session.cleanupMinutes,
    61,
    '未配置 cleanupMinutes 时，staleMinutes=60 应只提升到下一个整分钟',
  );
  const p8 = writeConfig(dir, { session: { staleMinutes: 90 } });
  assert.equal(
    loadConfig({}, p8).config.session.cleanupMinutes,
    91,
    '未配置 cleanupMinutes 时，不应按 staleMinutes 的倍数放大',
  );
  const p9 = writeConfig(dir, { session: { staleMinutes: 59.5 } });
  assert.equal(
    loadConfig({}, p9).config.session.cleanupMinutes,
    60.5,
    '默认清理时长必须严格大于小数 staleMinutes',
  );
});

test('renderer_path 类型非法时逐项回退默认路径并告警', () => {
  const dir = tempDir();
  const p = writeConfig(dir, { renderer_path: { path: 'Pet.exe' } });
  const { config, warnings } = loadConfig({ KIMI_PLUGIN_ROOT: 'C:\\plugins\\kimi-pet' }, p);
  assert.equal(config.renderer_path, path.join('C:\\plugins\\kimi-pet', 'renderer', 'Pet.exe'));
  assert.ok(warnings.some((warning) => warning.includes('renderer_path')));
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

test('expandEnvVars：同时支持 %VAR%、$VAR 与 ${VAR}，未定义变量替换为空串', () => {
  const env = { KIMI_PLUGIN_ROOT: 'C:\\plugins\\kimi-pet', HOME: '/home/kimi' };
  assert.equal(expandEnvVars('%KIMI_PLUGIN_ROOT%\\renderer\\Pet.exe', env), 'C:\\plugins\\kimi-pet\\renderer\\Pet.exe');
  assert.equal(expandEnvVars('$KIMI_PLUGIN_ROOT/renderer/Pet', env), 'C:\\plugins\\kimi-pet/renderer/Pet');
  assert.equal(expandEnvVars('${KIMI_PLUGIN_ROOT}/renderer/Pet', env), 'C:\\plugins\\kimi-pet/renderer/Pet');
  assert.equal(expandEnvVars('$HOME/.kimi-code', env), '/home/kimi/.kimi-code');
  assert.equal(expandEnvVars('${HOME}/.kimi-code', env), '/home/kimi/.kimi-code');
  assert.equal(expandEnvVars('$HOME_SUFFIX', env), '', '$VAR 按完整变量名匹配，未定义替换为空串');
  assert.equal(expandEnvVars('$UNDEFINED_VAR/x', env), '/x', '未定义 $VAR 替换为空串');
  assert.equal(expandEnvVars('${UNDEFINED_VAR}/x', env), '/x', '未定义 ${VAR} 替换为空串');
  assert.equal(expandEnvVars('%UNDEFINED_VAR%\\x', env), '\\x', '未定义 %VAR% 替换为空串');
  assert.equal(
    expandEnvVars('$KIMI_PLUGIN_ROOT/${KIMI_PLUGIN_ROOT}/%KIMI_PLUGIN_ROOT%', env),
    'C:\\plugins\\kimi-pet/C:\\plugins\\kimi-pet/C:\\plugins\\kimi-pet',
    '三种语法可混用',
  );
});

test('resolveRendererPath：默认路径按平台选择，显式配置不受影响', () => {
  // 显式配置：任何平台下都原样走环境变量展开，不涉及平台分支
  assert.equal(
    resolveRendererPath('$KIMI_PLUGIN_ROOT/renderer/Pet.exe', { KIMI_PLUGIN_ROOT: '/plugins/kimi-pet' }),
    '/plugins/kimi-pet/renderer/Pet.exe',
  );
  assert.equal(
    resolveRendererPath('${KIMI_PLUGIN_ROOT}\\renderer\\Pet', { KIMI_PLUGIN_ROOT: '/plugins/kimi-pet' }),
    '/plugins/kimi-pet\\renderer\\Pet',
  );

  const original = process.platform;
  try {
    // win32：Pet.exe
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    assert.equal(
      resolveRendererPath(undefined, { KIMI_PLUGIN_ROOT: 'C:\\plugins\\kimi-pet' }),
      path.join('C:\\plugins\\kimi-pet', 'renderer', 'Pet.exe'),
    );
    assert.equal(resolveRendererPath(undefined, {}), path.join(process.cwd(), 'renderer', 'Pet.exe'));

    // darwin：Pet.app/Contents/MacOS/Pet
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    assert.equal(
      resolveRendererPath(undefined, { KIMI_PLUGIN_ROOT: '/plugins/kimi-pet' }),
      path.join('/plugins/kimi-pet', 'renderer', 'Pet.app', 'Contents', 'MacOS', 'Pet'),
    );
    assert.equal(
      resolveRendererPath(undefined, {}),
      path.join(process.cwd(), 'renderer', 'Pet.app', 'Contents', 'MacOS', 'Pet'),
    );

    // 其他平台：Pet
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    assert.equal(
      resolveRendererPath(undefined, { KIMI_PLUGIN_ROOT: '/plugins/kimi-pet' }),
      path.join('/plugins/kimi-pet', 'renderer', 'Pet'),
    );
    assert.equal(resolveRendererPath(undefined, {}), path.join(process.cwd(), 'renderer', 'Pet'));
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
});

test('terminal：支持 wt/cmd/wsl，非法值回退默认并告警', () => {
  const dir = tempDir();
  assert.equal(loadConfig({}, writeConfig(dir, { terminal: 'wsl' })).config.terminal, 'wsl');
  const r = loadConfig({}, writeConfig(dir, { terminal: 1 }));
  assert.equal(r.config.terminal, 'wt');
  assert.ok(r.warnings.some((w) => w.includes('terminal')));
});

test('wsl_distro：缺省空串；字符串合法；非法类型回退默认并告警', () => {
  const dir = tempDir();
  assert.equal(loadConfig({}, writeConfig(dir, {})).config.wsl_distro, '', '文件未配置时保持默认空串');
  assert.equal(loadConfig({}, writeConfig(dir, { wsl_distro: '' })).config.wsl_distro, '', '空串为合法值');
  assert.equal(
    loadConfig({}, writeConfig(dir, { wsl_distro: 'Ubuntu-22.04' })).config.wsl_distro,
    'Ubuntu-22.04',
  );
  const r = loadConfig({}, writeConfig(dir, { wsl_distro: 123 }));
  assert.equal(r.config.wsl_distro, '', '非字符串回退默认空串');
  assert.ok(r.warnings.some((w) => w.includes('wsl_distro')));
});
