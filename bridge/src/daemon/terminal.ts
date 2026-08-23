/**
 * 打开终端 / 浏览器（点击回传：渲染进程发 open_tui → 守护进程按 open_target 打开目标）。
 *
 * - open_target=cli 且 terminal=wt：`wt.exe -d <cwd> cmd /k kimi --session <会话id>`；wt.exe 不可用（spawn ENOENT）时
 *   回退 `cmd /c start`（备选）；
 * - open_target=cli 且 terminal=cmd：`cmd /c start "" cmd /k kimi --session <会话id>`；
 * - open_target=cli 且 terminal=wsl（跨平台方案形态一）：`wt.exe -d <Windows cwd> wsl.exe [-d <发行版>]
 *   --cd <Linux cwd> -- kimi --session <会话id>`；cwd 为 Linux 路径时先经 wslToWindowsPath 转成 Windows 路径
 *   给 wt -d（wsl.exe 的 --cd 保留 Linux 原路径）；wt.exe 不可用（spawn ENOENT）时回退
 *   `cmd /c start "" wsl.exe [-d <发行版>] --cd <Linux cwd> --exec bash -lc "kimi --session <会话id>"`；
 * - open_target=web：用系统默认浏览器打开 open_web_url 模板（支持 {session_id} 占位符；
 *   能否在 web 侧直接按会话恢复属未验证假设，见 config.ts 的 DEFAULT_OPEN_WEB_URL 注释）；
 * - open_target=web 且 URL 为回环地址（127.0.0.1 / localhost / ::1）时，开浏览器前先确保本地
 *   web 服务可用：未运行则经可见终端窗口拉起 `kimi web --no-open --port <port>`（terminal=wt
 *   时 wt.exe 显式新建标签并刷新环境，wt 缺失回退 `cmd /c start`）并轮询等待就绪；服务挂在可见
 *   窗口上，用户关窗即停止服务，下次点击会自动重新拉起；非回环 URL 无法代管远端服务，维持现状
 *   直接开浏览器；
 * - open_target=web 且 URL 为回环地址时，开浏览器前读取本地 token 文件（%KIMI_CODE_HOME%
 *   \server.token，未设 KIMI_CODE_HOME 时 ~/.kimi-code/server.token）并拼进 URL fragment
 *   `#token=<token>`：kimi web 的 REST/Web 界面经 fragment 自动完成鉴权（实测裸 URL 会停在
 *   「Server token required」）。文件缺失/读取失败 → token 为 null，完全保持旧行为（探测原端口，
 *   被占直接开裸 URL、空闲则拉起；不验证也不顺延），用户可从拉起服务的终端窗口横幅复制 token
 *   手动填；URL 已有 fragment 先去掉再拼；非回环 URL 一律不拼 token、不做验证（防止 token
 *   泄漏到远端）；
 * - 回环 URL 且 token 读取成功：从配置端口起最多尝试 10 个候选端口（basePort..basePort+9，
 *   与 kimi web 自身「端口忙则 +1 重试」的语义一致）。候选端口 TCP 探测空闲 → 在该候选端口
 *   拉起 `kimi web --no-open --port <候选端口>`，轮询就绪后开浏览器；候选端口被占 → 用本地
 *   token 发一次 HTTP 验证（GET /api/v1/sessions，Authorization: Bearer，超时约 1.5 秒）：
 *   收到响应且状态码非 401 → 同 home 服务，直接开浏览器；401 → 异构占用（如 WSL 实例的
 *   kimi web），顺延下一候选端口；验证请求出错/超时 → 同样顺延；10 个候选全部被异构占用 →
 *   返回失败（中文说明，不含 token）。打开浏览器的 URL 端口与实际选用端口一致（顺延后重写
 *   URL 端口，保留路径与 query，再拼 #token=）；
 * - 安全红线：任何日志都不得输出带 token 的完整 URL（open_tui 日志不含 URL，保持如此，
 *   本文件不新增相关日志）；token 验证请求同样不落日志、不输出 token；
 * - 会话 id 为空 → `kimi --continue` 恢复最近会话；
 * - 分离拉起（detached + unref）：cli 终端/浏览器不随守护进程生命周期退出；web 服务随可见
 *   终端窗口生命周期（关窗即停）；
 * - wt/wsl 分支均经 wt.exe 直拉，禁止 windowsHide：libuv 会将其译为 STARTF_USESHOWWINDOW + SW_HIDE
 *   （并附加 CREATE_NO_WINDOW），Windows Terminal 会按启动信息隐藏主窗口，表现为「spawn 成功但窗口
 *   不显示」（实测复现）。cmd 路径经 `cmd /c start` 中转，窗口由 start 新开，不受影响
 *   （web 拉起与开浏览器同理）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_OPEN_WEB_URL, type OpenTarget } from './config.js';
import { wslToWindowsPath } from './wsl-path.js';

export interface OpenTuiOptions {
  /** 打开目标：cli=终端，web=浏览器。缺省 cli（向后兼容）。 */
  target?: OpenTarget;
  /** cli 时的终端方式：wt=Windows Terminal，cmd=传统控制台，wsl=WSL 发行版终端（形态一）。 */
  terminal: 'wt' | 'cmd' | 'wsl';
  /** terminal=wsl 时使用的 WSL 发行版（wsl.exe -d <发行版>）；缺省/空串 = wsl.exe 默认发行版。 */
  wslDistro?: string;
  /** web 时使用的 URL 模板（open_web_url），支持 {session_id} 占位符；缺省本地 kimi web 首页。 */
  webUrl?: string;
  /** kimi 终端的工作目录（-d <cwd>）。 */
  cwd: string;
  /** 目标会话；null = 最近会话（kimi --continue）。 */
  sessionId: string | null;
}

