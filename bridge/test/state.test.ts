/**
 * 状态机测试（宿主事件 → 宠物语义映射表，逐条覆盖）。
 * 纯逻辑单测：注入时钟与任务 id 生成器，不碰管道/定时器。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PetStateMachine, TASK_THROTTLE_MS, FALLBACK_TASK_TITLE } from '../src/daemon/state.js';
import type { OutgoingMessage } from '../src/daemon/state.js';

/** 构造一个可控时钟 + 确定性任务 id 的状态机。 */
function makeMachine(staleMinutes = 10) {
  let clock = 1_000_000;
  let taskSeq = 0;
  const machine = new PetStateMachine({
    staleMs: staleMinutes * 60_000,
    now: () => clock,
    genTaskId: () => `task-${++taskSeq}`,
  });
  return {
    machine,
    advance(ms: number): void {
      clock += ms;
    },
    setTime(t: number): void {
      clock = t;
    },
  };
}

/** 事件原始 JSON 构造器（基础字段 hook_event_name/session_id/cwd）。 */
function ev(hook: string, sessionId: string, extra: Record<string, unknown> = {}, cwd = 'D:\\ws'): string {
  return JSON.stringify({ hook_event_name: hook, session_id: sessionId, cwd, ...extra });
}

function byType(out: OutgoingMessage[], type: string): OutgoingMessage[] {
  return out.filter((m) => m.type === type);
}

test('SessionStart：记录活跃会话、下发 session_start + session_state(false,false)、宠物保持 Idle', () => {
  const { machine } = makeMachine();
  const r = machine.processHostEvent(ev('SessionStart', 's1'));
  assert.equal(r.ok, true);
  assert.equal(r.hostIdle, false);
  const ss = byType(r.out, 'session_start');
  assert.equal(ss.length, 1);
  assert.equal((ss[0] as { payload: { cwd: string } }).payload.cwd, 'D:\\ws');
  const state = byType(r.out, 'session_state');
  assert.equal(state.length, 1);
  assert.equal(state[0]!.session_id, 's1');
  assert.deepEqual(state[0]!.payload, { working: false, unread: false });
  assert.equal(machine.activeSessions, 1);
  assert.equal(machine.state, 'Idle');
  const snap = machine.getSnapshot();
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0]!.sessionId, 's1');
});

test('SessionStart（resume matcher）：resume=true', () => {
  const { machine } = makeMachine();
  const r = machine.processHostEvent(ev('SessionStart', 's1', { matcher: 'startup|resume' }));
  const ss = byType(r.out, 'session_start');
  assert.equal((ss[0] as { payload: { resume: boolean } }).payload.resume, true);
});

test('UserPromptSubmit：会话转忙 → pet_state Working（reason=user_prompt），比等 PreToolUse 更早', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('SessionStart', 's1'));
  const r = machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  const ps = byType(r.out, 'pet_state');
  assert.equal(ps.length, 1);
  assert.deepEqual(ps[0]!.payload, { state: 'Working', reason: 'user_prompt' });
  assert.deepEqual(byType(r.out, 'session_state')[0]!.payload, { working: true, unread: false });
  assert.equal(machine.state, 'Working');
});

test('UserPromptSubmit：清除会话未读标记并保持 working=true', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('SessionStart', 's1'));
  machine.processHostEvent(ev('Stop', 's1'));
  const r = machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  assert.deepEqual(byType(r.out, 'session_state')[0]!.payload, { working: true, unread: false });
  assert.deepEqual(machine.getSnapshot().sessions[0], {
    sessionId: 's1',
    cwd: 'D:\\ws',
    resume: false,
    busy: true,
    unread: false,
  });
});

test('PreToolUse：生成任务 id 下发 task_start（标题取 tool_input.command），保持 Working', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  const r = machine.processHostEvent(
    ev('PreToolUse', 's1', { tool_name: 'bash', tool_input: { command: 'npm test' } }),
  );
  assert.equal(r.throttled, true);
  // task_start 走 200ms 节流缓冲，立即 drain 取回
  const out = machine.drainThrottled('s1', true);
  const ts = byType(out, 'task_start');
  assert.equal(ts.length, 1);
  assert.deepEqual((ts[0] as { payload: unknown }).payload, {
    task_id: 'task-1',
    title: 'npm test',
    tool: 'bash',
  });
  const snap = machine.getSnapshot();
  assert.equal(snap.tasks.length, 1);
  assert.equal(snap.tasks[0]!.title, 'npm test');
});

