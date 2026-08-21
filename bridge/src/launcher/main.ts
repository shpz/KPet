/**
 * 单 exe 双模式分发入口 kpetd（Windows 为 kpetd.exe）。
 *
 * 合并前转发器（kpet-bridge，Windows 为 kpet-bridge.exe）与守护进程（kpetd，Windows 为 kpetd.exe）
 * 是两个 bun --compile 产物；合并后两者共用本入口，按第一个参数分发：
 *   --daemon              守护进程模式（原 daemon/main.ts）
 *   --stop                停止守护进程模式（bridge/stop.ts：写抑制标记触发优雅退出，等待事件管道释放）
 *   --kpet-recover    恢复 worker 模式（原 bridge/main.ts 的隐藏命令行分支，后随 7 个位置参数）
 *   --relay / 无参数      转发器模式（原转发器行为；宿主丢弃参数时默认此模式，防止失联）
 *   其他参数              打印用法并以非零码退出
 */
import { getDaemonExeName } from '../bridge/daemon.js';
import { main as relayMain, runRecoveryFromArgv } from '../bridge/main.js';
import { stopMain } from '../bridge/stop.js';
import { main as daemonMain } from '../daemon/main.js';

const arg = process.argv[2];

if (arg === '--daemon') {
  void daemonMain();
} else if (arg === '--stop') {
  void stopMain();
} else if (arg === '--kpet-recover') {
  void runRecoveryFromArgv();
} else if (arg === undefined || arg === '--relay') {
  void relayMain();
} else {
  console.error(`用法: ${getDaemonExeName()} [--relay|--daemon|--stop|--kpet-recover <参数>]`);
  process.exit(2);
}
