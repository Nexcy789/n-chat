/**
 * dsh-cover — 把 D:\SeedVC 的翻唱链路接成 DSH 工具。
 *
 * 链路：曲库里的歌 + 音色 → kge.py cover（切段/分离/换音色/混音）→ mp3 → QQ 语音条
 *
 * 设计约束跟 dsh-qq-tts / dsh-qq-meme 一致：不 import 任何裸包名，
 * 工具定义手写成 registry 认的形状。
 *
 * 三个关键取舍：
 *   1. kge.py 是纯 CLI + JSON stdout，这里只做包装，不复制任何业务逻辑。
 *   2. 不让模型猜时间戳 —— 不给 start 就先跑 sections 把候选丢回去。
 *   3. 语音条有长度上限，超了就改发音频文件（详情见 maxVoiceSec）。
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'dsh-cover'
export const inject = ['tools']

const DEFAULTS = {
  // SeedVC 装在哪就填哪，这里只是最常见的默认位置
  pythonExe: 'D:/SeedVC/.venv/Scripts/python.exe',
  script: 'D:/SeedVC/kge.py',
  wholeScript: 'D:/SeedVC/kge_whole.py',
  cwd: 'D:/SeedVC',
  voicesDir: 'D:/SeedVC/voices',
  oneBotBaseUrl: 'http://127.0.0.1:3000',
  accessToken: '',
  userId: '',
  // SeedVC voices 里的音色模型名，填你自己的
  voice: 'default',
  // QQ 语音条超过这个秒数就改发文件。QQ 客户端自己录音的上限是 60 秒，
  // 留 2 秒余量防止转 SILK 后略微变长被拒。
  maxVoiceSec: 58,
  // 单次生成建议上限。摘要里写的是 10~60 秒最稳，超过 90 秒容易飘字。
  maxSec: 60,
  timeoutMs: 600000,
  wholeTimeoutMs: 900000,
  // 整首模式的播报文案。{count} 会被替换成段数。留空就不发。
  notifyStart: '',
  notifyMid: '',
  notifyEnd: '',
  // true = 只生成文件，不往 QQ 发
  dryRun: true,
}

/** 跑 kge.py，把 stdout 当 JSON 解析。永远 resolve，错误交给调用方判断。 */
function runKge(cfg, argv, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      cfg.pythonExe,
      [cfg.script, ...argv],
      {
        cwd: cfg.cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      },
      (error, stdout, stderr) => {
        const raw = String(stdout || '').trim()
        let json = null
        try {
          json = JSON.parse(raw)
        } catch {
          /* 非 JSON（崩溃/被信号杀）→ 让调用方看 raw */
        }
        resolve({
          json,
          raw,
          stderr: String(stderr || '').trim(),
          timedOut: !!(error && error.killed),
          error,
        })
      },
    )
  })
}

/**
 * 流式跑整首脚本。stdout 是 JSON Lines（一行一个事件），
 * 每收到一行就回调 —— 这样第 1 段跑完就能立刻发，不用等整首跑完。
 */
function runKgeStream(cfg, argv, onEvent, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cfg.pythonExe, [cfg.wholeScript, ...argv], {
      cwd: cfg.cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })

    let buf = ''
    let errTail = ''
    let doneEvent = null
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('{')) continue
        let ev
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.event === 'done') doneEvent = ev
        try {
          onEvent(ev)
        } catch {
          /* 回调里出错不该打断子进程读取 */
        }
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c) => {
      errTail = (errTail + c).slice(-4000)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, doneEvent, errTail, killed })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, doneEvent: null, errTail: String(e.message), killed: false })
    })
  })
}

function listVoices(cfg) {
  try {
    return readdirSync(cfg.voicesDir)
      .filter((f) => /\.wav$/i.test(f))
      .map((f) => f.replace(/\.wav$/i, ''))
  } catch {
    return []
  }
}

function fmtTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

async function oneBotCall(cfg, action, payload) {
  const url = String(cfg.oneBotBaseUrl).replace(/\/+$/, '') + '/' + action
  const headers = { 'Content-Type': 'application/json' }
  if (cfg.accessToken) headers.Authorization = 'Bearer ' + cfg.accessToken
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    })
  } catch (error) {
    throw new Error('连不上 OneBot（' + cfg.oneBotBaseUrl + '）：' + (error instanceof Error ? error.message : String(error)))
  }
  if (!res.ok) throw new Error('OneBot ' + action + ' HTTP ' + res.status)
  const data = await res.json().catch(() => null)
  const failed = data && (data.status === 'failed' || (typeof data.retcode === 'number' && data.retcode !== 0))
  if (failed) throw new Error('OneBot 失败：' + (data.wording || data.message || 'retcode=' + data.retcode))
  return data
}

