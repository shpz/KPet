// 复现脚本：完全按守护进程的方式拉起 wt.exe -d <cwd> cmd /k "kimi web ... 2> 错误日志"
// 用法：node tools/repro-web-spawn.mjs <port> <errlog> [nodetach]
import { spawn } from 'node:child_process';

const port = process.argv[2] ?? '58628';
const errlog = process.argv[3];
const detached = process.argv[4] !== 'nodetach';
const inner = `kimi web --no-open --port ${port} 2> "${errlog}"`;

const child = spawn('wt.exe', ['-d', 'D:\\Workspace\\UnrealProject\\KimiPet', 'cmd', '/k', inner], {
  detached,
  stdio: 'ignore',
  windowsHide: false,
});
child.on('error', (err) => { console.error('spawn error:', err.message); process.exit(1); });
child.on('spawn', () => { console.log(`spawned wt.exe pid=${child.pid} detached=${detached}`); child.unref(); });
setTimeout(() => process.exit(0), 15000);