test('PreToolUse 无命令文本：标题取工具名', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  machine.processHostEvent(ev('PreToolUse', 's1', { tool_name: 'bash' }));
  const out = machine.drainThrottled('s1', true);
  assert.equal((byType(out, 'task_start')[0] as { payload: { title: string } }).payload.title, 'bash');
});

test('PreToolUse 无命令也无工具名：标题降级「正在工作…」（字段取值防御）', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  machine.processHostEvent(ev('PreToolUse', 's1'));
  const out = machine.drainThrottled('s1', true);
  const ts = byType(out, 'task_start')[0] as { payload: { title: string; tool: string } };
  assert.equal(ts.payload.title, FALLBACK_TASK_TITLE);
  assert.equal(ts.payload.tool, 'tool');
});

test('PostToolUse：同会话同工具任务 → task_end(success)，任务从快照移除', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  machine.processHostEvent(ev('PreToolUse', 's1', { tool_name: 'bash', tool_input: { command: 'npm test' } }));
  const r = machine.processHostEvent(ev('PostToolUse', 's1', { tool_name: 'bash', tool_output: { summary: 'ok' } }));
  const out = machine.drainThrottled('s1', true);
  const te = byType(out, 'task_end');
  assert.equal(te.length, 1);
  assert.deepEqual((te[0] as { payload: unknown }).payload, {
    task_id: 'task-1',
    status: 'success',
    title: 'npm test',
    summary: 'ok',
  });
  assert.equal(machine.getSnapshot().tasks.length, 0, '完成后任务表为空');
  assert.equal(byType(r.out, 'notify').length, 0, '成功不另发 notify');
});

test('PostToolUseFailure：task_end(failure) + notify(error) 另发', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  machine.processHostEvent(ev('PreToolUse', 's1', { tool_name: 'bash', tool_input: { command: 'npm test' } }));
  const r = machine.processHostEvent(ev('PostToolUseFailure', 's1', { tool_name: 'bash' }));
  const out = machine.drainThrottled('s1', true);
  const te = byType(out, 'task_end');
  assert.equal(te.length, 1);
  assert.equal((te[0] as { payload: { status: string } }).payload.status, 'failure');
  const notify = byType(r.out, 'notify');
  assert.equal(notify.length, 1);
  assert.equal((notify[0] as { payload: { level: string } }).payload.level, 'error');
  assert.equal((notify[0] as { payload: { text: string } }).payload.text, '任务失败：npm test');
});

test('SubagentStart/SubagentStop：视同 task_start/task_end（工具名=子代理名）', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  machine.processHostEvent(ev('SubagentStart', 's1', { subagent_name: 'explorer' }));
  const out = machine.drainThrottled('s1', true);
  assert.equal((byType(out, 'task_start')[0] as { payload: { tool: string } }).payload.tool, 'explorer');
  machine.processHostEvent(ev('SubagentStop', 's1', { subagent_name: 'explorer' }));
  const out2 = machine.drainThrottled('s1', true);
  const te = byType(out2, 'task_end');
  assert.equal(te.length, 1);
  assert.equal((te[0] as { payload: { task_id: string } }).payload.task_id, 'task-1');
});

test('PostToolUse 无匹配任务：忽略，无输出（任务不在守护进程可见范围内）', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('SessionStart', 's1'));
  const r = machine.processHostEvent(ev('PostToolUse', 's1', { tool_name: 'bash' }));
  assert.equal(r.ok, true);
  assert.equal(r.out.length, 0);
  assert.equal(machine.drainThrottled('s1', true).length, 0);
});

test('Stop：会话转闲，无忙会话 → pet_state Idle；未完成任务静默清空（不弹完成气泡）', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  machine.processHostEvent(ev('PreToolUse', 's1', { tool_name: 'bash' }));
  const r = machine.processHostEvent(ev('Stop', 's1'));
  assert.equal(machine.state, 'Idle');
  assert.deepEqual(byType(r.out, 'pet_state')[0]!.payload, { state: 'Idle', reason: 'stop' });
  assert.equal(machine.getSnapshot().tasks.length, 0, 'Stop 后任务表清空');
  assert.equal(machine.drainThrottled('s1', true).length, 0, '节流缓冲一并丢弃');
  assert.equal(byType(r.out, 'notify').length, 0);
  assert.deepEqual(byType(r.out, 'session_state')[0]!.payload, { working: false, unread: true });
});

