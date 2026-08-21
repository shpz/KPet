/**
 * KPet 整包打包脚本（仓库根）—— 打包是整个产品的事（bridge 单 exe + UE5 渲染进程），
 * 本脚本是唯一打包入口：仓库根 package.json 的 package 脚本指向这里。
 *
 * 打包配置要点：
 *   - UE 固定 Shipping（与 docs 文档统一命令一致，-iostore -compressed -nodebuginfo -clean -prereqs）；
 *     -prereqs 随包暂存 vc_redist.x64.exe：bootstrap（根目录 Pet.exe）前置检查要求目标机器
 *     VC++ 运行库版本 ≥ 引擎构建工具集版本（5.8 为 14.50，高于公开下载渠道最新版），
 *     不满足时运行包内安装器自愈，缺失安装器则直接弹错退出；
 *   - bridge 为单 exe 双模式（launcher），不再产出 kpet-bridge.exe；
 *   - 符号（*.pdb）不随包分发，renderer 组装后兜底删除；如需保留符号，可本地归档
 *     或后续接入 SymStore（本脚本不实现归档）。
 *
 * 用法（Node >= 22.6，仅 node: 标准库，无任何依赖）：
 *   node --experimental-strip-types tools/package.ts
 *       [--skip-renderer]     # 完全跳过 UE 渲染进程（插件不含 renderer/）
 *       [--renderer <目录>]   # 用现成的 UE 打包产物，跳过 UE 构建（与 --skip-renderer 互斥）
 *       [--out <目录>]        # 输出父目录，默认 <仓库根>/dist-plugin
 *       [--zip]               # 额外用 PowerShell Compress-Archive 打 kpet.zip
 *
 * 流程：
 *   A. bridge 子工程：npm --prefix bridge run build（tsc）→ bun build --compile --windows-hide-console
 *      （dist/launcher/main.js → bin/kpetd.exe）
 *   B. renderer：默认 RunUAT.bat BuildCookRun 打包 UE（Win64、Shipping；打包前 taskkill UnrealEditor.exe），
 *      完成后在 StagedBuilds 里定位游戏 exe 所在的整个目录（即 renderer/ 本体）；
 *      --skip-renderer / --renderer 可跳过 UE 构建
 *   C. 组装 <out>/kpet/{kimi.plugin.json, kimi.plugin.wsl.json, bin/, renderer/}；renderer 拷贝后兜底删除
 *      *.pdb、D3D12 两个 DLL、NVaftermath DLL（逐项打印日志）
 *   D. 可选 --zip
 *
 * 任一步失败即非零退出并给出清晰错误；结尾打印产物清单与 /plugins install 提示。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, cpSync, copyFileSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = join(ROOT, "bridge");
const UE_PROJECT = join(ROOT, "Pet", "Pet.uproject");
const UE_ENGINE = "C:\\Program Files\\Epic Games\\UE_5.8";
const RUN_UAT = join(UE_ENGINE, "Engine", "Build", "BatchFiles", "RunUAT.bat");
const ROOT_PKG = join(ROOT, "package.json");
const MANIFEST = join(BRIDGE, "packaging", "kpet", "kimi.plugin.json");
/** WSL 宿主清单：command 走 bin/kpet-relay.sh（跨平台兼容方案，随包分发供 WSL 宿主改名使用）。 */
const MANIFEST_WSL = join(BRIDGE, "packaging", "kpet", "kimi.plugin.wsl.json");
/** 跨平台部署脚本（随包分发，在目标平台上跑 deploy.sh / deploy.ps1 自动准备对应平台清单与安装指引）。 */
const DEPLOY_SH = join(BRIDGE, "packaging", "kpet", "deploy.sh");
const DEPLOY_PS1 = join(BRIDGE, "packaging", "kpet", "deploy.ps1");
/** WSL relay 脚本：POSIX sh，WSL 内经 interop 直启 Windows 侧 kpetd.exe。 */
const RELAY_SCRIPT = join(BRIDGE, "packaging", "kpet", "bin", "kpet-relay.sh");
const STAGE_ROOT = join(ROOT, "Pet", "Saved", "StagedBuilds");
/** UE 渲染进程可执行名：工程目标名是 Pet（产物 Pet.exe）；设计文档写作 KPet.exe，两种都认。 */
const GAME_EXE_NAMES = new Set(["pet.exe", "kpet.exe"]);
/** D3D12 两个 DLL：当前为 SM5-only + 强制 DX11（方案 A），运行时均不加载但会被引擎无条件暂存，
 *  随包删除。注意：若未来回退 D3D12 RHI，D3D12Core.dll 必须保留，删除逻辑须同步移除。 */
