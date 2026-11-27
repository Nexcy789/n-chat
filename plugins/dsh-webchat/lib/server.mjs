/**
 * 网页和接口。
 *
 * 不依赖 DSH 的 webServer —— 自己起一个端口，好处是调试时可以直接 curl，
 * 也不用担心 DSH 的 browser-trust 那套校验。
 *
 * 接口一共四个：
 *   GET  /api/state            会话列表 + 每个会话的最近消息
 *   GET  /api/messages?conv=&after=   增量拉（前端轮询用）
 *   POST /api/send             发一条
 *   GET  /api/health           活着没
 */

import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

/**
 * 手机壳从 http://nchat.local 加载页面，打接口就变成跨源请求了，
 * 所以每个响应都得带上这几个头，预检也得能过。
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
}

function json(res, code, body) {
  const s = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
    'cache-control': 'no-store',
    ...CORS,
  })
  res.end(s)
}

function readBody(req, limit = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw === '' ? {} : JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * @param {object} deps
 * @param {number} deps.port
 * @param {string} deps.webRoot 静态文件目录
 * @param {(conv: string, text: string) => Promise<{ok:boolean, error?:string}>} deps.onUserMessage
 * @param {() => object} deps.snapshot 返回会话列表
 * @param {(conv: string, after: number) => Array<object>} deps.messagesAfter
 * @param {(msg: string) => void} deps.log
 */