export interface OpenTuiCommand {
  file: string;
  args: string[];
  cwd: string;
}

/** 构造 cli 唤起命令（纯函数，可单测）。 */
export function buildOpenTuiCommand(opts: OpenTuiOptions): OpenTuiCommand {
  const sessionArgs = opts.sessionId ? ['--session', opts.sessionId] : ['--continue'];
  if (opts.terminal === 'wt') {
    return {
      file: 'wt.exe',
      args: ['-d', opts.cwd, 'cmd', '/k', 'kimi', ...sessionArgs],
      cwd: opts.cwd,
    };
  }
  if (opts.terminal === 'wsl') {
    // 守护进程在 Windows：cwd 为 Linux 路径时先经 wslToWindowsPath 转成 Windows 路径给 wt -d
    // （wt 要求的启动目录是 Windows 侧路径）；wsl.exe 的 --cd 保留 Linux 原路径以便在 WSL 内
    // 切换目录。发行版缺省（wslDistro 空）时不带 -d，wsl.exe 用默认发行版。
    const winCwd = wslToWindowsPath(opts.cwd, opts.wslDistro);
    const distroArgs = opts.wslDistro ? ['-d', opts.wslDistro] : [];
    return {
      file: 'wt.exe',
      args: ['-d', winCwd, 'wsl.exe', ...distroArgs, '--cd', opts.cwd, '--', 'kimi', ...sessionArgs],
      cwd: winCwd,
    };
  }
  return {
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'cmd', '/k', 'kimi', ...sessionArgs],
    cwd: opts.cwd,
  };
}

/**
 * wsl 首选 wt.exe 缺失（ENOENT）时的回退命令（纯函数，可单测）：经 `cmd /c start` 中转新开
 * WSL 发行版窗口，`--exec bash -lc` 在 WSL 内执行 kimi。整条会话命令（含参数）打包为
 * bash -lc 的单个 argv，避免 wsl.exe 把参数拆分后只执行 kimi 本身。启动目录与首选分支一致
 * 转为 Windows 路径（wsl 分支的 cwd 可能是 Linux 路径，Windows 侧 spawn 无法作为工作目录）。
 */