const D3D12_DLL_NAMES = new Set(["d3d12sdklayers.dll", "d3d12core.dll"]);
/** NVaftermath 相关 DLL（实际文件位于 Engine/Binaries/ThirdParty/NVIDIA/NVaftermath/Win64/，约 5.5 MB）。 */
const NVAFTERMATH_DLL_NAMES = new Set(["gfsdk_aftermath_lib.x64.dll"]);

interface Options {
  out: string;
  renderer: string | null;
  skipRenderer: boolean;
  zip: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    out: join(ROOT, "dist-plugin"),
    renderer: null,
    skipRenderer: false,
    zip: false,
  };
  let i = 0;
  const takeValue = (flag: string): string => {
    const v = argv[++i];
    if (!v) throw new Error(`${flag} 缺少参数值`);
    return v;
  };
  for (; i < argv.length; i++) {
    switch (argv[i]) {
      case "--out":
        opts.out = resolve(takeValue("--out"));
        break;
      case "--renderer":
        opts.renderer = resolve(takeValue("--renderer"));
        break;
      case "--skip-renderer":
        opts.skipRenderer = true;
        break;
      case "--zip":
        opts.zip = true;
        break;
      default:
        throw new Error(`未知参数: ${argv[i]}`);
    }
  }
  if (opts.skipRenderer && opts.renderer) throw new Error("--skip-renderer 与 --renderer 互斥，不能同时指定");
  return opts;
}

/** 执行外部命令；失败抛出带上下文与退出码的错误。 */
function run(cmd: string, args: string[], label: string): void {
  console.log(`[package] ${label}`);
  try {
    execFileSync(cmd, args, { stdio: "inherit" });
  } catch (err) {
    const code = (err as { status?: number }).status;
    const hint = code === undefined ? "（可能未安装或不在 PATH，请先确认环境）" : `（退出码 ${code}）`;
    throw new Error(`${label} 失败${hint}: ${cmd} ${args.join(" ")}`);
  }
}

/** 执行允许失败的外部命令（如 taskkill 无进程匹配），失败仅告警。 */
function runSoft(cmd: string, args: string[], label: string): void {
  try {
    execFileSync(cmd, args, { stdio: "inherit" });
  } catch {
    console.warn(`[package] 警告: ${label}（无进程匹配或已结束，忽略）`);
  }
}

/** 在目录树中定位游戏 exe（GAME_EXE_NAMES），返回其所在目录；多命中取路径最浅者。 */
function findGameExeDir(searchRoot: string): string | null {
  const hits: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && GAME_EXE_NAMES.has(e.name.toLowerCase())) hits.push(p);
    }
  };
  walk(searchRoot, 0);
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length);
  return dirname(hits[0]);
}

function mb(n: number): string {
  return `${(n / 1048576).toFixed(1)} MB`;
}

function dirSize(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) total += statSync(p).size;
  }
  return total;
}

/** bridge tsc 构建（先跑，快速失败）。 */
function buildBridgeTsc(): void {
  run("cmd.exe", ["/c", "npm", "--prefix", BRIDGE, "run", "build"], "bridge: npm run build (tsc)");
}

/** bun build --compile 出无控制台窗口的单 exe（--windows-hide-console 需 Bun >= 1.1.27，闪窗收口）。 */
function compileExe(entryJs: string, outExe: string): void {
  run(
    "bun",
    ["build", "--compile", "--windows-hide-console", entryJs, "--outfile", outExe],
    `bridge: bun compile ${basename(entryJs)} -> ${basename(outExe)}`,
  );
}

