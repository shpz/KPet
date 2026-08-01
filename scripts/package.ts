/**
 * KimiPet 整包打包脚本（仓库根）—— 打包是整个产品的事（bridge 转发器 + UE5 渲染进程），
 * 所以脚本放在仓库根，而不是 bridge 子工程里。
 *
 * 用法（Node >= 22.6，仅 node: 标准库，无任何依赖）：
 *   node --experimental-strip-types scripts/package.ts
 *       [--skip-renderer]                      # 完全跳过 UE 渲染进程（插件不含 renderer/）
 *       [--renderer <目录>]                    # 用现成的 UE 打包产物，跳过 UE 构建（与 --skip-renderer 互斥）
 *       [--ue-config <Development|Shipping>]   # UE 打包配置，默认 Development
 *       [--out <目录>]                         # 输出父目录，默认 <仓库根>/dist-plugin
 *       [--zip]                                # 额外用 PowerShell Compress-Archive 打 kimi-pet.zip
 *
 * 流程：
 *   A. bridge 子工程：npm --prefix bridge run build（tsc）→ bun build --compile --windows-hide-console
 *      （dist/bridge/main.js → bin/kimi-pet-bridge.exe；dist/daemon/main.js 存在时 → bin/kimi-petd.exe，否则告警跳过）
 *   B. renderer：默认 RunUAT.bat BuildCookRun 打包 UE（Win64、--ue-config；打包前 taskkill UnrealEditor.exe），
 *      完成后在 StagedBuilds 里定位游戏 exe 所在的整个目录（即 §3.2 的 renderer/ 本体）；
 *      --skip-renderer / --renderer 可跳过 UE 构建
 *   C. 组装 <out>/kimi-pet/{kimi.plugin.json, bin/, renderer/}（docs/MVP设计.md §3.2）
 *   D. 可选 --zip
 *
 * 任一步失败即非零退出并给出清晰错误；结尾打印产物清单与 /plugins install 提示。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, cpSync, copyFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = join(ROOT, "bridge");
const UE_PROJECT = join(ROOT, "Pet", "Pet.uproject");
const UE_ENGINE = "C:\\Program Files\\Epic Games\\UE_5.8";
const RUN_UAT = join(UE_ENGINE, "Engine", "Build", "BatchFiles", "RunUAT.bat");
const MANIFEST = join(BRIDGE, "packaging", "kimi-pet", "kimi.plugin.json");
const STAGE_ROOT = join(ROOT, "Pet", "Saved", "StagedBuilds");
/** UE 渲染进程可执行名：工程目标名是 Pet（产物 Pet.exe）；设计文档 §3.2 写作 KimiPet.exe，两种都认。 */
const GAME_EXE_NAMES = new Set(["pet.exe", "kimipet.exe"]);