/**
 * 把产物交给聊天界面。
 *
 * 原来这里是把音频推给 OneBot 的 send_private_msg 发成 QQ 语音条。
 * 换到自建界面之后，出口只剩「落盘 + 通知 webchat 插一条消息」——
 * 文件本来就是本地生成的，不需要再经一遍 QQ 服务器。
 */
function emitAudio(cfg, absPath, meta = {}) {
  const fn = globalThis.__dshMediaEmit
  if (typeof fn === 'function') {
    try {
      return fn({ kind: 'audio', file: absPath, ...meta })
    } catch {
      /* 界面那边出问题不该影响生成结果 */
    }
  }
  return null
}

/** 发音频。asVoice=true 走 record（语音条），否则走 file（音频文件）。 */
async function sendAudio(cfg, absPath, asVoice) {
  const type = asVoice ? 'record' : 'file'
  const segment = asVoice
    ? { type, data: { file: pathToFileURL(absPath).href } }
    : { type, data: { file: pathToFileURL(absPath).href, name: basename(absPath) } }

  const send = (msg) =>
    oneBotCall(cfg, 'send_private_msg', { user_id: Number(cfg.userId), message: [msg] })

  try {
    const data = await send(segment)
    return { via: 'path', messageId: data?.data?.message_id ?? null }
  } catch (pathError) {
    // 对端 stat 不到本地文件时退 base64（体积 1.33 倍，大文件不试）
    let bytes = 0
    try {
      bytes = statSync(absPath).size
    } catch {
      /* ignore */
    }
    if (bytes > 4 * 1024 * 1024) throw pathError
    try {
      const b64File = 'base64://' + (await import('node:fs')).readFileSync(absPath).toString('base64')
      const seg = asVoice
        ? { type, data: { file: b64File } }
        : { type, data: { file: b64File, name: basename(absPath) } }
      const data = await send(seg)
      return { via: 'base64', messageId: data?.data?.message_id ?? null }
    } catch {
      throw pathError
    }
  }
}

/** 发一句话（纯文本消息）。 */
async function sendText(cfg, text) {
  const body = String(text || '').trim()
  if (!body) return null
  return oneBotCall(cfg, 'send_private_msg', {
    user_id: Number(cfg.userId),
    message: [{ type: 'text', data: { text: body } }],
  })
}