export function buildWslFallbackCommand(opts: OpenTuiOptions): OpenTuiCommand {
  const sessionArgs = opts.sessionId ? ['--session', opts.sessionId] : ['--continue'];
  const winCwd = wslToWindowsPath(opts.cwd, opts.wslDistro);
  const distroArgs = opts.wslDistro ? ['-d', opts.wslDistro] : [];
  return {
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'wsl.exe', ...distroArgs, '--cd', opts.cwd, '--exec', 'bash', '-lc', `kimi ${sessionArgs.join(' ')}`],
    cwd: winCwd,
  };
}

/** 展开 web URL 模板：把 {session_id} 替换为会话 id（空时替换为空串）。 */
export function buildOpenWebUrl(template: string, sessionId: string | null): string {
  return template.replace(/\{session_id\}/g, sessionId ?? '');
}

/** 构造打开浏览器的命令（Windows：cmd /c start "" <url> 走系统默认浏览器）。 */
export function buildOpenWebCommand(url: string, cwd: string): OpenTuiCommand {
  return {
    file: 'cmd.exe',
    args: ['/c', 'start', '', url],
    cwd,
  };
}

/**
 * 为回环 URL 追加 `#token=<token>`：kimi web 的 REST/Web 界面经 URL fragment 自动完成鉴权。
 * URL 已有 # 片段时先去掉再拼（替换而非叠加）；token 为 null / 空串 → 原样返回（裸 URL）。
 * token 字符集为 [A-Za-z0-9_-]，放入 fragment 无需转义。非回环 URL 严禁调用（防泄漏到远端）。
 */
export function appendServerToken(urlStr: string, token: string | null): string {
  if (!token) return urlStr;
  const hashIndex = urlStr.indexOf('#');
  const base = hashIndex >= 0 ? urlStr.slice(0, hashIndex) : urlStr;
  return `${base}#token=${token}`;
}

/** token 读取函数（注入测试用）：返回去空白后的有效 token，缺失/读失败/空白返回 null。 */
export type TokenReader = () => string | null;

/**
 * 默认 token 读取：%KIMI_CODE_HOME%\server.token（未设或为空时回退 ~/.kimi-code/server.token）。
 * 整个 kimi-code home 目录共享，运行中的实例实时接受该 token。文件缺失/读失败/内容空白
 * → 返回 null（静默回退裸 URL，不向用户报错）。
 */