interface Options {
  out: string;
  renderer: string | null;
  skipRenderer: boolean;
  ueConfig: "Development" | "Shipping";
  zip: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    out: join(ROOT, "dist-plugin"),
    renderer: null,
    skipRenderer: false,
    ueConfig: "Development",
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
      case "--ue-config": {
        const v = takeValue("--ue-config");
        if (v !== "Development" && v !== "Shipping") throw new Error(`--ue-config 只支持 Development|Shipping，收到: ${v}`);
        opts.ueConfig = v;
        break;
      }
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
    let entries: ReturnType<typeof readdirSync>;
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

/** A1. bridge tsc 构建（先跑，快速失败）。 */
function buildBridgeTsc(): void {
  run("cmd.exe", ["/c", "npm", "--prefix", BRIDGE, "run", "build"], "bridge: npm run build (tsc)");
}

/** A2. bun build --compile 出无控制台窗口的单 exe（--windows-hide-console 需 Bun >= 1.1.27，§3.1 闪窗收口）。 */
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
    if (!existsSync(opts.renderer)) throw new Error(`--renderer 目录不存在: ${opts.renderer}`);
    const exeDir = findGameExeDir(opts.renderer);
    if (exeDir) {
      console.log(`[package] renderer: ${opts.renderer} 中定位到游戏 exe，取所在目录 ${exeDir}`);
      return exeDir;
    }
    console.warn(`[package] 警告: ${opts.renderer} 中未找到游戏 exe，将整体拷贝该目录`);
    return opts.renderer;
  }

  // 默认路径：UE 打包
  if (!existsSync(RUN_UAT)) throw new Error(`未找到 RunUAT.bat: ${RUN_UAT}（请确认 UE_5.8 安装路径，或改用 --renderer/--skip-renderer）`);
  runSoft("taskkill", ["/F", "/IM", "UnrealEditor.exe"], "taskkill UnrealEditor.exe（打包前清理）");
  // 清掉旧 staging，避免残留目录干扰 exe 定位
  rmSync(STAGE_ROOT, { recursive: true, force: true });
  run(
    "cmd.exe",
    [
      "/c", RUN_UAT, "BuildCookRun",
      `-project=${UE_PROJECT}`, "-noP4", "-platform=Win64",
      `-clientconfig=${opts.ueConfig}`, "-cook", "-build", "-stage", "-pak",
    ],
    `UE: BuildCookRun（${opts.ueConfig}，首次约 10-20 分钟）`,
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

/** C. 组装 <out>/kimi-pet/。 */
function assemble(opts: Options, rendererDir: string | null): string {
  const pluginDir = join(opts.out, "kimi-pet");
  rmSync(pluginDir, { recursive: true, force: true });
  mkdirSync(join(pluginDir, "bin"), { recursive: true });

  copyFileSync(MANIFEST, join(pluginDir, "kimi.plugin.json"));
  console.log(`[package] 组装: ${MANIFEST} -> ${join(pluginDir, "kimi.plugin.json")}`);

  compileExe(join(BRIDGE, "dist", "bridge", "main.js"), join(pluginDir, "bin", "kimi-pet-bridge.exe"));
  const daemonEntry = join(BRIDGE, "dist", "daemon", "main.js");
  if (existsSync(daemonEntry)) {
    compileExe(daemonEntry, join(pluginDir, "bin", "kimi-petd.exe"));
  } else {
    console.warn("[package] 警告: 未找到 bridge/dist/daemon/main.js，跳过 kimi-petd.exe（守护进程尚未实现，实现后自动带上）");
  }

  if (rendererDir) {
    cpSync(rendererDir, join(pluginDir, "renderer"), { recursive: true });
    console.log(`[package] 组装: ${rendererDir} -> ${join(pluginDir, "renderer")}`);
  }
  return pluginDir;
}

/** D. 可选 zip（PowerShell Compress-Archive）。 */
function makeZip(pluginDir: string, out: string): string {
  const zipPath = join(out, "kimi-pet.zip");
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
  if (opts.zip) console.log(`  ${join(opts.out, "kimi-pet.zip")}`);
  console.log(`\n[package] 安装: 在 kimi 中执行 /plugins install ${join(opts.out, "kimi-pet")}`);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(MANIFEST)) throw new Error(`插件清单缺失: ${MANIFEST}`);
  const bridgeEntry = join(BRIDGE, "dist", "bridge", "main.js");

  console.log("[package] ===== A. bridge 转发器 =====\n");
  buildBridgeTsc();
  if (!existsSync(bridgeEntry)) throw new Error(`bridge 构建产物缺失: ${bridgeEntry}（npm run build 应产出该文件）`);

  console.log("\n[package] ===== B. UE 渲染进程 =====\n");
  const rendererDir = buildRenderer(opts);

  console.log("\n[package] ===== C. 组装插件目录 =====\n");
  const pluginDir = assemble(opts, rendererDir);

  if (opts.zip) makeZip(pluginDir, opts.out);

  summarize(pluginDir, opts, rendererDir);
}

try {
  main();
} catch (err) {
  console.error(`\n[package] 错误: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
