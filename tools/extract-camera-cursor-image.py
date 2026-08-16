"""从源图片生成 R 键摄像机光标的内嵌像素头文件。

用法：

    python tools/extract-camera-cursor-image.py <源图.png> [输出头文件]

默认输出 Pet/Source/Pet/Private/Platform/CameraCursorImageData.h（相对仓库根解析）。
生成后重新编译 Pet 目标即可生效；以后改图只需重跑本脚本。

实现说明：
- 仅用 Python 标准库（zlib/struct），无第三方依赖；
- 仅支持 8bit、非交错的 PNG，颜色类型 6（RGBA）或 2（RGB，补全不透明 alpha），
  其他格式请先在画图/Blender 里另存为 PNG 再跑；
- 最近邻采样到 32×32（与 PetLayeredWindow.cpp 里 CreateCameraCursor 的光标尺寸一致），
  采样公式与运行时代码相同（SrcX = X * SrcW / 32），像素结果与旧运行时采样完全等价；
- 输出 BGRA 字节序（预乘不做，CreateIconIndirect 的 32bpp DIB 直接使用直通 alpha）。
"""

import struct
import sys
import zlib
from pathlib import Path

CURSOR_SIZE = 32
DEFAULT_OUTPUT = "Pet/Source/Pet/Private/Platform/CameraCursorImageData.h"

COLORTYPE_RGB = 2
COLORTYPE_RGBA = 6


def decode_png(path):
    """解码 PNG，返回 (宽, 高, RGBA 字节列表)。只支持 8bit 非交错、颜色类型 2/6。"""
    data = Path(path).read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"不是 PNG 文件: {path}")

    width = height = None
    bit_depth = color_type = interlace = None
    idat = bytearray()
    pos = 8
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        chunk_type = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, _comp, _filt, interlace = struct.unpack(
                ">IIBBBBB", body
            )
        elif chunk_type == b"IDAT":
            idat += body
        elif chunk_type == b"IEND":
            break

    if width is None:
        raise ValueError("PNG 缺少 IHDR")
    if bit_depth != 8 or color_type not in (COLORTYPE_RGB, COLORTYPE_RGBA) or interlace != 0:
        raise ValueError(
            f"仅支持 8bit 非交错的 RGBA/RGB PNG（实际 bitdepth={bit_depth} "
            f"colortype={color_type} interlace={interlace}），请另存为标准 PNG 后重试"
        )

    channels = 4 if color_type == COLORTYPE_RGBA else 3
    stride = width * channels
    raw = zlib.decompress(bytes(idat))
    expected = (stride + 1) * height
    if len(raw) < expected:
        raise ValueError(f"IDAT 解压后长度不足：{len(raw)} < {expected}")

    # 逐行去滤波（filter 类型 0-4）。
    pixels = bytearray()
    prev = bytearray(stride)
    offset = 0
    for _y in range(height):
        filter_type = raw[offset]
        line = bytearray(raw[offset + 1 : offset + 1 + stride])
        offset += stride + 1
        if filter_type == 1:  # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif filter_type == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif filter_type == 3:  # Average
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif filter_type == 4:  # Paeth
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                predictor = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + predictor) & 0xFF
        elif filter_type != 0:
            raise ValueError(f"未知 PNG 滤波类型: {filter_type}")
        pixels += line
        prev = line

    # 统一到 RGBA。
    if channels == 3:
        rgba = bytearray(width * height * 4)
        for i in range(width * height):
            rgba[i * 4 : i * 4 + 3] = pixels[i * 3 : i * 3 + 3]
            rgba[i * 4 + 3] = 0xFF
        pixels = rgba
    return width, height, pixels


def downsample_nearest(src_w, src_h, rgba, dst_size):
    """最近邻采样到 dst_size 正方形，公式与 CreateCameraCursor 的运行时采样一致。"""
    out = bytearray(dst_size * dst_size * 4)
    for y in range(dst_size):
        src_y = y * src_h // dst_size
        for x in range(dst_size):
            src_x = x * src_w // dst_size
            out[(y * dst_size + x) * 4 : (y * dst_size + x) * 4 + 4] = rgba[
                (src_y * src_w + src_x) * 4 : (src_y * src_w + src_x) * 4 + 4
            ]
    return out


def generate_header(bgra, source_name, src_w, src_h):
    lines = [
        "// 本文件由 tools/extract-camera-cursor-image.py 生成，请勿手改。",
        f"// 源图 {source_name}（{src_w}×{src_h}），已最近邻采样到 {CURSOR_SIZE}×{CURSOR_SIZE} 并转成 BGRA。",
        "// 改图后重跑该脚本并重新编译即可。",
        "#pragma once",
        "",
        "namespace CameraCursorImageData",
        "{",
        f"\tconstexpr int32 Width = {CURSOR_SIZE};",
        f"\tconstexpr int32 Height = {CURSOR_SIZE};",
        "\tconst uint8 Bgra[] =",
        "\t{",
    ]
    for i in range(0, len(bgra), 16):
        lines.append("\t\t" + ", ".join(f"0x{b:02X}" for b in bgra[i : i + 16]) + ",")
    lines += ["\t};", "}", ""]
    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    source = Path(sys.argv[1])
    repo_root = Path(__file__).resolve().parent.parent
    output = Path(sys.argv[2]) if len(sys.argv) > 2 else repo_root / DEFAULT_OUTPUT

    src_w, src_h, rgba = decode_png(source)
    sampled = downsample_nearest(src_w, src_h, rgba, CURSOR_SIZE)

    # RGBA -> BGRA（R 与 B 通道互换）。
    bgra = bytearray(len(sampled))
    for i in range(0, len(sampled), 4):
        bgra[i] = sampled[i + 2]
        bgra[i + 1] = sampled[i + 1]
        bgra[i + 2] = sampled[i]
        bgra[i + 3] = sampled[i + 3]

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(generate_header(bgra, source.name, src_w, src_h), encoding="utf-8")
    print(f"已生成 {output}：{src_w}×{src_h} -> {CURSOR_SIZE}×{CURSOR_SIZE} BGRA，{len(bgra)} 字节")
    return 0


if __name__ == "__main__":
    sys.exit(main())