function defaultReadServerToken(): string | null {
  try {
    const homeDir = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
    const token = readFileSync(path.join(homeDir, 'server.token'), 'utf8').trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * 构造拉起 kimi web 服务的可见终端命令（纯函数，可单测）。与 cli 路径同构：
 * wt 显式 new-tab，并以 --reloadEnvironment 刷新 Windows Terminal 已运行实例的环境后再
 * 执行 `cmd /k kimi web ...`；cmd 经 `cmd /c start` 中转新开窗口。
 * Windows Terminal 在携带 commandline 时默认继承其自身已缓存的环境，Kimi 安装后仍开着的
 * 终端可能缺少新版 PATH，导致 wt 启动成功但 tab 内找不到 kimi、端口始终不会就绪。
 * 服务挂在可见窗口上，用户关窗即停止服务。
 */
export function buildStartWebServiceCommand(opts: OpenTuiOptions, port: number): OpenTuiCommand {
  const webArgs = ['kimi', 'web', '--no-open', '--port', String(port)];
  if (opts.terminal === 'wt') {
    return {
      file: 'wt.exe',
      args: ['new-tab', '--reloadEnvironment', '-d', opts.cwd, 'cmd', '/k', ...webArgs],
      cwd: opts.cwd,
    };
  }
  if (opts.terminal === 'wsl') {
    // web 服务必须与会话 CLI 处于同一 WSL 环境，否则 Windows 侧找不到仅安装在
    // WSL 内的 kimi，端口永远不会就绪，后续浏览器也不会被打开。
    const winCwd = wslToWindowsPath(opts.cwd, opts.wslDistro);
    const distroArgs = opts.wslDistro ? ['-d', opts.wslDistro] : [];
    return {
      file: 'wt.exe',
      args: ['-d', winCwd, 'wsl.exe', ...distroArgs, '--cd', opts.cwd, '--', ...webArgs],
      cwd: winCwd,
    };
  }
  return {
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'cmd', '/k', ...webArgs],
    cwd: opts.cwd,
  };
}

/**
 * terminal=wsl 且 wt.exe 缺失时拉起 kimi web 的回退命令。外层 cmd 只负责 start，
 * 实际服务仍由指定 WSL 发行版中的 bash 执行，避免误在 Windows PATH 查找 kimi。
 */
export function buildWslStartWebServiceFallbackCommand(opts: OpenTuiOptions, port: number): OpenTuiCommand {
  const winCwd = wslToWindowsPath(opts.cwd, opts.wslDistro);
  const distroArgs = opts.wslDistro ? ['-d', opts.wslDistro] : [];
  const webCommand = `kimi web --no-open --port ${port}`;
  return {
    file: 'cmd.exe',
    args: ['/c', 'start', '', 'wsl.exe', ...distroArgs, '--cd', opts.cwd, '--exec', 'bash', '-lc', webCommand],
    cwd: winCwd,
  };
}

export type SpawnFn = (file: string, args: string[], opts: { detached: boolean; stdio: 'ignore'; windowsHide: boolean }) => ChildProcess;

/** 端口探测函数（注入测试用）：连上返回 true，超时/被拒返回 false。 */
export type ConnectFn = (port: number, host: string) => Promise<boolean>;

/**
 * token 验证结果：'ok'=收到响应且状态码非 401（鉴权通过，同 home 服务；404 也算）；
 * 'unauthorized'=HTTP 401（token 不被接受，异构占用，如 WSL 实例）；'error'=网络错误/超时/无响应。
 */
export type VerifyServerTokenResult = 'ok' | 'unauthorized' | 'error';

/**
 * token 验证函数（注入测试用）：对候选端口发 GET /api/v1/sessions，头
 * Authorization: Bearer <token>，整体超时 timeoutMs（毫秒）。回环 kimi web 无 TLS，只支持 http。
 */
export type VerifyServerTokenFn = (
  host: string,
  port: number,
  token: string,
  timeoutMs: number,
) => Promise<VerifyServerTokenResult>;

/** 回环端口探测超时（毫秒）：单次 connect 最多等这么久，避免不可达主机拖慢流程。 */
const PROBE_TIMEOUT_MS = 500;
/** 拉起 kimi web 后的轮询间隔（毫秒）。 */
const WEB_POLL_MS = 250;
/** 拉起 kimi web 后最长等待就绪时间（毫秒）。 */
const WEB_WAIT_MS = 10_000;
/** token 可用时最多尝试的候选端口数（basePort..basePort+WEB_PORT_ATTEMPTS-1）。 */
const WEB_PORT_ATTEMPTS = 10;
/** token HTTP 验证整体超时（毫秒）。 */
const VERIFY_TIMEOUT_MS = 1500;

export interface OpenTuiResult {
  /** 实际执行方式：'wt' | 'wsl'（cli 目标经 wt.exe 直拉）| 'cmd'（回退）| 'web'（浏览器目标）。 */
  terminal: 'wt' | 'cmd' | 'wsl' | 'web';
  ok: boolean;
  error?: string;
}

/**
 * 唤起终端或浏览器。cli 目标下 wt 拉起失败（未安装/不在 PATH）时回退 cmd /c start（备选）。
 * web 目标下回环地址会先探测并自动拉起本地 kimi web 服务；token 可用时对被占端口做 HTTP
 * 验证并按需顺延候选端口（见 ensureWebServiceWithToken）。全部失败返回 ok=false
 * （不重试轰炸，调用方记日志并向渲染进程补发失败气泡，发送失败不重试的语义同源）。
 * spawnFn / connectFn / webTiming / tokenReader / verifyFn 供测试注入；缺省使用真实 spawn /
 * net.connect / 默认轮询时序 / 真实读取 server.token / node:http 默认验证。
 */
export function openTui(
  opts: OpenTuiOptions,
  spawnFn: SpawnFn = (file, args, spawnOpts) => spawn(file, args, spawnOpts),
  connectFn: ConnectFn = defaultConnect,
  webTiming: { pollMs?: number; waitMs?: number } = {},
  tokenReader: TokenReader = defaultReadServerToken,
  verifyFn: VerifyServerTokenFn = defaultVerifyServerToken,
): Promise<OpenTuiResult> {
  const target = opts.target ?? 'cli';
  if (target === 'web') {
    return openWeb(opts, spawnFn, connectFn, {
      pollMs: webTiming.pollMs ?? WEB_POLL_MS,
      waitMs: webTiming.waitMs ?? WEB_WAIT_MS,
    }, tokenReader, verifyFn);
  }
  return openTerminal(opts, spawnFn);
}

/** cli 目标：wt 首拉（wt 或 wsl 分支都经 wt.exe），失败（ENOENT）回退 cmd（备选）。 */
function openTerminal(opts: OpenTuiOptions, spawnFn: SpawnFn): Promise<OpenTuiResult> {
  return new Promise((resolve) => {
    const attempt = (terminal: 'wt' | 'cmd' | 'wsl', cmd: OpenTuiCommand): void => {
      let child: ChildProcess;
      try {
        // wt/wsl 分支都经 wt.exe 直拉，必须 windowsHide=false：libuv 把 windowsHide 译为
        // STARTF_USESHOWWINDOW + SW_HIDE（并附加 CREATE_NO_WINDOW），GUI 程序会按启动信息隐藏
        // 主窗口，表现为「spawn 成功但窗口不显示」。cmd 路径经 `cmd /c start` 中转，真正的窗口
        // 由 start 新开，外层 cmd 存根保持隐藏以免闪窗。
        child = spawnFn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: terminal === 'cmd' });
      } catch (err) {
        resolve({ terminal, ok: false, error: (err as Error).message });
        return;
      }
      child.once('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if ((terminal === 'wt' || terminal === 'wsl') && code === 'ENOENT') {
          // wt.exe 不可用：回退 cmd /c start（备选）。wsl 模式回退为
          // `cmd /c start "" wsl.exe ... --exec bash -lc "kimi ..."`（保留 wsl 语义，不再经
          // cmd /k 在 Windows 侧执行）；wt 模式维持原回退命令。启动目录由回退命令构造函数处理。
          attempt('cmd', terminal === 'wsl' ? buildWslFallbackCommand(opts) : buildOpenTuiCommand({ ...opts, terminal: 'cmd' }));
        } else {
          resolve({ terminal, ok: false, error: `${code ?? err.message}` });
        }
      });
      child.once('spawn', () => {
        child.unref(); // 终端不随守护进程退出
        resolve({ terminal, ok: true });
      });
    };

    attempt(opts.terminal, buildOpenTuiCommand(opts));
  });
}

