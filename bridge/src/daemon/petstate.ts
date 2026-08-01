/**
 * 宠物位置持久化（§4.3 pet_moved：拖拽结束由渲染进程上报，守护进程统一写配置，避免多头写文件；
 * §6.4 本地缓存 %APPDATA%/KimiPet/pet-state.json，防抖 500ms 写入，进程退出前强制落盘）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 位置缓存文件路径：%APPDATA%/KimiPet/pet-state.json（§6.4）。 */
export function getPetStatePath(appData: string = process.env.APPDATA ?? ''): string {
  return appData.length > 0 ? path.join(appData, 'KimiPet', 'pet-state.json') : '';
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