test('StopFailure：转 Idle + notify(error)「任务出错」，不弹完成气泡', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  const r = machine.processHostEvent(ev('StopFailure', 's1'));
  assert.deepEqual(byType(r.out, 'pet_state')[0]!.payload, { state: 'Idle', reason: 'stop_failure' });
  const notify = byType(r.out, 'notify');
  assert.equal(notify.length, 1);
  assert.deepEqual((notify[0] as { payload: unknown }).payload, { text: '任务出错', level: 'error' });
  assert.deepEqual(byType(r.out, 'session_state')[0]!.payload, { working: false, unread: true });
});

test('Interrupt：转 Idle，不弹完成气泡', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  const r = machine.processHostEvent(ev('Interrupt', 's1'));
  assert.deepEqual(byType(r.out, 'pet_state')[0]!.payload, { state: 'Idle', reason: 'interrupt' });
  assert.equal(byType(r.out, 'notify').length, 0);
  assert.deepEqual(byType(r.out, 'session_state')[0]!.payload, { working: false, unread: false });
});

test('Interrupt：保留已有 unread 标记，只更新 working=false', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('SessionStart', 's1'));
  machine.processHostEvent(ev('Stop', 's1'));
  const r = machine.processHostEvent(ev('Interrupt', 's1'));
  assert.deepEqual(byType(r.out, 'session_state')[0]!.payload, { working: false, unread: true });
});

test('Notification：notify(success) 气泡，不改主状态（Working 期间到达）', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  const r = machine.processHostEvent(ev('Notification', 's1', { notification: { text: '构建完成' } }));
  assert.equal(machine.state, 'Working', 'Notification 不改主状态');
  const notify = byType(r.out, 'notify');
  assert.equal(notify.length, 1);
  assert.deepEqual((notify[0] as { payload: unknown }).payload, { text: '构建完成', level: 'success' });
});

test('Notification 无文案：降级「后台任务完成」', () => {
  const { machine } = makeMachine();
  const r = machine.processHostEvent(ev('Notification', 's1'));
  assert.equal((byType(r.out, 'notify')[0] as { payload: { text: string } }).payload.text, '后台任务完成');
});

test('SessionEnd：移除会话、下发 session_end(reason)、最后一个 → pet_state Idle + hostIdle', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  const r = machine.processHostEvent(ev('SessionEnd', 's1', { reason: 'exit' }));
  assert.equal(machine.activeSessions, 0);
  const se = byType(r.out, 'session_end');
  assert.equal(se.length, 1);
  assert.equal((se[0] as { payload: { reason: string } }).payload.reason, 'exit');
  assert.deepEqual(byType(r.out, 'pet_state')[0]!.payload, { state: 'Idle', reason: 'session_end' });
  assert.equal(r.hostIdle, true, '无活跃会话 → 调用方启动退出倒计时');
});

test('SessionEnd 非最后一个：删除忙会话后仍有空闲会话 → 重新汇总为 Idle', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  machine.processHostEvent(ev('SessionStart', 's2'));
  assert.equal(machine.state, 'Working');
  const r = machine.processHostEvent(ev('SessionEnd', 's1'));
  assert.equal(r.hostIdle, false);
  assert.deepEqual(byType(r.out, 'pet_state')[0]!.payload, { state: 'Idle', reason: 'session_end' });
  assert.equal(machine.state, 'Idle', '剩余会话均空闲');
  assert.equal(machine.activeSessions, 1);
});

test('SessionEnd 非最后一个：删除空闲会话后仍有忙会话 → 保持 Working', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('SessionStart', 's1'));
  machine.processHostEvent(ev('UserPromptSubmit', 's2'));
  const r = machine.processHostEvent(ev('SessionEnd', 's1'));
  assert.equal(r.hostIdle, false);
  assert.equal(byType(r.out, 'pet_state').length, 0, 's2 仍忙，不应重复下发 Working');
  assert.equal(machine.state, 'Working');
  assert.equal(machine.activeSessions, 1);
});