/** web 目标：单命令唤起（无 wt→cmd 回退）。 */
function openCommand(
  cmd: OpenTuiCommand,
  terminal: 'wt' | 'cmd' | 'web',
  spawnFn: SpawnFn,
): Promise<OpenTuiResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (err) {
      resolve({ terminal, ok: false, error: (err as Error).message });
      return;
    }
    child.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      resolve({ terminal, ok: false, error: `${code ?? err.message}` });
    });
    child.once('spawn', () => {
      child.unref(); // 浏览器不随守护进程退出
      resolve({ terminal, ok: true });
    });
  });
}

/** 去掉 IPv6 hostname 的方括号（URL.hostname 对 IPv6 会带 [::1]）。 */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** 判断 hostname 是否为回环地址（127.0.0.1 / localhost / ::1，含 [::1] 括号形式）。 */
function isLoopbackHostname(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

/** 默认端口探测：net.connect 连接成功即 true，超时/出错为 false（单次连接超时 PROBE_TIMEOUT_MS）。 */
function defaultConnect(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host, timeout: PROBE_TIMEOUT_MS });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * 默认 token 验证实现：node:http 发起 GET /api/v1/sessions，头 Authorization: Bearer <token>。
 * 收到 HTTP 响应且状态码非 401 → 'ok'（鉴权已过，404 也算）；401 → 'unauthorized'；
 * 网络错误/整体超时/无响应 → 'error'。整体超时由 timeoutMs 控制，超时销毁请求即返回
 * （随后的 error 事件再次 resolve 幂等无副作用）。
 */