export function startServer(deps) {
  const { port, webRoot, audioDir, uploadDir, memeDir, convList, onUserMessage, onUpload, onRecall, onBackup, onAvatarGet, onAvatarSet, snapshot, messagesAfter, archive, log } = deps

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? '/index.html' : pathname
    // 只允许 webRoot 下的文件，挡掉 ../
    const safe = rel.replace(/\.\./g, '').replace(/^\/+/, '')
    const file = join(webRoot, safe)
    if (!existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const ext = extname(file).toLowerCase()
    const type = MIME[ext] ?? 'application/octet-stream'
    try {
      const buf = readFileSync(file)
      res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store' })
      res.end(buf)
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`read failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const path = url.pathname

    try {
      // 预检：跨源 POST 会先来一发，不回就直接被浏览器掐掉
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return
      }

      if (path === '/api/health') {
        json(res, 200, { ok: true, at: Date.now() })
        return
      }

      if (path === '/api/state') {
        // ?slim=1：只回「消息流变了没」+ 锁 / 送达 / 情绪这几个轻字段，不带正文。
        // 前端每 1.6 秒问的是它；全量那份四个会话各 200 条，一百多 KB。
        if (url.searchParams.get('slim') === '1' && typeof deps.slim === 'function') {
          json(res, 200, deps.slim())
          return
        }
        json(res, 200, snapshot())
        return
      }

      // 全量归档：手机端首次进来把整份历史拖下去，之后按 seq 增量问。
      if (path === '/api/archive') {
        if (typeof archive !== 'function') {
          json(res, 501, { ok: false, error: '这个实例没接归档' })
          return
        }
        const after = Number(url.searchParams.get('after') ?? '0') || 0
        json(res, 200, archive(after))
        return
      }

      if (path === '/api/messages') {
        const conv = url.searchParams.get('conv') ?? 'group'
        const after = Number(url.searchParams.get('after') ?? '0') || 0
        json(res, 200, { conv, messages: messagesAfter(conv, after) })
        return
      }

      // 头像映射：手机端的推送服务和电脑上的网页共用这一份，
      // 不然通知里永远只能显示画出来的那个字
      if (path === '/api/avatars' && req.method === 'GET') {
        json(res, 200, typeof onAvatarGet === 'function' ? onAvatarGet() : {})
        return
      }
      if (path === '/api/avatars' && req.method === 'POST') {
        const body = await readBody(req)
        const who = typeof body.who === 'string' ? body.who : ''
        const name = typeof body.name === 'string' ? body.name : ''
        const out = typeof onAvatarSet === 'function' ? onAvatarSet(who, name) : { ok: false }
        json(res, out.ok ? 200 : 400, out)
        return
      }

      if (path === '/api/backup' && req.method === 'POST') {
        if (typeof onBackup !== 'function') {
          json(res, 501, { ok: false, error: '这个实例没接备份' })
          return
        }
        const out = await onBackup()
        json(res, out.ok ? 200 : 500, out)
        return
      }

      if (path === '/api/recall' && req.method === 'POST') {
        const body = await readBody(req)
        const seq = Number(body.seq)
        if (!Number.isFinite(seq) || seq <= 0) {
          json(res, 400, { ok: false, error: 'seq 不对' })
          return
        }
        const ok = typeof onRecall === 'function' ? onRecall(seq) : false
        json(res, ok ? 200 : 400, ok ? { ok: true } : { ok: false, error: '撤不了（只能撤自己发的）' })
        return
      }

      // 长轮询：挂住请求，等到有新消息或者超时。手机端前台服务靠这个收推送。
      if (path === '/api/poll') {
        const conv = url.searchParams.get('conv') ?? 'group'
        const after = Number(url.searchParams.get('after') ?? '0') || 0
        const wait = Math.min(30, Math.max(1, Number(url.searchParams.get('wait') ?? '25') || 25))
        const deadline = Date.now() + wait * 1000
        const tick = () => {
          if (res.writableEnded) return
          let fresh = []
          try {
            fresh = messagesAfter(conv, after)
          } catch {
            fresh = []
          }
          if (fresh.length > 0) {
            json(res, 200, { ok: true, conv, messages: fresh })
            return
          }
          if (Date.now() >= deadline) {
            json(res, 200, { ok: true, conv, messages: [] })
            return
          }
          setTimeout(tick, 700)
        }
        tick()
        return
      }

      // 长轮询（跨会话版）：手机端只关心"有没有人说话"，不关心在哪个会话里。
      // 只返回别人发的，自己发的不推。
      if (path === '/api/poll-all') {
        const after = Number(url.searchParams.get('after') ?? '0') || 0
        const wait = Math.min(30, Math.max(1, Number(url.searchParams.get('wait') ?? '25') || 25))
        const deadline = Date.now() + wait * 1000
        const tickAll = () => {
          if (res.writableEnded) return
          let fresh = []
          try {
            const convIds = Array.isArray(convList) && convList.length > 0
              ? convList
              : ['group']
            fresh = convIds.flatMap((c) => messagesAfter(c, after))
          } catch {
            fresh = []
          }
          const fromOthers = fresh.filter((m) => m.from !== 'user')
          if (fromOthers.length > 0) {
            json(res, 200, { ok: true, messages: fromOthers })
            return
          }
          if (Date.now() >= deadline) {
            json(res, 200, { ok: true, messages: [] })
            return
          }
          setTimeout(tickAll, 700)
        }
        tickAll()
        return
      }

      if (path === '/api/upload' && req.method === 'POST') {
        if (typeof onUpload !== 'function') {
          json(res, 501, { ok: false, error: '这个实例没接上传' })
          return
        }
        const body = await readBody(req, 16 * 1024 * 1024)
        const dataUrl = typeof body.data === 'string' ? body.data : ''
        const name = typeof body.name === 'string' ? body.name : ''
        if (!dataUrl.startsWith('data:')) {
          json(res, 400, { ok: false, error: '要传 data URL' })
          return
        }
        const out = await onUpload(dataUrl, name)
        json(res, out.ok ? 200 : 400, out)
        return
      }

      if (path === '/api/send' && req.method === 'POST') {
        const body = await readBody(req)
        const conv = typeof body.conv === 'string' ? body.conv : 'group'
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        const image = typeof body.image === 'string' ? body.image : ''
        const replyTo = Number(body.replyTo) || 0
        if (text === '' && image === '') {
          json(res, 400, { ok: false, error: '消息是空的' })
          return
        }
        const result = await onUserMessage(conv, text, image, replyTo)
        json(res, result.ok ? 200 : 500, result)
        return
      }

      // 语音文件：单独一个目录，带 range 支持（手机浏览器拖进度条要用）
      if (path.startsWith('/audio/')) {
        const name = decodeURIComponent(path.slice('/audio/'.length)).replace(/\.\./g, '')
        if (!audioDir || name === '' || name.includes('/')) {
          res.writeHead(404)
          res.end()
          return
        }
        const file = join(audioDir, name)
        if (!existsSync(file)) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('no such audio')
          return
        }
        const buf = readFileSync(file)
        const type = name.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg'
        const total = buf.length
        // 真的实现 Range（206），不是只回一个 accept-ranges 头。
        // 只声明不实现的话，手机浏览器拖进度条会拿到 200 全量，行为看运气。
        const range = typeof req.headers.range === 'string' ? req.headers.range.trim() : ''
        const m = /^bytes=(\d*)-(\d*)$/.exec(range)
        if (m !== null && (m[1] !== '' || m[2] !== '')) {
          let start = m[1] === '' ? total - Number(m[2]) : Number(m[1])
          let end = m[1] === '' ? total - 1 : m[2] === '' ? total - 1 : Number(m[2])
          if (!Number.isFinite(start) || start < 0) start = 0
          if (!Number.isFinite(end) || end >= total) end = total - 1
          if (start > end) {
            res.writeHead(416, { 'content-range': `bytes */${total}`, ...CORS })
            res.end()
            return
          }
          res.writeHead(206, {
            'content-type': type,
            'content-length': end - start + 1,
            'content-range': `bytes ${start}-${end}/${total}`,
            'accept-ranges': 'bytes',
            'cache-control': 'public, max-age=86400',
            ...CORS,
          })
          res.end(buf.subarray(start, end + 1))
          return
        }
        res.writeHead(200, {
          'content-type': type,
          'content-length': total,
          'accept-ranges': 'bytes',
          'cache-control': 'public, max-age=86400',
          ...CORS,
        })
        res.end(buf)
        return
      }

      // 图片文件
      if (path.startsWith('/uploads/')) {
        const name = decodeURIComponent(path.slice('/uploads/'.length)).replace(/\.\./g, '')
        if (!uploadDir || name === '' || name.includes('/')) {
          res.writeHead(404)
          res.end()
          return
        }
        const file = join(uploadDir, name)
        if (!existsSync(file)) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('no such image')
          return
        }
        const buf = readFileSync(file)
        const ext = extname(file).toLowerCase()
        const type = MIME[ext] || 'application/octet-stream'
        res.writeHead(200, {
          'content-type': type,
          'content-length': buf.length,
          'cache-control': 'public, max-age=86400',
          ...CORS,
        })
        res.end(buf)
        return
      }

      if (path.startsWith('/memes/')) {
        const rel = decodeURIComponent(path.slice('/memes/'.length)).replace(/\.\./g, '')
        const parts = rel.split('/').filter((x) => x !== '')
        if (!memeDir || parts.length !== 2) {
          res.writeHead(404)
          res.end()
          return
        }
        const file = join(memeDir, parts[0], parts[1])
        if (!existsSync(file)) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('no such meme')
          return
        }
        const buf = readFileSync(file)
        const type = MIME[extname(file).toLowerCase()] || 'image/jpeg'
        res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'public, max-age=604800', ...CORS })
        res.end(buf)
        return
      }

      if (path.startsWith('/api/')) {
        json(res, 404, { ok: false, error: '没有这个接口' })
        return
      }

      serveStatic(req, res, path)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`请求失败 ${path}：${msg}`)
      if (!res.headersSent) json(res, 500, { ok: false, error: msg })
      else res.end()
    }
  })

  // 绑 0.0.0.0：手机要通过组网 / 局域网 IP 连进来，只绑 127.0.0.1 连不上。
  // 暴露面靠组网工具自己控制（Tailscale 那类私有网段不是公网）。
  const host = deps.host || '0.0.0.0'
  server.listen(port, host, () => {
    log(`网页聊天已就绪 http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`)
    if (host === '0.0.0.0') log(`手机请用本机在组网里的地址访问：<本机在组网里的 IP>:${port}`)
  })

  server.on('error', (err) => {
    log(`HTTP 服务出错：${err instanceof Error ? err.message : String(err)}`)
  })

  return {
    close() {
      try {
        server.close()
      } catch {
        /* 关不掉就算了，进程退的时候一起走 */
      }
    },
  }
}