/** B. renderer：返回要拷贝为 renderer/ 的目录；跳过时返回 null。 */
function buildRenderer(opts: Options): string | null {
  if (opts.skipRenderer) {
    console.warn("[package] 警告: --skip-renderer，插件目录不含 renderer/（渲染进程）");
    return null;
  }
  if (opts.renderer) {
    if (opts.renderer === resolve(join(opts.out, "kpet"))) {
      throw new Error("--renderer 不能指向插件根目录本身，请指向其 renderer 子目录或外部 UE 产物目录");
    }
    if (!existsSync(opts.renderer)) throw new Error(`--renderer 目录不存在: ${opts.renderer}`);
    const exeDir = findGameExeDir(opts.renderer);
    if (exeDir) {
      console.log(`[package] renderer: ${opts.renderer} 中定位到游戏 exe，取所在目录 ${exeDir}`);
      return exeDir;
    }
    console.warn(`[package] 警告: ${opts.renderer} 中未找到游戏 exe，将整体拷贝该目录`);
    return opts.renderer;
  }

  // 默认路径：UE 打包（Shipping，与文档统一命令一致）
  if (!existsSync(RUN_UAT)) throw new Error(`未找到 RunUAT.bat: ${RUN_UAT}（请确认 UE_5.8 安装路径，或改用 --renderer/--skip-renderer）`);
  runSoft("taskkill", ["/F", "/IM", "UnrealEditor.exe"], "taskkill UnrealEditor.exe（打包前清理）");
  // 清掉旧 staging，避免残留目录干扰 exe 定位
  rmSync(STAGE_ROOT, { recursive: true, force: true });
  run(
    "cmd.exe",
    [
      "/c", RUN_UAT, "BuildCookRun",
      `-project=${UE_PROJECT}`, "-noP4", "-platform=Win64",
      "-clientconfig=Shipping", "-cook", "-build", "-stage", "-pak",
      "-iostore", "-compressed", "-nodebuginfo", "-clean", "-prereqs",
    ],
    "UE: BuildCookRun（Shipping，首次约 10-20 分钟）",
  );
  const exeDir = findGameExeDir(STAGE_ROOT);
  if (!exeDir) {
    throw new Error(
      `UE 打包完成但未在 ${STAGE_ROOT} 下找到游戏 exe（${[...GAME_EXE_NAMES].join("/")}）。` +
        "请检查上方 RunUAT 输出是否实际产出；也可改用 --renderer <目录> 指向打包产物。",
    );
  }
  console.log(`[package] renderer: 定位到游戏 exe 目录 ${exeDir}`);
  return exeDir;
}

/** C2. renderer 兜底删除：递归扫描并删除不随包分发的文件，逐项打印删了什么、省了多少字节。 */
function pruneRenderer(rendererDir: string): void {
  const removed: { path: string; size: number }[] = [];
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile()) {
        const lower = e.name.toLowerCase();
        const hit =
          lower.endsWith(".pdb") || D3D12_DLL_NAMES.has(lower) || NVAFTERMATH_DLL_NAMES.has(lower);
        if (hit) {
          const size = statSync(p).size;
          rmSync(p, { force: true });
          removed.push({ path: p, size });
          console.log(`[package] 兜底删除: ${p}（省 ${size} 字节，${mb(size)}）`);
        }
      }
    }
  };
  walk(rendererDir);
  if (removed.length > 0) {
    const total = removed.reduce((sum, r) => sum + r.size, 0);
    console.log(`[package] 兜底删除: 共移除 ${removed.length} 个文件，节省 ${total} 字节（${mb(total)}）`);
  } else {
    console.log("[package] 兜底删除: 未发现需要删除的文件");
  }
}

