/**
 * 用户名与管道名（事件管道为 Windows 命名管道 \\.\pipe\KPet.H2D.<用户名>，管道名不允许 \）。
 */
import * as os from 'node:os';

/** 管道名中非法字符的替换符。 */
export const PIPE_USER_REPLACEMENT = '_';

/** 用户名 → 管道名段中的非法字符：\ 为管道名硬限制，其余按路径/文件系统保留字符一并替换，避免歧义与安全隐患。 */
const INVALID_PIPE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 用户名过滤后为空时的回退值，保证管道名段非空。 */
export const PIPE_USER_FALLBACK = 'default';

/**
 * 过滤用户名中的非法字符，得到可安全拼入管道名的段。
 * 例：`DOMAIN\Luo_x` → `DOMAIN_Luo_x`；全部被替换时回退 `default`。
 */
export function sanitizePipeUser(username: string): string {
  const cleaned = username.replace(INVALID_PIPE_CHARS, PIPE_USER_REPLACEMENT).trim();
  return cleaned.length > 0 ? cleaned : PIPE_USER_FALLBACK;
}

/**
 * 取当前系统用户名。
 * 优先 os.userInfo()（Windows 上返回不带域前缀的用户名）；
 * 取不到（受限容器等）时回退环境变量 USERNAME / USER。
 */
export function getUserName(): string {
  try {
    const name = os.userInfo().username;
    if (name.length > 0) return name;
  } catch {
    // 回退环境变量
  }
  return process.env.USERNAME ?? process.env.USER ?? PIPE_USER_FALLBACK;
}

/** 事件管道全名（Windows 命名管道）：\\.\pipe\KPet.H2D.<用户名>。 */
export function getEventPipeName(username?: string): string {
  const user = sanitizePipeUser(username ?? getUserName());
  return `\\\\.\\pipe\\KPet.H2D.${user}`;
}

/** 控制管道全名（Windows 命名管道）：\\.\pipe\KPet.PET.<用户名>（守护进程 ↔ 渲染进程双向）。 */
export function getControlPipeName(username?: string): string {
  const user = sanitizePipeUser(username ?? getUserName());
  return `\\\\.\\pipe\\KPet.PET.${user}`;
}