function defaultVerifyServerToken(host: string, port: number, token: string, timeoutMs: number): Promise<VerifyServerTokenResult> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host,
        port,
        path: '/api/v1/sessions',
        method: 'GET',
        timeout: timeoutMs,
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        // 收到响应即鉴权结果已定：非 401 视为同 home 服务（404 也证明 token 被接受）
        resolve(res.statusCode === 401 ? 'unauthorized' : 'ok');
        res.resume(); // 排空响应体，释放连接
      },
    );
    req.once('timeout', () => {
      req.destroy();
      resolve('error');
    });
    req.once('error', () => resolve('error'));
    req.end();
  });
}

/** web 目标：展开并解析 URL；回环地址先确保本地 web 服务可用（token 缺失走旧行为、
 * 可用时带 HTTP 验证与端口顺延）并拼上 #token= 鉴权，非回环地址直接开浏览器（不验证不拼 token）。 */
function openWeb(
  opts: OpenTuiOptions,
  spawnFn: SpawnFn,
  connectFn: ConnectFn,
  timing: { pollMs: number; waitMs: number },
  tokenReader: TokenReader,
  verifyFn: VerifyServerTokenFn,
): Promise<OpenTuiResult> {
  const urlStr = buildOpenWebUrl(opts.webUrl ?? DEFAULT_OPEN_WEB_URL, opts.sessionId);
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return Promise.resolve({ terminal: 'web', ok: false, error: `open_web_url 无法解析：${urlStr}` });
  }
  // 非回环 URL 无法代管远端服务，维持现状直接开浏览器；同时绝不拼 token、不做验证（防泄漏到远端）
  if (!isLoopbackHostname(url.hostname)) {
    return openCommand(buildOpenWebCommand(urlStr, opts.cwd), 'web', spawnFn);
  }
  const host = stripIpv6Brackets(url.hostname);
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  // 回环地址：读取本地 server.token 拼 #token= 自动鉴权；读取失败（文件缺失/注入函数抛错）
  // → token 为 null，静默回退裸 URL（用户可从服务终端窗口横幅复制 token 手动填）
  let token: string | null = null;
  try {
    token = tokenReader();
  } catch {
    token = null;
  }
  if (token === null) {
    // token 缺失：完全保持旧行为——探测原端口，被占直接开裸 URL、空闲则拉起；不验证也不顺延
    return ensureWebService(opts, urlStr, host, port, spawnFn, connectFn, timing);
  }
  // token 可用：候选端口循环——空闲拉起、被占用 HTTP 验证区分同 home 服务与异构占用（如 WSL 实例）
  return ensureWebServiceWithToken(opts, url, host, port, token, spawnFn, connectFn, timing, verifyFn);
}