/** C. 组装 <out>/kpet/。 */
function assemble(opts: Options, rendererDir: string | null): string {
  const pluginDir = join(opts.out, "kpet");
  // 若 --renderer 源位于目标插件目录内部（复用 dist-plugin/kpet/renderer 的常见场景），
  // 先整体复制到系统临时目录暂存，避免下面 rmSync(pluginDir) 把源目录一并删掉。
  let rendererSource = rendererDir;
  if (rendererDir && (rendererDir === pluginDir || rendererDir.startsWith(pluginDir + sep))) {
    const stage = join(tmpdir(), `kpet-renderer-stage-${process.pid}-${Date.now()}`);
    cpSync(rendererDir, stage, { recursive: true });
    rendererSource = stage;
    console.log(`[package] 组装: renderer 源位于目标插件目录内部，暂存到 ${stage}`);
  }
  rmSync(pluginDir, { recursive: true, force: true });
  mkdirSync(join(pluginDir, "bin"), { recursive: true });

  copyFileSync(MANIFEST, join(pluginDir, "kimi.plugin.json"));
  console.log(`[package] 组装: ${MANIFEST} -> ${join(pluginDir, "kimi.plugin.json")}`);

  copyFileSync(MANIFEST_WSL, join(pluginDir, "kimi.plugin.wsl.json"));
  console.log(`[package] 组装: ${MANIFEST_WSL} -> ${join(pluginDir, "kimi.plugin.wsl.json")}`);

  copyFileSync(DEPLOY_SH, join(pluginDir, "deploy.sh"));
  console.log(`[package] 组装: ${DEPLOY_SH} -> ${join(pluginDir, "deploy.sh")}`);

  copyFileSync(DEPLOY_PS1, join(pluginDir, "deploy.ps1"));
  console.log(`[package] 组装: ${DEPLOY_PS1} -> ${join(pluginDir, "deploy.ps1")}`);

  compileExe(join(BRIDGE, "dist", "launcher", "main.js"), join(pluginDir, "bin", "kpetd.exe"));

  copyFileSync(RELAY_SCRIPT, join(pluginDir, "bin", "kpet-relay.sh"));
  console.log(`[package] 组装: ${RELAY_SCRIPT} -> ${join(pluginDir, "bin", "kpet-relay.sh")}`);

  if (rendererSource) {
    cpSync(rendererSource, join(pluginDir, "renderer"), { recursive: true });
    console.log(`[package] 组装: ${rendererSource} -> ${join(pluginDir, "renderer")}`);
    pruneRenderer(join(pluginDir, "renderer"));
    if (rendererSource !== rendererDir) rmSync(rendererSource, { recursive: true, force: true });
  }
  return pluginDir;
}

/** C3. 产物自检：校验插件目录关键文件齐全非空、POSIX 脚本无 CRLF、renderer 含游戏 exe；任一不满足抛错。 */
function verifyAssembled(pluginDir: string, rendererDir: string | null): void {
  const required: string[] = [
    join(pluginDir, "kimi.plugin.json"),
    join(pluginDir, "kimi.plugin.wsl.json"),
    join(pluginDir, "deploy.sh"),
    join(pluginDir, "deploy.ps1"),
    join(pluginDir, "bin", "kpet-relay.sh"),
    join(pluginDir, "bin", "kpetd.exe"),
  ];
  for (const p of required) {
    const name = p.slice(pluginDir.length + 1).replace(/\\/g, "/");
    if (!existsSync(p) || statSync(p).size === 0) {
      throw new Error(`产物自检失败: ${name} 缺失或为空: ${p}`);
    }
  }
  for (const p of [join(pluginDir, "deploy.sh"), join(pluginDir, "bin", "kpet-relay.sh")]) {
    if (readFileSync(p).includes(0x0d)) {
      throw new Error(`产物自检失败: ${p} 含 CRLF 换行，部署/relay 脚本需以 LF 保存`);
    }
  }
  if (rendererDir) {
    const hasExe = readdirSync(join(pluginDir, "renderer")).some((n) =>
      GAME_EXE_NAMES.has(n.toLowerCase()),
    );
    if (!hasExe) {
      throw new Error(
        `产物自检失败: renderer/ 中未找到游戏 exe（${[...GAME_EXE_NAMES].join("/")}），` +
          "请检查 --renderer 目录或 UE 打包产物",
      );
    }
  }
  console.log(
    rendererDir
      ? "[package] 自检: 关键文件齐全、脚本无 CRLF、renderer 合法"
      : "[package] 自检: 关键文件齐全、脚本无 CRLF（--skip-renderer，renderer 未检查）",
  );
}