test('多会话汇总：任一会话忙 → Working，全部闲 → Idle', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('SessionStart', 's1'));
  machine.processHostEvent(ev('SessionStart', 's2'));
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  machine.processHostEvent(ev('UserPromptSubmit', 's2'));
  assert.equal(machine.state, 'Working');
  const r = machine.processHostEvent(ev('Stop', 's1'));
  assert.equal(byType(r.out, 'pet_state').length, 0, 's2 仍忙，状态不切换');
  assert.deepEqual(byType(r.out, 'session_state')[0]!.payload, { working: false, unread: true });
  assert.equal(machine.state, 'Working');
  const r2 = machine.processHostEvent(ev('Stop', 's2'));
  assert.deepEqual(byType(r2.out, 'pet_state')[0]!.payload, { state: 'Idle', reason: 'stop' });
});

test('多会话汇总：仍在工作的会话收到重复 SessionStart 后，另一会话完成不能切换 Idle', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('SessionStart', 's1'));
  machine.processHostEvent(ev('SessionStart', 's2'));
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  machine.processHostEvent(ev('UserPromptSubmit', 's2'));

  // 重新打开 CLI/Web 或独立转发进程乱序时，SessionStart 可能再次抵达同一会话。
  const repeatedStart = machine.processHostEvent(ev('SessionStart', 's2', { matcher: 'resume' }));
  assert.equal(repeatedStart.out.length, 0, '已知会话的重复开始不应重复下发会话或全局状态消息');
  assert.equal(machine.getSnapshot().sessions.find((session) => session.sessionId === 's2')!.busy, true);

  const completed = machine.processHostEvent(ev('Stop', 's1'));
  assert.equal(byType(completed.out, 'pet_state').length, 0, 's2 仍忙，不得错误切换 Idle');
  assert.equal(machine.state, 'Working');
});

test('pet_state 去重：已 Working 时重复 UserPromptSubmit 不再下发', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  const r = machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  assert.equal(byType(r.out, 'pet_state').length, 0);
});

test('首见创建会话：守护进程中途启动，首个事件是 UserPromptSubmit 也能正确归属', () => {
  const { machine } = makeMachine();
  const r = machine.processHostEvent(ev('UserPromptSubmit', 'sX'));
  assert.equal(machine.activeSessions, 1);
  assert.equal((byType(r.out, 'pet_state')[0] as { payload: { state: string } }).payload.state, 'Working');
});

test('迟到的首次 SessionStart：公告会话但保留此前工作状态与任务', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  machine.processHostEvent(ev('PreToolUse', 's1', { tool_name: 'bash' }));

  const lateStart = machine.processHostEvent(ev('SessionStart', 's1', { matcher: 'resume' }));
  assert.equal(byType(lateStart.out, 'pet_state').length, 0, '已有 Working 不应被迟到开始改写');
  assert.deepEqual(byType(lateStart.out, 'session_start')[0]!.payload, { cwd: 'D:\\ws', resume: true });
  assert.deepEqual(byType(lateStart.out, 'session_state')[0]!.payload, { working: true, unread: false });
  assert.equal(machine.getSnapshot().tasks.length, 1);
  assert.equal(machine.hasPendingThrottle('s1'), true);
  assert.equal(machine.state, 'Working');
});

test('未知 hook_event_name：忽略不报错（向前兼容）', () => {
  const { machine } = makeMachine();
  const r = machine.processHostEvent(ev('PermissionRequest', 's1'));
  assert.equal(r.ok, true);
  assert.equal(r.out.length, 0);
  assert.equal(machine.state, 'Idle');
});

test('非法输入：非法 JSON/非对象/缺 hook_event_name/缺 session_id → ok=false（错误计数由调用方做）', () => {
  const { machine } = makeMachine();
  assert.equal(machine.processHostEvent('not json').ok, false);
  assert.equal(machine.processHostEvent('[1,2]').ok, false);
  assert.equal(machine.processHostEvent('{"session_id":"s1"}').ok, false);
  assert.equal(machine.processHostEvent('{"hook_event_name":"Stop"}').ok, false);
  assert.equal(machine.activeSessions, 0, '非法事件不产生会话');
});

