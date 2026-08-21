/**
 * 宠物位置持久化（§4.3 pet_moved：拖拽结束由渲染进程上报，守护进程统一写配置，避免多头写文件；
 * §6.4 本地缓存 <基目录>/KPet/pet-state.json，基目录按平台解析（见 §2.1.3），防抖 500ms 写入，进程退出前强制落盘）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface PetStateBaseDirOptions {
  /** 目标平台，缺省 process.platform。 */
  platform?: NodeJS.Platform;
  /** 环境变量，缺省 process.env（注入便于测试）。 */
  env?: NodeJS.ProcessEnv;
  /** 用户主目录（~），缺省 os.homedir()。 */
  home?: string;
}

/** 位置缓存基目录按平台解析（§2.1.3）：win32 用 APPDATA（未设返回空串，保持现状语义），darwin 用 ~/Library/Application Support，其余平台用 XDG_DATA_HOME（未设回退 ~/.local/share）。 */
export function resolvePetStateBaseDir(opts: PetStateBaseDirOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform === 'win32') {
    const appData = env.APPDATA ?? '';
    return appData.length > 0 ? appData : '';
  }
  if (platform === 'darwin') {
    return path.join(opts.home ?? os.homedir(), 'Library', 'Application Support');
  }
  const xdgDataHome = env.XDG_DATA_HOME ?? '';
  return xdgDataHome.length > 0 ? xdgDataHome : path.join(opts.home ?? os.homedir(), '.local', 'share');
}

/** 位置缓存文件路径：<基目录>/KPet/pet-state.json（§6.4），基目录缺省按当前平台解析。 */
export function getPetStatePath(baseDir: string = resolvePetStateBaseDir()): string {
  return baseDir.length > 0 ? path.join(baseDir, 'KPet', 'pet-state.json') : '';
}

/** §6.4 定义的缓存文件格式。pet 字段（yaw/pitch）由渲染进程自行维护，守护进程只合并 window。 */
export interface PetStateFile {
  window?: { x: number; y: number; monitor_id: string };
  pet?: Record<string, unknown>;
  version: number;
}

export interface PetStateStoreOptions {
  /** 写入防抖（毫秒），缺省 500ms（§6.4）。 */
  debounceMs?: number;
  now?: () => number;
}

/**
 * pet_moved 持久化存储。
 * - 只合并 window 字段（x/y 必须为有限数字、monitor_id 必须为字符串，非法则丢弃）；
 * - 防抖写入；flush() 立即落盘（守护进程退出前调用）；
 * - 文件损坏/版本不符 → 整体回退默认，不阻断启动（§6.4）。
 */
export class PetStateStore {
  private readonly filePath: string;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private data: PetStateFile;
  private timer: NodeJS.Timeout | null = null;

  constructor(filePath: string = getPetStatePath(), opts: PetStateStoreOptions = {}) {
    this.filePath = filePath;
    this.debounceMs = opts.debounceMs ?? 500;
    this.now = opts.now ?? Date.now;
    this.data = this.load();
  }

  updateWindow(x: number, y: number, monitorId: string): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || typeof monitorId !== 'string') return;
    this.data.window = { x, y, monitor_id: monitorId };
    this.scheduleWrite();
  }

  get window(): { x: number; y: number; monitor_id: string } | undefined {
    return this.data.window;
  }

  /** 立即落盘（退出前调用）。 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.write();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private load(): PetStateFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as PetStateFile;
      if (parsed && typeof parsed === 'object' && parsed.version === 1) {
        const w = parsed.window;
        if (w && typeof w === 'object' && Number.isFinite(w.x) && Number.isFinite(w.y) && typeof w.monitor_id === 'string') {
          return { window: { x: w.x, y: w.y, monitor_id: w.monitor_id }, pet: parsed.pet, version: 1 };
        }
      }
    } catch {
      // 文件不存在/损坏 → 默认
    }
    return { version: 1 };
  }

  private scheduleWrite(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private write(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      // 写失败不影响守护进程主流程（下次 pet_moved 会再试）
    }
  }
}
