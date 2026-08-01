/**
 * 用户名过滤与管道名构造单测（§4.1：管道名不允许 \，多用户同机隔离）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventPipeName, sanitizePipeUser } from '../src/bridge/user.js';

test('sanitizePipeUser：合法用户名原样保留（含空格）', () => {
  assert.equal(sanitizePipeUser('John Doe'), 'John Doe');
  assert.equal(sanitizePipeUser('Luo_x'), 'Luo_x');
  assert.equal(sanitizePipeUser('user-1.2'), 'user-1.2');
});

test('sanitizePipeUser：反斜杠（管道名硬限制）与其他保留字符替换为 _', () => {
  assert.equal(sanitizePipeUser('DOMAIN\\user'), 'DOMAIN_user');
  assert.equal(sanitizePipeUser('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i');
  assert.equal(sanitizePipeUser('ctrl\u0007char'), 'ctrl_char');
});

test('sanitizePipeUser：过滤后为空回退 default，保证管道名段非空', () => {
  assert.equal(sanitizePipeUser(''), 'default');
  assert.equal(sanitizePipeUser('   '), 'default');
  assert.equal(sanitizePipeUser('\\'), '_', '单个反斜杠替换后非空则保留替换结果');
});

test('getEventPipeName：格式为 \\\\.\\pipe\\KimiPet.H2D.<用户名>（§4.1）', () => {
  assert.equal(getEventPipeName('Luo_x'), '\\\\.\\pipe\\KimiPet.H2D.Luo_x');
  assert.equal(getEventPipeName('DOMAIN\\Luo_x'), '\\\\.\\pipe\\KimiPet.H2D.DOMAIN_Luo_x');
});

test('getEventPipeName：不同用户名管道名不同（多用户隔离）', () => {
  assert.notEqual(getEventPipeName('alice'), getEventPipeName('bob'));
});