test('卡死兜底：忙会话超过 staleMinutes 无事件 → 强制转 Idle 但保留活跃会话', () => {
  const { machine, advance } = makeMachine(10);
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  assert.equal(machine.state, 'Working');
  advance(10 * 60_000 + 1000); // 超过 10 分钟
  const out = machine.markStaleSessions();
  assert.deepEqual(byType(out, 'pet_state')[0]!.payload, { state: 'Idle', reason: 'stale' });
  assert.deepEqual(byType(out, 'session_state')[0]!.payload, { working: false, unread: false });
  assert.equal(byType(out, 'session_end').length, 0, '普通 stale 不移除活跃会话');
  assert.equal(machine.state, 'Idle');
  assert.equal(machine.getSnapshot().tasks.length, 0);
  assert.equal(machine.activeSessions, 1, '普通 stale 保留会话，等待真实 SessionEnd');
});

test('卡死兜底：未超时的忙会话不动', () => {
  const { machine, advance } = makeMachine(10);
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  advance(9 * 60_000);
  assert.equal(machine.markStaleSessions().length, 0);
  assert.equal(machine.state, 'Working');
  assert.equal(machine.activeSessions, 1);
});

test('卡死兜底：idle 会话超过 staleMinutes 仍保留，不下发 session_end', () => {
  const { machine, advance } = makeMachine(10);
  machine.processHostEvent(ev('SessionStart', 's1'));
  machine.processHostEvent(ev('SessionStart', 's2'));
  advance(10 * 60_000 + 1000);
  const out = machine.markStaleSessions();
  assert.equal(byType(out, 'pet_state').length, 0, '全闲超时不产生状态切换消息');
  assert.equal(byType(out, 'session_end').length, 0);
  assert.equal(machine.activeSessions, 2);
});

test('长期异常会话清理：超过 cleanup 时长才回收活跃会话', () => {
  const { machine, advance } = makeMachine(10);
  machine.processHostEvent(ev('SessionStart', 's1'));
  advance(60 * 60_000 + 1000);
  const out = machine.markStaleSessions();
  assert.deepEqual(byType(out, 'session_end').map((m) => m.payload), [{ reason: 'stale_cleanup' }]);
  assert.equal(machine.activeSessions, 0);
});

test('节流合并：同会话 200ms 窗口内连续任务事件攒一批下发', () => {
  const { machine, advance } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  machine.processHostEvent(ev('PreToolUse', 's1', { tool_name: 'bash', tool_input: { command: 'a' } }));
  advance(50);
  machine.processHostEvent(ev('PreToolUse', 's1', { tool_name: 'bash', tool_input: { command: 'b' } }));
  advance(100); // 距首条 150ms，窗口未到
  assert.equal(machine.drainThrottled('s1', false).length, 0, '窗口未到不冲刷');
  advance(60); // 距首条 210ms
  const out = machine.drainThrottled('s1', false);
  const starts = byType(out, 'task_start');
  assert.equal(starts.length, 2, '两条 task_start 一起下发');
  assert.deepEqual(starts.map((m) => (m as { payload: { title: string } }).payload.title), ['a', 'b']);
  assert.equal(machine.drainThrottled('s1', false).length, 0, '冲刷后缓冲清空');
});

test('节流折叠：同窗内 task_start+task_end 折叠为单条 task_end（避免 UI 抖动）', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  machine.processHostEvent(ev('PreToolUse', 's1', { tool_name: 'bash', tool_input: { command: 'x' } }));
  machine.processHostEvent(ev('PostToolUse', 's1', { tool_name: 'bash' }));
  const out = machine.drainThrottled('s1', true);
  assert.equal(byType(out, 'task_start').length, 0);
  const ends = byType(out, 'task_end');
  assert.equal(ends.length, 1);
  assert.equal((ends[0] as { payload: { task_id: string } }).payload.task_id, 'task-1');
  assert.equal((ends[0] as { payload: { status: string } }).payload.status, 'success');
});

