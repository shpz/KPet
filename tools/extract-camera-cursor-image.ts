/**
 * 从源图片生成 R 键摄像机光标的内嵌像素头文件。
 *
 * 用法：
 *
 *     node --experimental-strip-types tools/extract-camera-cursor-image.ts <源图.png> [输出头文件]
 *
 * 默认输出 Pet/Source/Pet/Private/Platform/CameraCursorImageData.h（相对仓库根解析）。
 * 生成后重新编译 Pet 目标即可生效；以后改图只需重跑本脚本。
 *
 * 实现说明：
 * - 仅用 node: 标准库（zlib/Buffer），无第三方依赖；
 * - 仅支持 8bit、非交错的 PNG，颜色类型 6（RGBA）或 2（RGB，补全不透明 alpha），
 *   其他格式请先在画图/Blender 里另存为 PNG 再跑；
 * - 最近邻采样到 32×32（与 PetLayeredWindow.cpp 里 CreateCameraCursor 的光标尺寸一致），
 *   采样公式与运行时代码相同（SrcX = X * SrcW / 32），像素结果与旧运行时采样完全等价；
 * - 输出 BGRA 字节序（预乘不做，CreateIconIndirect 的 32bpp DIB 直接使用直通 alpha）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const CURSOR_SIZE = 32;
const DEFAULT_OUTPUT = "Pet/Source/Pet/Private/Platform/CameraCursorImageData.h";

const COLORTYPE_RGB = 2;
const COLORTYPE_RGBA = 6;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 生成头文件的换行：历史产物由 Python 文本模式写出，Windows 下为 CRLF，保持不变。 */
const CRLF = "\r\n";

const USAGE = `从源图片生成 R 键摄像机光标的内嵌像素头文件。

用法：
    node --experimental-strip-types tools/extract-camera-cursor-image.ts <源图.png> [输出头文件]

默认输出 ${DEFAULT_OUTPUT}（相对仓库根解析）。`;

interface PngImage {
  width: number;
  height: number;
  /** RGBA 字节（每像素 4 字节）。 */
  rgba: Buffer;
}

/** 解码 PNG。只支持 8bit 非交错、颜色类型 2/6。 */
function decodePng(path: string): PngImage {
  const data = readFileSync(path);
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`不是 PNG 文件: ${path}`);
  }

  let width = -1;
  let height = -1;
  let bitDepth = -1;
  let colorType = -1;
  let interlace = -1;
  const idatParts: Buffer[] = [];
  let pos = 8;
  while (pos < data.length) {
    const length = data.readUInt32BE(pos);
    const chunkType = data.toString("latin1", pos + 4, pos + 8);
    const body = data.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (chunkType === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (chunkType === "IDAT") {
      idatParts.push(Buffer.from(body));
    } else if (chunkType === "IEND") {
      break;
    }
  }

  if (width < 0) {
    throw new Error("PNG 缺少 IHDR");
  }
  if (bitDepth !== 8 || (colorType !== COLORTYPE_RGB && colorType !== COLORTYPE_RGBA) || interlace !== 0) {
    throw new Error(
      `仅支持 8bit 非交错的 RGBA/RGB PNG（实际 bitdepth=${bitDepth} ` +
        `colortype=${colorType} interlace=${interlace}），请另存为标准 PNG 后重试`,
    );
  }

  const channels = colorType === COLORTYPE_RGBA ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idatParts));
  const expected = (stride + 1) * height;
  if (raw.length < expected) {
    throw new Error(`IDAT 解压后长度不足：${raw.length} < ${expected}`);
  }

  // 逐行去滤波（filter 类型 0-4）。
  const pixels = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[offset];
    const line = Buffer.from(raw.subarray(offset + 1, offset + 1 + stride));
    offset += stride + 1;
    if (filterType === 1) {
      // Sub
      for (let i = channels; i < stride; i++) {
        line[i] = (line[i] + line[i - channels]) & 0xff;
      }
    } else if (filterType === 2) {
      // Up
      for (let i = 0; i < stride; i++) {
        line[i] = (line[i] + prev[i]) & 0xff;
      }
    } else if (filterType === 3) {
      // Average
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? line[i - channels] : 0;
        line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
    } else if (filterType === 4) {
      // Paeth
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? line[i - channels] : 0;
        const b = prev[i];
        const c = i >= channels ? prev[i - channels] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + predictor) & 0xff;
      }
    } else if (filterType !== 0) {
      throw new Error(`未知 PNG 滤波类型: ${filterType}`);
    }
    line.copy(pixels, y * stride);
    prev = line;
  }

  // 统一到 RGBA。
  if (channels === 3) {
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      pixels.copy(rgba, i * 4, i * 3, i * 3 + 3);
      rgba[i * 4 + 3] = 0xff;
    }
    return { width, height, rgba };
  }
  return { width, height, rgba: pixels };
}

