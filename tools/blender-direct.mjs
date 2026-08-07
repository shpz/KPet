#!/usr/bin/env node
/**
 * 直连 Blender 5.2 官方 MCP 扩展的 socket 服务（端口 9876）。
 *
 * 用法:
 *   node tools/blender-direct.mjs "<python code>"
 *
 * 协议（null 字节分隔的 JSON）:
 *   请求: {"type": "execute", "code": "...", "strict_json": true}\0
 *   响应: {"status": "ok", "result": {...}}\0  或  {"status": "error", "message": "..."}\0
 *
 * Python 代码中通过给 `result` 字典赋值来返回数据（必须是 JSON 可序列化）。
 */
import net from "node:net";

const code = process.argv[2];
if (!code) {
  console.error("usage: node blender-direct.mjs '<python code>'");
  process.exit(2);
}

const HOST = "127.0.0.1";
const PORT = 9876;

const request = JSON.stringify({ type: "execute", code, strict_json: true });

const sock = net.connect(PORT, HOST);
let buf = Buffer.alloc(0);
let settled = false;

const finish = (codeOut) => {
  if (settled) return;
  settled = true;
  sock.destroy();
  process.exit(codeOut);
};

sock.on("connect", () => sock.write(request + "\0"));
sock.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  const idx = buf.indexOf(0);
  if (idx === -1) return;
  const payload = buf.subarray(0, idx).toString("utf8");
  try {
    const resp = JSON.parse(payload);
    if (resp.status === "ok") {
      if (resp.stdout) process.stderr.write(resp.stdout);
      if (resp.stderr) process.stderr.write(resp.stderr);
      console.log(JSON.stringify(resp.result, null, 2));
      finish(0);
    } else {
      if (resp.stdout) process.stderr.write(resp.stdout);
      if (resp.stderr) process.stderr.write(resp.stderr);
      console.error(resp.message);
      finish(1);
    }
  } catch (e) {
    console.error("bad JSON from blender:", payload.slice(0, 500));
    finish(1);
  }
});
sock.on("error", (e) => {
  console.error("socket error:", e.message);
  finish(1);
});
sock.setTimeout(30000, () => {
  console.error("timeout waiting for blender response");
  finish(1);
});