test('不同会话的节流互不干扰：各自独立窗口', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  machine.processHostEvent(ev('UserPromptSubmit', 's2'));
  machine.processHostEvent(ev('PreToolUse', 's1', { tool_name: 'bash', tool_input: { command: 'a' } }));
  machine.processHostEvent(ev('PreToolUse', 's2', { tool_name: 'bash', tool_input: { command: 'b' } }));
  const out1 = machine.drainThrottled('s1', true);
  const out2 = machine.drainThrottled('s2', true);
  assert.equal(byType(out1, 'task_start').length, 1);
  assert.equal(byType(out2, 'task_start').length, 1);
});

test('快照内容：活跃会话 + 当前 pet_state + 未完成任务列表', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('SessionStart', 's1', {}, 'D:\\a'));
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  machine.processHostEvent(ev('PreToolUse', 's1', { tool_name: 'bash', tool_input: { command: 'build' } }));
  machine.processHostEvent(ev('SessionStart', 's2', {}, 'D:\\b'));
  const snap = machine.getSnapshot();
  assert.equal(snap.state, 'Working');
  assert.equal(snap.reason, 'user_prompt');
  assert.deepEqual(
    snap.sessions.map((s) => [s.sessionId, s.cwd]),
    [['s1', 'D:\\a'], ['s2', 'D:\\b']],
  );
  assert.equal(snap.tasks.length, 1);
  const t = snap.tasks[0]!;
  assert.equal(t.task_id, 'task-1');
  assert.equal(t.title, 'build');
  assert.equal(t.tool, 'bash');
  assert.ok(!Number.isNaN(Date.parse(t.started_at)), 'started_at 为 ISO 时间串');
});

test('会话快照按最近事件倒序，当前活动会话排在面板前面', () => {
  const { machine, advance } = makeMachine();
  machine.processHostEvent(ev('SessionStart', 's1'));
  advance(10);
  machine.processHostEvent(ev('SessionStart', 's2'));
  advance(10);
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));

  assert.deepEqual(machine.getSnapshot().sessions.map((session) => session.sessionId), ['s1', 's2']);
});

test('SessionEnd 丢弃该会话节流缓冲（已死会话的任务消息不再下发）', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  machine.processHostEvent(ev('PreToolUse', 's1', { tool_name: 'bash' }));
  machine.processHostEvent(ev('SessionEnd', 's1'));
  assert.equal(machine.drainThrottled('s1', true).length, 0);
  assert.equal(machine.hasPendingThrottle('s1'), false);
});

test('markSessionRead：打开会话清除 unread 并返回 session_state 更新', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('SessionStart', 's1'));
  machine.processHostEvent(ev('Stop', 's1'));
  const update = machine.markSessionRead('s1');
  assert.ok(update);
  assert.equal(update!.type, 'session_state');
  assert.equal(update!.session_id, 's1');
  assert.deepEqual(update!.payload, { working: false, unread: false });
  assert.equal(machine.markSessionRead('s1'), null, '重复打开已读会话不重复下发');
  assert.equal(machine.markSessionRead('missing'), null, '会话不存在时不生成更新');
});

test('同会话重复 SessionStart：保持工作状态、任务与节流缓冲', () => {
  const { machine } = makeMachine();
  machine.processHostEvent(ev('SessionStart', 's1'));
  machine.processHostEvent(ev('UserPromptSubmit', 's1'));
  machine.processHostEvent(ev('PreToolUse', 's1', { tool_name: 'bash' }));
  const r = machine.processHostEvent(ev('SessionStart', 's1', { matcher: 'resume' }));
  assert.equal(r.out.length, 0, '重复开始不重复广播 session_start，避免会话列表重复');
  assert.equal(machine.getSnapshot().tasks.length, 1);
  assert.equal(machine.hasPendingThrottle('s1'), true);
  assert.equal(machine.state, 'Working');
  assert.equal(machine.getSnapshot().sessions[0]!.resume, true);
});

test('TaskStart 无 PreToolUse 前置也置忙（防御：task 事件本身意味着在工作）', () => {
  const { machine } = makeMachine();
  const r = machine.processHostEvent(ev('PreToolUse', 's1', { tool_name: 'bash' }));
  assert.equal(machine.state, 'Working');
  assert.equal((byType(r.out, 'pet_state')[0] as { payload: { reason: string } }).payload.reason, 'tool_use');
});

test('TASK_THROTTLE_MS 常量 = 200ms', () => {
  assert.equal(TASK_THROTTLE_MS, 200);
});