/** token 缺失时的旧行为路径：探测原端口，被占直接开裸 URL（不验证不发验证请求），空闲则拉起 kimi web 并等待就绪。 */
function ensureWebService(
  opts: OpenTuiOptions,
  urlStr: string,
  host: string,
  port: number,
  spawnFn: SpawnFn,
  connectFn: ConnectFn,
  timing: { pollMs: number; waitMs: number },
): Promise<OpenTuiResult> {
  return connectFn(port, host)
    .catch(() => false)
    .then((alive) => {
      if (alive) {
        return openCommand(buildOpenWebCommand(urlStr, opts.cwd), 'web', spawnFn);
      }
      return startWebService(opts, urlStr, host, port, spawnFn, connectFn, timing);
    });
}

/** 改写已解析 URL 的端口（保留协议、路径与 query；已有 fragment 由 appendServerToken 统一处理）。 */
function rewritePort(url: URL, port: number): URL {
  const copy = new URL(url.toString());
  copy.port = String(port);
  return copy;
}

/**
 * token 可用时的回环服务保障：从 basePort 起最多尝试 WEB_PORT_ATTEMPTS 个候选端口。
 * 候选端口 TCP 探测空闲 → 经可见终端窗口在该候选端口拉起 kimi web（spawn 失败/轮询超时
 * 直接返回，不顺延）；被占 → verifyFn 用本地 token 验证是否同 home 服务：'ok' 直接开浏览器；
 * 'unauthorized'（401，如 WSL 实例的 kimi web）/ 'error'（验证出错或超时）→ 异构占用，
 * 顺延下一候选端口；全部候选被异构占用 → 返回失败（中文说明端口范围，不含 token）。
 * 打开浏览器的 URL 端口 = 实际选用端口（先重写端口保留路径与 query，再拼 #token=）。
 */
async function ensureWebServiceWithToken(
  opts: OpenTuiOptions,
  url: URL,
  host: string,
  basePort: number,
  token: string,
  spawnFn: SpawnFn,
  connectFn: ConnectFn,
  timing: { pollMs: number; waitMs: number },
  verifyFn: VerifyServerTokenFn,
): Promise<OpenTuiResult> {
  const lastPort = basePort + WEB_PORT_ATTEMPTS - 1;
  for (let port = basePort; port <= lastPort; port++) {
    const browserUrl = appendServerToken(rewritePort(url, port).toString(), token);
    let alive = false;
    try {
      alive = await connectFn(port, host);
    } catch {
      alive = false;
    }
    if (!alive) {
      return startWebService(opts, browserUrl, host, port, spawnFn, connectFn, timing);
    }
    // 端口被占：用本地 token 发一次 HTTP 验证（回环 kimi web 无 TLS，只走 http）。
    // 验证请求不落日志、不输出 token；注入的 verifyFn 意外 reject 也按 'error' 顺延。
    const verdict = await verifyFn(host, port, token, VERIFY_TIMEOUT_MS).catch(() => 'error' as const);
    if (verdict === 'ok') {
      return openCommand(buildOpenWebCommand(browserUrl, opts.cwd), 'web', spawnFn);
    }
    // 'unauthorized' / 'error'：异构占用或无法确认，顺延下一候选端口
  }
  return {
    terminal: 'web',
    ok: false,
    error: `端口 ${basePort}-${lastPort} 均被占用且本地 token 校验未通过（可能为其他环境如 WSL 的 kimi web 实例占用），请关闭占用服务后重试`,
  };
}

/**
 * 经可见终端窗口拉起 `kimi web --no-open --port <port>`（用户关窗即停止服务）：terminal=wt 时
 * wt.exe 直拉，wt 缺失（ENOENT）回退 `cmd /c start`（备选）；两条路径都 spawn 失败才
 * 返回拉起失败错误。spawn 成功后轮询等待端口就绪。
 */