function fmtSections(song, sections, duration) {
  const lines = sections.map((s) => {
    const tag = s.preview ? '「' + String(s.preview).slice(0, 24) + '」' : ''
    return '  #' + s.id + '  ' + fmtTime(s.start) + '–' + fmtTime(s.end) + '（' + Math.round(s.duration) + 's）' + tag
  })
  const noLrc = sections.every((s) => !s.preview)
  return (
    '《' + song + '》总长 ' + fmtTime(duration) + '，' + sections.length + ' 个候选段：\n' +
    lines.join('\n') +
    (noLrc ? '\n（这首没有歌词时间轴，是按人声能量切的，靠位置判断：一般 #2–#4 是主歌进副歌）' : '')
  )
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  let busy = false

  const libDef = {
    name: 'cover_lib',
    description:
      '查翻唱曲库：有哪些歌（带时长）、有哪些音色可用。想让她翻唱之前先看这个，别自己猜歌名。' +
      '同名歌有歧义时（比如"雨爱"匹配到"雨爱(司凤)"），这里会给完整文件名，下次直接传完整文件名。',
    parameters: {
      type: 'object',
      properties: {
        song: { type: 'string', description: '可选。按歌名模糊筛一下，不填就返回全部。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        required: ['message'],
        additionalProperties: true,
      },
      render(_args, value) {
        return [{ type: 'text', text: String((value && value.message) || '') }]
      },
    },
    timeoutMs: 120000,
    async execute(args) {
      const input = args || {}
      const r = await runKge(cfg, ['list'], 60000)
      if (!r.json || r.json.ok !== true) {
        return {
          ok: false,
          message:
            '曲库读不出来：' +
            (r.timedOut ? 'kge.py 超时' : r.json?.error || r.stderr || r.raw.slice(0, 200) || '没有输出'),
        }
      }
      let songs = r.json.songs || []
      const q = String(input.song || '').trim().toLowerCase()
      if (q) songs = songs.filter((s) => String(s.title).toLowerCase().includes(q) || String(s.file).toLowerCase().includes(q))

      const voices = listVoices(cfg)
      const body = songs.length
        ? songs.map((s) => '- ' + s.file + '（' + fmtTime(s.duration) + '）' + (s.lrc ? ' [有歌词]' : '')).join('\n')
        : '（没匹配到）'

      return {
        ok: true,
        message:
          '曲库共 ' + (r.json.songs || []).length + ' 首' + (q ? '，筛出 ' + songs.length + ' 首' : '') + '：\n' +
          body +
          '\n\n可用音色：' + (voices.length ? voices.join('、') : '（voices 目录是空的）'),
        songs,
        voices,
      }
    },
  }

  const singDef = {
    name: 'cover_sing',
    description:
      '用曲库里某首歌的某一段（或整首），换成指定音色重唱，混好伴奏出成品，发成 QQ 语音条。' +
      '只换嗓子：旋律、歌词、节奏全部来自原唱，它不会改编曲也不会写新词。' +
      '**调用前先跟用户说一句「等我一下」再调** —— 这活儿要几十秒到一分多钟，别憋着不出声然后突然甩音频过来。' +
      '**第一次调用不要填 start**：会让你选段，返回候选列表；挑好编号后用 section 再调一次。' +
      '整首就用 whole: true，会自动切成几段边跑边发。不要自己循环调这个工具。' +
      '单段建议 10~60 秒，太长会飘字。同名歌有歧义时传完整文件名。',
    parameters: {
      type: 'object',
      properties: {
        song: { type: 'string', description: '歌名或完整文件名。' },
        section: { type: 'number', description: '候选段编号（cover_sing 第一次返回的那个 #N）。和 start 二选一。' },
        start: { type: 'number', description: '起始秒数。填了就不查候选段，直接跑。' },
        end: { type: 'number', description: '结束秒数。不填默认 start+30；0 表示到结尾。' },
        voice: { type: 'string', description: '音色名（voices 目录下的 wav 文件名，不带扩展名）。默认用插件配置里的。' },
        whole: {
          type: 'boolean',
          description:
            'true = 整首。自动按静音切成 4~6 段，模型只加载一次，每跑完一段就发一条语音条（边跑边发，不用等全部跑完）。' +
            '要整首唱的时候用它，别自己循环调 cover_sing。',
        },
        preview: { type: 'boolean', description: 'true = 只生成不发出去，返回文件路径。' },
        send: { type: 'boolean', description: 'false = 生成但不发 QQ。默认发。' },
      },
      required: ['song'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        required: ['message'],
        additionalProperties: true,
      },
      render(_args, value) {
        return [{ type: 'text', text: String((value && value.message) || '') }]
      },
    },
    // 100 秒片段实测 42 秒，整首 5 段约 90 秒，给足余量
    timeoutMs: 900000,
    async execute(args) {
      const input = args || {}
      const song = String(input.song || '').trim()
      if (!song) return { ok: false, message: '要指定歌名。先用 cover_lib 看看曲库里有什么。' }

      const voice = String(input.voice || cfg.voice || 'role1').trim()

      // ── ⓿ 整首模式：分段跑、边跑边发 ───────────────────────────────
      if (input.whole === true) {
        if (busy) return { ok: false, message: '上一首还在跑（换音色很吃显存），等它出来再点。' }
        busy = true
        try {
          const wantsSend = input.send !== false && input.preview !== true && cfg.dryRun !== true
          const argv = ['--song', song, '--voice', voice, '--target', String(cfg.maxVoiceSec)]
          const sent = []
          const failures = []
          let count = 0
          let startEvent = null
          let midSent = false

          // 事件回调是同步的，发送是异步的 —— 串成一条链，保证语音条顺序
          let chain = Promise.resolve()
          const enqueue = (fn) => {
            chain = chain.then(fn).catch((e) => failures.push(String(e?.message || e)))
          }

          // 预告必须在起进程之前发：切分+分离要 8 秒，等 start 事件再发就晚了
          // 开场那句播报删掉了：聊天界面能看到进度，不用报幕

          const stream = await runKgeStream(
            cfg,
            argv,
            (ev) => {
              if (ev.event === 'start') {
                count = Number(ev.count) || 0
                startEvent = ev
              } else if (ev.event === 'segment') {
                if (!wantsSend || !cfg.userId) return
                enqueue(async () => {
                  const asVoice = Number(ev.duration) <= Number(cfg.maxVoiceSec)
                  const r = emitAudio(cfg, ev.mp3, { caption: ev.title || '' }) !== null ? { via: 'emit' } : null
                  sent.push({ index: ev.index, duration: ev.duration, asVoice, via: r.via })
                  if (!midSent && cfg.notifyMid && count >= 4 && ev.index === Math.ceil(count / 2)) {
                    midSent = true
                    /* 中途进度也不报了 */
                  }
                })
              } else if (ev.event === 'error') {
                failures.push(ev.error + (ev.detail ? '：' + ev.detail : ''))
              }
            },
            cfg.wholeTimeoutMs,
          )

          await chain

          if (!startEvent) {
            const why =
              failures[0] ||
              (stream.killed ? '超过 ' + Math.round(cfg.wholeTimeoutMs / 1000) + ' 秒被打断' : '') ||
              stream.errTail.slice(-300) ||
              '没拿到切分结果'
            return { ok: false, message: '整首没跑起来：' + why }
          }

          const head =
            '《' + startEvent.song + '》整首 ' + fmtTime(startEvent.total) +
            '，切成 ' + count + ' 段，音色 ' + startEvent.voice

          if (!wantsSend) {
            const files = stream.doneEvent?.mp3s || []
            return {
              ok: true,
              message: head + '\n(只生成没发) ' + files.length + ' 个文件：\n' + files.join('\n'),
              files,
            }
          }
          if (!cfg.userId) return { ok: true, message: head + '\n但插件没配 userId，发不出去。' }

          if (cfg.notifyEnd) {
            /* 结束语也不发了，音频落地就能看到 */
          }

          const took = stream.doneEvent?.elapsed
          return {
            ok: sent.length > 0,
            message:
              head +
              '\n已发 ' + sent.length + '/' + count + ' 条' +
              (sent.some((s) => !s.asVoice) ? '（超长段改发了音频文件）' : '') +
              (took ? '，总耗时 ' + Math.round(took) + ' 秒' : '') +
              (failures.length ? '\n有 ' + failures.length + ' 个问题：' + failures.slice(0, 2).join(' / ') : ''),
            count,
            sent,
          }
        } finally {
          busy = false
        }
      }

      // ── ① 没给位置 → 先拿候选段丢回去 ───────────────────────────────
      const noStart = input.start === undefined || input.start === null
      const noSection = input.section === undefined || input.section === null
      if (noStart && noSection) {
        const r = await runKge(cfg, ['sections', '--song', song], 180000)
        if (!r.json || r.json.ok !== true) return { ok: false, message: describeFailure(r, 'sections') }
        if (!r.json.sections || !r.json.sections.length) {
          return { ok: false, message: '《' + r.json.song + '》没切出可用段落。' }
        }
        return {
          ok: true,
          need_section: true,
          message: fmtSections(r.json.song, r.json.sections, r.json.duration) + '\n\n挑一个编号，用 section 参数再调一次。',
          song: r.json.song,
          sections: r.json.sections,
        }
      }

      if (busy) return { ok: false, message: '上一首还在跑（换音色很吃显存），等它出来再点。' }

      // ── ② 定位区间 ────────────────────────────────────────────────
      let start = Number(input.start)
      let end = input.end === undefined || input.end === null ? undefined : Number(input.end)

      if (input.section !== undefined && input.section !== null) {
        const r = await runKge(cfg, ['sections', '--song', song], 180000)
        if (!r.json || r.json.ok !== true) return { ok: false, message: describeFailure(r, 'sections') }
        const hit = (r.json.sections || []).find((s) => Number(s.id) === Number(input.section))
        if (!hit) {
          return {
            ok: false,
            message: '没有 #' + input.section + ' 这一段。' + fmtSections(r.json.song, r.json.sections, r.json.duration),
          }
        }
        start = hit.start
        end = hit.end
      }

      if (!Number.isFinite(start)) return { ok: false, message: 'start 不是数字。' }
      if (end === undefined) end = start + 30
      if (!Number.isFinite(end) || end <= start) end = start + 30

      // ── ③ 跑翻唱 ──────────────────────────────────────────────────
      busy = true
      let r
      try {
        r = await runKge(
          cfg,
          ['cover', '--song', song, '--voice', voice, '--start', String(start), '--end', String(end)],
          cfg.timeoutMs,
        )
      } finally {
        busy = false
      }

      if (!r.json || r.json.ok !== true) return { ok: false, message: describeFailure(r, 'cover') }

      const j = r.json
      const dur = Number(j.duration) || Math.max(0, end - start)
      const mp3 = String(j.output_mp3 || '')
      const wav = String(j.output_wav || '')
      const elapsed = Number(j.elapsed_seconds) || 0

      if (!mp3 || !existsSync(mp3)) {
        return { ok: false, message: '跑完了但没找到成品文件：' + (mp3 || wav || '(空)') }
      }

      const head = '《' + j.song + '》' + fmtTime(j.start) + '–' + fmtTime(j.end) + '，' + fmtTime(dur) + '，音色 ' + j.voice + '，用时 ' + Math.round(elapsed) + ' 秒'

      const wantsSend = input.send !== false && input.preview !== true && cfg.dryRun !== true
      if (!wantsSend) {
        return { ok: true, message: '(只生成没发) ' + head + '\n文件：' + mp3, file: mp3, duration: dur }
      }
      if (!cfg.userId) return { ok: true, message: head + '\n成品在 ' + mp3 + '\n但插件没配 userId，发不出去。', file: mp3 }

      // ── ④ 发出去 ──────────────────────────────────────────────────
      // 超过 maxVoiceSec 就不硬塞语音条：QQ 客户端自己录音上限 60 秒，超了会被
      // 拒绝或者播放异常。改发普通音频文件，至少能听。
      const asVoice = dur <= Number(cfg.maxVoiceSec)
      try {
        const sent = emitAudio(cfg, mp3, { caption: args.title || '' }) !== null ? { via: 'emit' } : null
        return {
          ok: true,
          message:
            head + '\n' +
            (asVoice ? '已发语音条' : '超过 ' + cfg.maxVoiceSec + ' 秒，改发音频文件了') +
            '（via ' + sent.via + '）',
          file: mp3,
          duration: dur,
          asVoice,
          messageId: sent.messageId,
        }
      } catch (error) {
        return {
          ok: false,
          message: head + '\n成品生成了，但发送失败：' + (error instanceof Error ? error.message : String(error)) + '\n文件：' + mp3,
          file: mp3,
        }
      }
    },
  }

  function describeFailure(r, stage) {
    if (r.timedOut) return 'kge.py 跑了超过 ' + Math.round((cfg.timeoutMs || 0) / 1000) + ' 秒被打断（' + stage + '）。机器是不是在忙别的？'
    const j = r.json
    if (!j) {
      const tail = (r.stderr || r.raw || '').slice(-300)
      return 'kge.py 没吐出 JSON（' + stage + '）。原始输出末尾：' + (tail || '(空)')
    }
    switch (j.error) {
      case 'song_not_found': {
        const near = Array.isArray(j.nearest) ? j.nearest.filter(Boolean).slice(0, 5) : []
        return '曲库里没有这首歌。' + (near.length ? '最接近的是：' + near.join('、') : '先用 cover_lib 看看有什么。')
      }
      case 'voice_not_found': {
        const av = Array.isArray(j.available) ? j.available : []
        return '没有这个音色。可用的：' + (av.length ? av.join('、') : '（voices 目录是空的）')
      }
      case 'bad_range':
        return '区间不对：这首歌总长 ' + fmtTime(j.duration) + '。把 end 收在总长以内再试。'
      default:
        return 'kge.py 报错（' + (j.error || stage) + '）：' + String(j.detail || r.stderr || '').slice(0, 300)
    }
  }

  ctx.tools.register(libDef)
  ctx.tools.register(singDef)
  console.log('[dsh-cover] cover_lib / cover_sing 已注册（kge=' + cfg.script + '，语音条上限 ' + cfg.maxVoiceSec + 's）')
}
