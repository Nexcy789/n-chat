#!/usr/bin/env node
/**
 * 单独拉起无头浏览器（给 启动机器人.bat 用）。
 *
 * 为什么不直接在 bat 里写 start "..." msedge.exe --xxx：
 * Chromium 的参数里有大量引号、括号、分号（尤其 --user-agent），
 * 在 cmd 里很容易被重新解析。这里复用 bridge.mjs 的 launchDoubao——
 * 那是 spawn(数组) 调用，不经过 shell 解析，参数可以做到和插件完全一致。
 *
 * 用法：node tools/start-web.mjs [port]
 */
import { launchDoubao, isCdpAlive, DEFAULT_CDP_PORT } from '../lib/bridge.mjs'

const port = Number(process.argv[2]) || DEFAULT_CDP_PORT

if (await isCdpAlive(port, 1500)) {
  console.log(`[doubao-web] already alive on ${port}, skip`)
  process.exit(0)
}

try {
  launchDoubao({ port })
  console.log(`[doubao-web] headless Edge launched on port ${port}`)
} catch (e) {
  console.error('[doubao-web] launch failed: ' + (e?.message || e))
  process.exit(1)
}