function startWebService(
  opts: OpenTuiOptions,
  urlStr: string,
  host: string,
  port: number,
  spawnFn: SpawnFn,
  connectFn: ConnectFn,
  timing: { pollMs: number; waitMs: number },
): Promise<OpenTuiResult> {
  return new Promise((resolve) => {
    const attempt = (terminal: 'wt' | 'cmd', cmd: OpenTuiCommand): void => {
      let child: ChildProcess;
      try {
        // wt 必须 windowsHide=false：libuv 把 windowsHide 译为 STARTF_USESHOWWINDOW + SW_HIDE
        // （并附加 CREATE_NO_WINDOW），GUI 程序会按启动信息隐藏主窗口，表现为「spawn 成功但
        // 窗口不显示」。cmd 路径经 `cmd /c start` 中转，真正的窗口由 start 新开，外层 cmd
        // 存根保持隐藏以免闪窗。
        child = spawnFn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: terminal === 'cmd' });
      } catch (err) {
        resolve({ terminal: 'web', ok: false, error: `拉起 kimi web 失败：${(err as Error).message}` });
        return;
      }
      let spawned = false;
      child.once('error', (err) => {
        if (spawned) return; // spawn 成功后的进程错误不再影响（端口探测独立进行）
        const code = (err as NodeJS.ErrnoException).code;
        if (terminal === 'wt' && code === 'ENOENT') {
          // wt.exe 未安装：回退 cmd /c start（备选）
          // terminal=wsl 时，回退路径也必须在 WSL 内执行 kimi web；否则 Windows PATH
          // 中找不到 kimi 后只会等到端口超时，浏览器不会启动。
          attempt(
            'cmd',
            opts.terminal === 'wsl'
              ? buildWslStartWebServiceFallbackCommand(opts, port)
              : buildStartWebServiceCommand({ ...opts, terminal: 'cmd' }, port),
          );
        } else {
          // 两条路径都失败（如 wt 缺失后 cmd 也不可用）才判定拉起失败
          const reason = code === 'ENOENT' ? 'kimi 未安装或不在 PATH' : code ?? err.message;
          resolve({ terminal: 'web', ok: false, error: `拉起 kimi web 失败：${reason}` });
        }
      });
      child.once('spawn', () => {
        spawned = true;
        child.unref(); // web 服务不随守护进程退出（随用户关闭窗口退出）
        pollWebReady(urlStr, opts.cwd, host, port, spawnFn, connectFn, timing, resolve);
      });
    };

    // terminal=wsl 配置下 web 目标与 cmd 同构（外层 cmd /c start 中转拉起 kimi web），
    // 归一化回 'wt' | 'cmd' 供 attempt 判定 windowsHide 与 ENOENT 回退。
    const startCmd = buildStartWebServiceCommand(opts, port);
    attempt(startCmd.file === 'wt.exe' ? 'wt' : 'cmd', startCmd);
  });
}

/** 轮询等待 web 服务端口就绪；就绪后开浏览器，超时返回 ok=false（中文错误描述）。 */
function pollWebReady(
  urlStr: string,
  cwd: string,
  host: string,
  port: number,
  spawnFn: SpawnFn,
  connectFn: ConnectFn,
  timing: { pollMs: number; waitMs: number },
  resolve: (result: OpenTuiResult) => void,
): void {
  const deadline = Date.now() + timing.waitMs;
  const tick = async (): Promise<void> => {
    let alive = false;
    try {
      alive = await connectFn(port, host);
    } catch {
      alive = false;
    }
    if (alive) {
      resolve(await openCommand(buildOpenWebCommand(urlStr, cwd), 'web', spawnFn));
      return;
    }
    if (Date.now() >= deadline) {
      resolve({ terminal: 'web', ok: false, error: `kimi web 服务 ${timing.waitMs}ms 内未就绪` });
      return;
    }
    setTimeout(tick, timing.pollMs);
  };
  setTimeout(tick, timing.pollMs);
}
