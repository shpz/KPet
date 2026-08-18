/**
 * WSL ↔ Windows 路径互转（跨平台兼容方案 §3.1：形态一「CLI 在 WSL、守护进程在 Windows」的路径转换层）。
 *
 * 守护进程运行在 Windows，但形态一下宿主事件里的会话 cwd 可能是 Linux 路径：
 * - `/mnt/c/...`（drvfs 自动挂载盘）→ 对应 Windows 盘符路径；
 * - `/home/...` 等 WSL 原生 ext4 路径 → `\\wsl.localhost\<发行版>\...`（需显式指定发行版；
 *   发行版为空时无法确定路径归属，原样返回不转，由调用方降级处理）。
 * 反向（Windows → WSL）在需要把 Windows cwd 回显给 WSL 内命令时使用：盘符路径 → `/mnt/<小写盘符>/...`，
 * `\\wsl.localhost\<发行版>\...` / `\\wsl$\<发行版>\...` → `/...`。
 *
 * 全部为纯字符串运算（不依赖 wslpath.exe，便于单测与跨发行版）；对已属目标形态的输入与
 * 相对路径一律原样返回（幂等，两层转换可安全叠加）。
 */
/** `/mnt/` 前缀长度（"mnt/" 计 4 字符，加上开头的 "/"）。 */
const MNT_PREFIX = '/mnt/';

/** WSL 网络共享 UNC 前缀（`\\wsl.localhost\<distro>\` 与历史别名 `\\wsl$\<distro>\`，含尾反斜杠）。 */
const WSL_UNC_PREFIXES: readonly string[] = ['\\\\wsl.localhost\\', '\\\\wsl$\\'];

/**
 * WSL 路径 → Windows 路径：
 * - `/mnt/<盘符>/<其余>` → `<盘符>:\<其余>`（盘符转大写，斜杠转反斜杠）；
 * - 其他 POSIX 绝对路径（如 `/home/...`）→ `\\wsl.localhost\<distro>\<路径>`（distro 空则原样返回）；
 * - 非 `/` 开头的输入（Windows 路径 / 相对路径）原样返回。
 */
export function wslToWindowsPath(wslPath: string, distro?: string): string {
  if (wslPath.startsWith(MNT_PREFIX)) {
    const rest = wslPath.slice(MNT_PREFIX.length); // 例如 "c/Users/me"
    const sep = rest.indexOf('/');
    const drive = sep < 0 ? rest : rest.slice(0, sep);
    if (/^[A-Za-z]$/.test(drive)) {
      const tail = sep < 0 ? '' : rest.slice(sep + 1).replaceAll('/', '\\');
      return `${drive.toUpperCase()}:\\${tail}`;
    }
  }
  if (wslPath.startsWith('/') && distro) {
    return `\\\\wsl.localhost\\${distro}${wslPath.replaceAll('/', '\\')}`;
  }
  return wslPath;
}

/**
 * Windows 路径 → WSL 路径：
 * - `<盘符>:\<其余>`（分隔符正/反斜杠均可）→ `/mnt/<小写盘符>/<其余>`；
 * - `\\wsl.localhost\<distro>\...` / `\\wsl$\<distro>\...` → `/<distro 之后的部分>`（斜杠转正斜杠）；
 * - 其余输入（Linux 路径 / 相对路径 / 仅含 distro 无路径的 UNC）原样返回。
 */
export function windowsToWslPath(winPath: string): string {
  const driveMatch = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (driveMatch) {
    const drive = driveMatch[1]!.toLowerCase();
    const rest = (driveMatch[2] ?? '').replaceAll('\\', '/');
    return `/mnt/${drive}${rest.length > 0 ? `/${rest}` : ''}`;
  }
  for (const prefix of WSL_UNC_PREFIXES) {
    if (winPath.startsWith(prefix)) {
      const withoutPrefix = winPath.slice(prefix.length); // 例如 "Ubuntu\home\me"
      const sep = withoutPrefix.indexOf('\\');
      if (sep >= 0) {
        const rest = withoutPrefix.slice(sep + 1).replaceAll('\\', '/');
        return `/${rest}`;
      }
      return winPath; // 只有发行版名、无路径部分，无法确定 WSL 内路径，原样返回
    }
  }
  return winPath;
}