/** 最近邻采样到 dstSize 正方形，公式与 CreateCameraCursor 的运行时采样一致。 */
function downsampleNearest(srcW: number, srcH: number, rgba: Buffer, dstSize: number): Buffer {
  const out = Buffer.alloc(dstSize * dstSize * 4);
  for (let y = 0; y < dstSize; y++) {
    const srcY = Math.floor((y * srcH) / dstSize);
    for (let x = 0; x < dstSize; x++) {
      const srcX = Math.floor((x * srcW) / dstSize);
      rgba.copy(out, (y * dstSize + x) * 4, (srcY * srcW + srcX) * 4, (srcY * srcW + srcX) * 4 + 4);
    }
  }
  return out;
}

function generateHeader(bgra: Buffer, sourceName: string, srcW: number, srcH: number): string {
  const lines = [
    "// 本文件由 tools/extract-camera-cursor-image.ts 生成，请勿手改。",
    `// 源图 ${sourceName}（${srcW}×${srcH}），已最近邻采样到 ${CURSOR_SIZE}×${CURSOR_SIZE} 并转成 BGRA。`,
    "// 改图后重跑该脚本并重新编译即可。",
    "#pragma once",
    "",
    "namespace CameraCursorImageData",
    "{",
    `\tconstexpr int32 Width = ${CURSOR_SIZE};`,
    `\tconstexpr int32 Height = ${CURSOR_SIZE};`,
    "\tconst uint8 Bgra[] =",
    "\t{",
  ];
  for (let i = 0; i < bgra.length; i += 16) {
    const cells: string[] = [];
    for (let j = i; j < Math.min(i + 16, bgra.length); j++) {
      cells.push(`0x${bgra[j].toString(16).toUpperCase().padStart(2, "0")}`);
    }
    lines.push("\t\t" + cells.join(", ") + ",");
  }
  lines.push("\t};", "}", "");
  return lines.join(CRLF);
}

function main(): number {
  const source = process.argv[2];
  if (!source) {
    console.log(USAGE);
    return 1;
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const output = process.argv[3] ? resolve(process.argv[3]) : resolve(repoRoot, DEFAULT_OUTPUT);
  if (!existsSync(source)) {
    throw new Error(`源图不存在: ${source}`);
  }

  const { width, height, rgba } = decodePng(source);
  const sampled = downsampleNearest(width, height, rgba, CURSOR_SIZE);

  // RGBA -> BGRA（R 与 B 通道互换）。
  const bgra = Buffer.alloc(sampled.length);
  for (let i = 0; i < sampled.length; i += 4) {
    bgra[i] = sampled[i + 2];
    bgra[i + 1] = sampled[i + 1];
    bgra[i + 2] = sampled[i];
    bgra[i + 3] = sampled[i + 3];
  }

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, generateHeader(bgra, basename(source), width, height));
  console.log(`已生成 ${output}：${width}×${height} -> ${CURSOR_SIZE}×${CURSOR_SIZE} BGRA，${bgra.length} 字节`);
  return 0;
}

process.exitCode = main();