/** 版本同步检查：仓库根 package.json 与两份插件清单的 version 必须一致，防止打包版本漂移。 */
function verifyVersions(): void {
  const root = JSON.parse(readFileSync(ROOT_PKG, "utf8")) as { version?: string };
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { version?: string };
  const manifestWsl = JSON.parse(readFileSync(MANIFEST_WSL, "utf8")) as { version?: string };
  const show = (v: string | undefined): string => v ?? "（缺失）";
  if (!root.version || root.version !== manifest.version || root.version !== manifestWsl.version) {
    throw new Error(
      `版本号不同步: 根 package.json version=${show(root.version)}，` +
        `kimi.plugin.json=${show(manifest.version)}，kimi.plugin.wsl.json=${show(manifestWsl.version)}，` +
        "请先同步版本号再打包",
    );
  }
}

/** D. 可选 zip（PowerShell Compress-Archive）。 */
function makeZip(pluginDir: string, out: string): string {
  const zipPath = join(out, "kpet.zip");
  rmSync(zipPath, { force: true });
  run(
    "powershell.exe",
    ["-NoProfile", "-Command", `Compress-Archive -Path '${pluginDir}' -DestinationPath '${zipPath}'`],
    `zip: ${zipPath}`,
  );
  return zipPath;
}

function summarize(pluginDir: string, opts: Options, rendererDir: string | null): void {
  console.log("\n[package] 完成，产物清单:");
  console.log(`  ${pluginDir}/  （共 ${mb(dirSize(pluginDir))}）`);
  console.log(`    kimi.plugin.json  ${mb(statSync(join(pluginDir, "kimi.plugin.json")).size)}`);
  console.log(`    kimi.plugin.wsl.json  ${mb(statSync(join(pluginDir, "kimi.plugin.wsl.json")).size)}`);
  console.log(`    deploy.sh  ${mb(statSync(join(pluginDir, "deploy.sh")).size)}`);
  console.log(`    deploy.ps1  ${mb(statSync(join(pluginDir, "deploy.ps1")).size)}`);
  for (const f of readdirSync(join(pluginDir, "bin"))) {
    const p = join(pluginDir, "bin", f);
    console.log(`    bin/${f}  ${mb(statSync(p).size)}`);
  }
  const rd = join(pluginDir, "renderer");
  if (rendererDir) {
    const entries = readdirSync(rd);
    console.log(`    renderer/  （${entries.length} 项，共 ${mb(dirSize(rd))}）`);
    for (const e of entries.slice(0, 12)) console.log(`      ${e}`);
    if (entries.length > 12) console.log(`      …（其余 ${entries.length - 12} 项略）`);
  } else {
    console.log(`    renderer/  （未包含 — 重跑时去掉 --skip-renderer，或 --renderer <目录> 指定 UE 打包产物）`);
  }
  if (opts.zip) console.log(`  ${join(opts.out, "kpet.zip")}`);
  console.log(`\n[package] 安装: 在 kimi 中执行 /plugins install ${join(opts.out, "kpet")}`);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(MANIFEST)) throw new Error(`插件清单缺失: ${MANIFEST}`);
  if (!existsSync(MANIFEST_WSL)) throw new Error(`WSL 插件清单缺失: ${MANIFEST_WSL}`);
  if (!existsSync(RELAY_SCRIPT)) throw new Error(`WSL relay 脚本缺失: ${RELAY_SCRIPT}`);
  if (!existsSync(DEPLOY_SH)) throw new Error(`部署脚本缺失: ${DEPLOY_SH}`);
  if (!existsSync(DEPLOY_PS1)) throw new Error(`部署脚本缺失: ${DEPLOY_PS1}`);
  verifyVersions();
  const launcherEntry = join(BRIDGE, "dist", "launcher", "main.js");

  console.log("[package] ===== A. bridge 单 exe（launcher）=====\n");
  buildBridgeTsc();
  if (!existsSync(launcherEntry)) throw new Error(`bridge 构建产物缺失: ${launcherEntry}（npm run build 应产出该文件）`);

  console.log("\n[package] ===== B. UE 渲染进程 =====\n");
  const rendererDir = buildRenderer(opts);

  console.log("\n[package] ===== C. 组装插件目录 =====\n");
  const pluginDir = assemble(opts, rendererDir);
  verifyAssembled(pluginDir, rendererDir);

  if (opts.zip) makeZip(pluginDir, opts.out);

  summarize(pluginDir, opts, rendererDir);
}

try {
  main();
} catch (err) {
  console.error(`\n[package] 错误: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
