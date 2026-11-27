/**
 * dsh-voice —— 用本机 Breeze TTS 把文字合成语音，产出音频文件给网页播放。
 *
 * 和 dsh-qq-tts 的关系：合成那一段是同一套（同一个 Breeze 接口、同一个音色），
 * 区别只在出口——那边是把音频推给 QQ 的 OneBot 接口发成语音条，
 * 这边是落在本地目录、返回一个 URL，网页自己拿 <audio> 放。
 *
 * 没有 OneBot、没有号、没有发送队列。
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

export const name = 'dsh-voice'

/** 项目根目录。相对路径按它算，也可以直接用绝对路径。 */
const ROOT = String(process.env.NCHAT_HOME ?? '').trim() || process.cwd()

const DEFAULTS = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:8137',
  // Breeze voices 目录里的模型名，填你自己的
  voice: 'default',
  format: 'mp3',
  outDir: join(ROOT, 'data', 'webchat', 'audio'),
  timeoutMs: 90000,
  tailPadSec: 0.4,
  // 写 'ffmpeg' 就走 PATH；要指定路径就写绝对路径
  ffmpegPath: 'ffmpeg',
  keepFiles: 300,
  cfgScale: 2.0,
}

/**
 * ffmpeg 能不能用。绝对路径看文件在不在；
 * 光写命令名（'ffmpeg'）就当它在 PATH 里，交给 execFileSync 去找。
 */
function ffmpegUsable(p) {
  if (!p) return false
  if (p.includes('/') || p.includes('\\')) return existsSync(p)
  return true
}

function normalize(raw) {
  const cfg = { ...DEFAULTS, ...(raw ?? {}) }
  cfg.enabled = cfg.enabled !== false
  cfg.baseUrl = String(cfg.baseUrl || DEFAULTS.baseUrl)
  cfg.outDir = String(cfg.outDir || DEFAULTS.outDir)
  cfg.format = String(cfg.format || 'mp3').toLowerCase() === 'wav' ? 'wav' : 'mp3'
  cfg.keepFiles = Number(cfg.keepFiles) || DEFAULTS.keepFiles
  return cfg
}

function prune(dir, keep) {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('v-'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const old of files.slice(keep)) {
      try {
        unlinkSync(join(dir, old.f))
      } catch {
        /* 删不掉就算了 */
      }
    }
  } catch {
    /* 目录还没有 */
  }
}

/**
 * 合成一段语音，返回 { file, name, bytes }。name 是给前端用的文件名。
 * @param {object} cfg
 * @param {string} text
 */
export async function synthesize(cfg, text, voice) {
  const url = String(cfg.baseUrl).replace(/\/+$/, '') + '/v1/audio/speech'

  // 按 Breeze 的说明走 multipart：用已存音色要给 voice_id，**不要给 instruction**
  // （给了会覆盖音色描述）。JSON 那条路也能返回音频，但 voice 参数不保证生效，
  // 听起来会变成默认嗓 —— 别图省事。
  const form = new FormData()
  form.append('text', text)
  const vid = voice || cfg.voice
  if (vid) form.append('voice_id', vid)
  // 1.0 是说明里的推荐值；2 以上会变刺而且算力翻倍
  form.append('cfg_scale', String(Number(cfg.cfgScale) || 1.0))

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(cfg.timeoutMs),
    })
  } catch (error) {
    throw new Error(`连不上 Breeze（${cfg.baseUrl}）：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.json())?.error?.message || ''
    } catch {
      /* 不是 JSON */
    }
    throw new Error(`Breeze 返回 HTTP ${res.status}${detail ? '：' + detail : ''}`)
  }

  const raw = Buffer.from(await res.arrayBuffer())
  if (raw.length < 1024) throw new Error(`音频太小（${raw.length} 字节），合成大概失败了`)

  if (!existsSync(cfg.outDir)) mkdirSync(cfg.outDir, { recursive: true })
  const fileName = `v-${Date.now()}.${cfg.format}`
  const file = join(cfg.outDir, fileName)

  // Breeze 吐的是 24 kHz 单声道裸 PCM，得套个容器才放得出来
  const ffmpeg = cfg.ffmpegPath
  if (!ffmpegUsable(ffmpeg)) throw new Error(`找不到 ffmpeg：${ffmpeg}`)
  try {
    execFileSync(ffmpeg, [
      '-y', '-v', 'error',
      '-f', 's16le', '-ar', '24000', '-ac', '1',
      '-i', 'pipe:0',
      '-c:a', 'libmp3lame', '-b:a', '64k',
      file,
    ], { input: raw, timeout: 30000 })
  } catch (error) {
    throw new Error(`PCM 转码失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!existsSync(file) || statSync(file).size < 512) throw new Error('转码后没有产出有效音频')

  // Breeze 说完最后一个字立刻收尾，听起来像被掐断。尾部补一点点静音。
  const padSec = Number(cfg.tailPadSec)
  if (Number.isFinite(padSec) && padSec > 0 && ffmpegUsable(cfg.ffmpegPath)) {
    const padded = `${file}.pad.${cfg.format}`
    try {
      execFileSync(cfg.ffmpegPath, [
        '-y', '-v', 'error', '-i', file,
        '-af', `apad=pad_dur=${padSec}`,
        '-c:a', 'libmp3lame', '-b:a', '64k',
        padded,
      ], { timeout: 20000 })
      if (existsSync(padded) && statSync(padded).size > 1024) renameSync(padded, file)
      else {
        try {
          unlinkSync(padded)
        } catch {
          /* 无所谓 */
        }
      }
    } catch {
      try {
        if (existsSync(padded)) unlinkSync(padded)
      } catch {
        /* 无所谓 */
      }
    }
  }

  prune(cfg.outDir, cfg.keepFiles)
  return { file, name: fileName, bytes: statSync(file).size }
}

export function apply(ctx, rawConfig) {
  const cfg = normalize(rawConfig)
  if (!cfg.enabled) return

  if (!existsSync(cfg.outDir)) {
    try {
      mkdirSync(cfg.outDir, { recursive: true })
    } catch {
      /* 建不了后面会报 */
    }
  }

  // 暴露给同进程里的别的插件。cordis 的 ctx.set 要求先 provide 声明一个服务名，
  // 这里只是个函数句柄，不值得为它写声明 —— 挂全局更省事，同进程可见。
  const voiceOf = cfg.voices && typeof cfg.voices === 'object' ? cfg.voices : {}

  /* Breeze 不接并发：三条消息同时来会直接回 409。
     串成一条链，一个说完再说下一个。失败了不阻塞后面的。 */
  let chain = Promise.resolve()
  function enqueue(text, voice) {
    const job = chain.then(
      () => synthesize(cfg, text, voice),
      () => synthesize(cfg, text, voice),
    )
    // 链尾吞掉异常，否则一次失败会让后面所有任务都跟着 reject
    chain = job.then(
      () => undefined,
      () => undefined,
    )
    return job
  }

  globalThis.__dshVoiceSynth = (text, roleId) =>
    enqueue(text, roleId ? voiceOf[roleId] || cfg.voice : cfg.voice)

  console.log(`[dsh-voice] 就绪：Breeze ${cfg.baseUrl}，音色 ${cfg.voice || '自动'}，输出 ${cfg.outDir}`)
}

export default { name, apply }
