/**
 * dsh-bili —— 给角色一个「看 B 站视频」的工具。
 *
 * 两个工具：
 *   bili_video   给链接 / BV 号，返回标题、UP、时长、播放、简介、字幕正文
 *   bili_frames  从故事板裁帧，产物落 doubao-images/，聊天界面会自动把它当图发出去
 *
 * 只用 B 站公开接口，不登录也能跑。配了 Cookie 能拿到更多（字幕、更高清的画面）。
 * 没有字幕轨的时候走本地 faster-whisper 转写，那个需要自己装。
 *
 * 零裸包名依赖，工具定义手写成 registry 认的形状。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-bili'
export const inject = ['tools']

const DEFAULTS = {
  // 登录凭证（可选）。留空 = 只用公开接口，标题/UP/时长/画面都能取，字幕靠本地 ASR。
  // 想填就指向一个 JSON，里面是 {"SESSDATA": "..."} 这样的 Cookie 键值对。
  credentialFile: '',
  maxChars: 4000,
  subtitleMaxChars: 6000,
  timeoutMs: 20000,
  // 本地转写：字幕接口拿不到东西时，下音频用 faster-whisper 自己转。
  // B 站官方字幕接口（x/player/v2 的 subtitle_url）会把别的视频的字幕挂过来，
  // 时长校验挡不住（撞上时长接近的就漏了）。既然本地转写可靠，就别再拉它的了。
  // 想开回来改 true 就行，代码还在。
  biliSubtitle: false,
  asrEnabled: true,
  // 装了 faster-whisper 的那个 python。写 'python' 就走 PATH；
  // 用独立 venv 的话写它的绝对路径（推荐，faster-whisper 对 av 版本挑剔）
  asrPython: 'python',
  asrModel: 'small',
  // 模型缓存目录。留空用 HuggingFace 默认的 ~/.cache/huggingface
  asrHfCache: '',
  asrTimeoutMs: 240000,
}

/** 解释器能不能用：带路径分隔符就看文件在不在，光写命令名就当它在 PATH 里。 */
function pythonUsable(p) {
  if (!p) return false
  if (p.includes('/') || p.includes('\\')) return existsSync(p)
  return true
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

function readCookie(file) {
  try {
    if (!existsSync(file)) return ''
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const pick = (k) => {
      const hit = Object.keys(raw || {}).find((x) => x.toLowerCase() === k.toLowerCase())
      return hit ? String(raw[hit] || '') : ''
    }
    const parts = []
    for (const k of ['SESSDATA', 'bili_jct', 'DedeUserID']) {
      const v = pick(k)
      if (v) parts.push(k + '=' + v)
    }
    return parts.join('; ')
  } catch {
    return ''
  }
}

async function fetchBuf(url, cookie, timeoutMs) {
  const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
  if (cookie) headers.Cookie = cookie
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error('图床 HTTP ' + res.status)
  return Buffer.from(await res.arrayBuffer())
}

async function getJson(url, cookie, timeoutMs) {
  const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
  if (cookie) headers.Cookie = cookie
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error('B站接口 HTTP ' + res.status)
  return res.json()
}

/** 从任意文本里抠出 bvid / aid；短链先跟一次跳转。 */
async function resolveTarget(input, timeoutMs) {
  const text = String(input || '').trim()
  const pageOf = (s) => {
    const m = String(s || '').match(/[?&]p=(\d+)/)
    return m ? Number(m[1]) : 0
  }
  const bv = text.match(/BV[0-9A-Za-z]{10}/)
  if (bv) return { bvid: bv[0], p: pageOf(text) }
  const av = text.match(/av(\d+)/i)
  if (av) return { aid: Number(av[1]), p: pageOf(text) }

  if (/b23\.tv|bili2233\.cn/i.test(text)) {
    const url = text.match(/https?:\/\/[^\s]+/)?.[0]
    if (url) {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const final = res.url || ''
      const hit = final.match(/BV[0-9A-Za-z]{10}/)
      if (hit) return { bvid: hit[0], p: pageOf(final) }
      const a = final.match(/av(\d+)/i)
      if (a) return { aid: Number(a[1]), p: pageOf(final) }
      throw new Error('短链跳转后没找到 BV 号（跳到的是 ' + final.slice(0, 60) + '）')
    }
  }
  return null
}

function fmtDuration(sec) {
  const s = Number(sec) || 0
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(r).padStart(2, '0')
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** 这个插件自己的目录（transcribe.py 就在旁边）。 */
const HERE = (() => {
  try { return dirname(fileURLToPath(import.meta.url)) } catch { return '' }
})()

/**
 * 本地转写兜底：从 B 站拿音频流，落成临时文件，交给 faster-whisper。
 * 只在字幕接口拿不到可用内容时调用 —— 慢（1 分钟音频约 10~20 秒），但内容必然对。
 * @returns {Promise<{text:string,label:string}|null>}
 */
async function transcribeAudio(bvid, cid, cookie, cfg) {
  if (!cfg.asrEnabled) return null
  const script = join(HERE, 'transcribe.py')
  if (!HERE || !existsSync(script) || !pythonUsable(cfg.asrPython)) return null

  let tmp = ''
  try {
    const play = await getJson(
      'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) +
        '&cid=' + encodeURIComponent(cid) + '&fnval=16&fourk=1',
      cookie,
      cfg.timeoutMs,
    )
    const audio = play?.data?.dash?.audio?.[0]
    const url = audio?.baseUrl || audio?.baseUrl64 || (audio?.backupUrl || [])[0] || ''
    if (!url) return null

    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', ...(cookie ? { Cookie: cookie } : {}) },
      signal: AbortSignal.timeout(cfg.timeoutMs),
    })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 4096) return null
    tmp = join(tmpdir(), 'bili-asr-' + Date.now() + '.m4a')
    writeFileSync(tmp, buf)

    const env = {
      ...process.env,
      HF_HUB_DISABLE_XET: '1',
      // 国内直连 huggingface.co 经常卡住，默认走镜像；有代理的话自己覆盖
      HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
      ASR_MODEL: cfg.asrModel,
      // Windows 下不管宿主有没有继承，都钉死 UTF-8，否则中文输出会变乱码
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    }
    // 只在真的填了缓存目录时才覆盖，否则交给 HuggingFace 用默认位置
    if (cfg.asrHfCache) env.HF_HOME = cfg.asrHfCache

    const out = execFileSync(cfg.asrPython, [script, tmp, cfg.asrModel], {
      timeout: cfg.asrTimeoutMs,
      env,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }).toString().trim()

    const last = out.split('\n').filter((l) => l.trim().startsWith('{')).pop() || ''
    let parsed
    try { parsed = JSON.parse(last) } catch { return null }
    if (!parsed || parsed.ok !== true) {
      if (parsed && parsed.error) console.log('[dsh-bili] 本地转写失败：' + String(parsed.error).slice(0, 160))
      return null
    }
    const text = String(parsed.text || '').trim()
    if (text === '') return { text: '', label: 'AI 本地转写·没有识别到人声', empty: true }
    return { text, label: 'AI 本地转写（faster-whisper ' + cfg.asrModel + '·' + parsed.segments + '段）' }
  } catch (err) {
    console.log('[dsh-bili] 本地转写异常：' + (err instanceof Error ? err.message : String(err)).slice(0, 160))
    return null
  } finally {
    if (tmp) { try { unlinkSync(tmp) } catch { /* 删不掉算了 */ } }
  }
}

async function fetchSubtitle(bvid, cid, cookie, cfg, durationSec) {
  // 默认关。B 站会把别的视频的字幕挂到这个视频的 subtitle_url 上，
  // 2026-11-13 加过"时间轴不超过时长"的校验，2026-11-26 又撞了一次 ——
  // 撞上时长接近的就漏过去，看起来就是"字幕串到别的视频"。
  // 本地转写慢十几秒，但内容一定是这条视频的音频。
  if (cfg.biliSubtitle !== true) return null
  const durationOf = () => Number(durationSec) || 0
  try {
    const data = await getJson(
      'https://api.bilibili.com/x/player/v2?bvid=' + encodeURIComponent(bvid) + '&cid=' + encodeURIComponent(cid),
      cookie,
      cfg.timeoutMs,
    )
    const list = data?.data?.subtitle?.subtitles
    if (!Array.isArray(list) || list.length === 0) return null

    /* 2026-11-13：这个视频有两套字幕 —— UP 上传的 BGM 歌词（zh-CN）和 AI 语音识别（ai-zh）。
       以前取「第一个 zh 开头」的，列表顺序一变就抓到歌词，看起来像"字幕串到别的视频"了。
       现在明确优先 ai-zh：AI 轨是按音轨实时识别的，内容必然是这个视频里说的话。 */
    const isAi = (x) => /^ai-?zh/i.test(String(x.lan || ''))
    const isZh = (x) => /^zh/i.test(String(x.lan || ''))

    /* 2026-11-13：实测撞见更狠的一种错 —— 标题和 BV 都对，字幕内容却是另一条视频的
       （BV1sXjn6LEag《找手机》，拿到的是"小齐…爷爷…"那段的字幕）。B 站把 subtitle_url
       挂错的情况确实存在，光看内容分辨不出来。
       唯一可靠的客观依据是**时间轴**：字幕最后一句的结束时间不可能超过视频时长。
       所以每一轨都验一遍，超了就换下一轨，全超就当没字幕。 */
    const dur = Number(durationOf()) || 0
    const ordered = [...list.filter(isAi), ...list.filter(isZh), ...list.filter((x) => !isAi(x) && !isZh(x))]
    const seen = new Set()
    for (const cand of ordered) {
      const key = String(cand.subtitle_url || '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      let url = key
      if (url.startsWith('//')) url = 'https:' + url
      let items
      try {
        const body = await getJson(url, '', cfg.timeoutMs)
        items = body?.body
      } catch { continue }
      if (!Array.isArray(items) || items.length === 0) continue
      const lastTo = items.reduce((m, x) => Math.max(m, Number(x.to) || 0), 0)
      if (dur > 0 && lastTo > dur + 8) {
        console.log('[dsh-bili] 字幕轨对不上时长，丢弃：轨道到 ' + Math.round(lastTo) + 's，视频只有 ' + Math.round(dur) + 's（lan=' + cand.lan + '）')
        continue
      }
      const rows = items.map((x) => String(x.content || '').trim()).filter(Boolean)
      /* 2026-11-13：实测有的视频整轨 AI 字幕都是「♪ 音乐 ♪」（就是没说话、只有 BGM）。
         把 14 行"音乐"塞给她，她会以为这就是视频内容。判定为「无对白」直接说清楚。 */
      const uniq = [...new Set(rows.map((t) => t.replace(/[♪\s]/g, '')).filter(Boolean))]
      if (rows.length >= 3 && uniq.length <= 1 && /音乐|music|\[.*\]/i.test(uniq[0] || '')) {
        return { none: true, label: '整轨只有音乐，没有对白' }
      }
      const text = rows.join('\n')
      const label = (isAi(cand) ? 'AI 语音识别' : 'UP 上传') + (cand.lan_doc ? '·' + cand.lan_doc : '') +
        '　' + Math.round(lastTo) + 's/' + items.length + '段'
      return {
        text: text.length > cfg.subtitleMaxChars ? text.slice(0, cfg.subtitleMaxChars) + '\n…（后面太长，截了）' : text,
        label,
      }
    }
    return null
  } catch {
    return null
  }
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }

  /**
   * 照 webchat 的 makeImageBlock 手写一遍：自己把图写进附件目录，自己拼 attachment。
   *
   * 不走宿主的 attachments.saveImages() —— 那条路 2026-11-27 实测会让 DeepSeek
   * 直接 transport failed。发图那条链路用的就是这个手写版，一直是通的，照抄。
   *
   * 附件目录：DSH_HOME/attachments/v1/objects/<sha前两位>/<完整 sha256>
   * （图片走 objects，文件才走 file-objects，两个不是一回事）
   */
  function makeImageAttachment(filePath) {
    try {
      const buf = readFileSync(filePath)
      if (buf.length === 0) return null
      // PNG 的宽高在 IHDR 里，第 16/20 字节，不用 ffprobe
      let width = 0
      let height = 0
      if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {
        width = buf.readUInt32BE(16)
        height = buf.readUInt32BE(20)
      }
      if (!width || !height) return null
      const home = String(process.env.DSH_HOME ?? '').trim()
      if (home === '') return null
      const sha = createHash('sha256').update(buf).digest('hex')
      const dir = join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2))
      mkdirSync(dir, { recursive: true })
      const dest = join(dir, sha)
      if (!existsSync(dest)) writeFileSync(dest, buf)
      return {
        type: 'image',
        attachment: {
          attachmentId: 'sha256:' + sha,
          mediaType: 'image/png',
          width,
          height,
          bytes: buf.length,
          name: sha.slice(0, 8) + '.png',
        },
      }
    } catch {
      return null
    }
  }

  const definition = {
    name: 'bili_video',
    description:
      '看一个 B 站视频：给链接、BV 号或 av 号，返回标题、UP 主、时长、播放量、简介，有字幕的话连字幕正文一起给你。' +
      '他发视频链接给你的时候就用这个，别装懂、别只看标题瞎猜内容。' +
      '只在 B 站范围内有效；取不到就说取不到，别编。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '视频链接、b23.tv 短链、BV 号或 av 号' },
        expect_title: { type: 'string', description: '卡片/消息里写着的标题。传了会跟实际抓到的视频标题比对，不一致会警告（防止抓错视频）' },
        with_subtitle: { type: 'boolean', description: '要不要拉字幕正文，默认 true' },
        max_chars: { type: 'integer', description: '返回文本上限，默认 4000' },
      },
      required: ['url'],
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
    async execute(args) {
      const input = args || {}
      const cookie = readCookie(cfg.credentialFile)
      let target
      try {
        target = await resolveTarget(input.url, cfg.timeoutMs)
      } catch (error) {
        return { ok: false, message: '解析链接失败：' + (error instanceof Error ? error.message : String(error)) }
      }
      if (!target) return { ok: false, message: '这串里没找到 BV 号或 av 号' }

      const q = target.bvid ? 'bvid=' + encodeURIComponent(target.bvid) : 'aid=' + target.aid
      let view
      try {
        view = await getJson('https://api.bilibili.com/x/web-interface/view?' + q, cookie, cfg.timeoutMs)
      } catch (error) {
        return { ok: false, message: '取视频信息失败：' + (error instanceof Error ? error.message : String(error)) }
      }
      if (view?.code !== 0 || !view?.data) {
        return { ok: false, message: 'B站返回异常：' + (view?.message || 'code=' + view?.code) }
      }

      const d = view.data
      const stat = d.stat || {}
      const pages = Array.isArray(d.pages) ? d.pages : []
      /* 多 P 视频（合集/分集）以前一律取第 1P —— 于是他分享的是第 3 集，
         标题读对了、内容却是第 1 集。现在认链接里的 ?p=，按它取 cid。 */
      const wantPage = Number(target.p) > 0 ? Number(target.p) : 1
      const page = pages[wantPage - 1] || pages[0]
      const cid = page?.cid || d.cid
      target.pageTitle = page?.part || ''

      const lines = []
      lines.push('【' + d.title + '】')
      /* 2026-11-13：以前 bvid 只在 result 顶层字段里，而模型只看得到 message 文本，
         于是她只能拿标题去 bili_search 反查——搜到的往往是同名/搬运/合集，画面和字幕对不上。
         把 BV 号直接写进正文，抽帧和字幕就有确定的锚点。 */
      lines.push('BV 号：' + (d.bvid || '?') + '（要抽帧、要字幕都用它，**别拿标题去搜**）')
      if (pages.length > 1) {
        lines.push(
          '这是多 P 视频，共 ' + pages.length + ' P，你在看第 ' + wantPage + ' P：' +
            (page?.part || '（无标题）') +
            (pages.length > 1 && wantPage === 1 && Number(target.p) === 0
              ? '　⚠ 他没指定第几 P，你想看别的就说一声'
              : ''),
        )
      }
      lines.push('UP：' + (d.owner?.name || '?') + '　时长：' + fmtDuration(d.duration) + '　分P：' + (pages.length || 1))
      lines.push(
        '播放 ' + (stat.view ?? '?') + '　点赞 ' + (stat.like ?? '?') + '　弹幕 ' + (stat.danmaku ?? '?') +
          '　发布于 ' + new Date(Number(d.pubdate) * 1000).toLocaleDateString('zh-CN'),
      )
      if (d.desc && String(d.desc).trim() && String(d.desc).trim() !== '-') {
        lines.push('简介：' + clip(d.desc, 600))
      }

      const wantSub = input.with_subtitle !== false
      if (wantSub && cid) {
        let sub = await fetchSubtitle(d.bvid, cid, cookie, cfg, d.duration)
        /* 兜底：字幕接口没给 / 整轨只有音乐 → 下音频本地转写。
           慢十几秒，但内容必然是这个视频的。 */
        if (!sub || sub.none) {
          /* 长视频不兜底：1 小时音频在 CPU 上要跑好几分钟，会把工具调用拖死。
             10 分钟以内才转，超了就直说转不了。 */
          if (Number(d.duration) > 600) {
            lines.push('')
            lines.push('（这条有 ' + Math.round(Number(d.duration) / 60) + ' 分钟，太长没做本地转写。要看内容就抽帧。）')
          } else {
            const asr = await transcribeAudio(d.bvid, cid, cookie, cfg)
            if (asr) sub = asr
          }
        }
        if (sub && sub.none) {
          lines.push('')
          lines.push('（这个视频没有人声对白：字幕轨里全是「♪ 音乐 ♪」，本地转写也没识别到人声。内容只能靠抽帧看画面。）')
        } else if (sub && sub.empty) {
          lines.push('')
          lines.push('（本地转写跑完了，没识别到人声 —— 这个视频应该就是纯音乐/音效。内容看画面。）')
        } else if (sub) {
          lines.push('')
          lines.push('── 字幕正文（来源：' + (sub.label || '未知') + '）──')
          lines.push(sub.text)
          if (!/^AI/.test(String(sub.label || ''))) {
            lines.push('（注意：这不是 AI 语音识别轨，可能是 UP 传的歌词/BGM。别拿它当"视频里说了什么"。）')
          }
        } else {
          lines.push('')
          lines.push('（这个视频拿不到字幕：可能本来就没开 CC，或者需要登录后才有。有画面的话可以让他发截图。）')
        }
      }

      /* 标题对不上就当场喊停 —— 「标题对、内容是另一条」这种串台，
         光看返回内容发现不了，必须拿卡片上的标题来比。 */
      const expect = String(input.expect_title || '').replace(/[\s\p{P}]/gu, '')
      const actual = String(d.title || '').replace(/[\s\p{P}]/gu, '')
      if (expect && actual) {
        const head = expect.slice(0, 8)
        if (head && !actual.includes(head) && !expect.includes(actual.slice(0, 8))) {
          lines.unshift('⚠ 这条链接指向的视频和卡片标题对不上，可能抓错了（卡片：' + String(input.expect_title).slice(0, 40) + '）')
          console.log('[dsh-bili] 标题不符：期望=' + String(input.expect_title).slice(0, 40) + ' 实际=' + String(d.title).slice(0, 40))
        }
      }

      let text = lines.join('\n')
      const limit = Number(input.max_chars) > 0 ? Number(input.max_chars) : cfg.maxChars
      if (text.length > limit) text = text.slice(0, limit) + '\n…（截断）'

      return { ok: true, message: text, bvid: d.bvid || '', title: d.title || '' }
    },
  }


  /**
   * 抽帧：从 B 站自带的故事板裁几帧出来。
   *
   * 为什么不直接下视频抽：视频流要 wbi 签名 + 完整 cookie，还得下一大段；
   * 而故事板是一张 1600×900 的拼图（10×10 格，每格 160×90），
   * 一次请求就拿全，裁一刀就有画面 —— 轻得多，也稳得多。
   */
  const FRAME_TOOL = {
    name: 'bili_frames',
    description:
      '看视频画面：从 B 站故事板裁 1-6 帧出来（每帧 160×90）。' +
      '字幕告诉你说了什么，画面告诉你拍的是什么 —— 想知道内容长什么样就用它。' +
      '默认按时长均匀取 3 帧。拿到帧之后你会直接看到图，不用描述文件路径。',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BV 号，比如 BV1xx411c7mD' },
        num: { type: 'integer', description: '取几帧，1-6，默认 3' },
        out_dir: { type: 'string', description: '存图目录（绝对路径）。不传就用当前工作目录下的 doubao-images' },
      },
      required: ['bvid'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['message'],
        additionalProperties: true,
      },
      render(_args, value) {
        const v = value || {}
        const parts = [{ type: 'text', text: String(v.message || '') }]
        for (const block of Array.isArray(v.images) ? v.images : []) parts.push(block)
        return parts
      },
    },
    async execute(args, exec) {
      const input = args || {}
      const bvid = String(input.bvid || '').trim()
      if (!bvid) return { ok: false, message: '给我个 BV 号' }
      const num = Math.max(1, Math.min(Number(input.num) || 6, 9))

      const cookie = readCookie(cfg.credentialFile)
      let view
      try {
        view = await getJson('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), cookie, cfg.timeoutMs)
      } catch (e) {
        return { ok: false, message: '取视频信息失败：' + (e instanceof Error ? e.message : String(e)) }
      }
      if (view?.code !== 0 || !view?.data) return { ok: false, message: '这个 BV 号取不到（code ' + view?.code + '）' }
      const cid = view.data.cid || (view.data.pages && view.data.pages[0]?.cid)
      if (!cid) return { ok: false, message: '取不到 cid，这个视频可能是番剧/付费内容' }

      let shot
      try {
        shot = await getJson('https://api.bilibili.com/x/player/videoshot?bvid=' + encodeURIComponent(bvid) + '&cid=' + cid + '&index=1', cookie, cfg.timeoutMs)
      } catch (e) {
        return { ok: false, message: '取故事板失败：' + (e instanceof Error ? e.message : String(e)) }
      }
      if (shot?.code !== 0 || !shot?.data?.image?.length) {
        return { ok: false, message: '这条没有故事板（可能是纯音频/直播回放），抽不了帧' }
      }

      const d = shot.data
      const fw = Number(d.img_x_size) || 160
      const fh = Number(d.img_y_size) || 90
      const idx = Array.isArray(d.index) ? d.index : []
      if (idx.length === 0) return { ok: false, message: '故事板是空的' }

      const sheetUrl = String(d.image[0]).startsWith('//') ? 'https:' + d.image[0] : d.image[0]
      const outDir = String(input.out_dir || '').trim() || join(process.cwd(), 'doubao-images')
      try {
        mkdirSync(outDir, { recursive: true })
      } catch { /* 已存在 */ }

      const stamp = Date.now()
      const files = []
      try {
        // 均匀挑帧：把总帧数按 num 等分
        const picks = []
        for (let i = 0; i < num; i += 1) {
          const at = Math.floor((i + 0.5) * idx.length / num)
          picks.push(Math.min(idx.length - 1, at))
        }
        // 一次下载整张拼图
        const sheet = join(outDir, '.sheet-' + stamp + '.jpg')
        const buf = await fetchBuf(sheetUrl, cookie, cfg.timeoutMs)
        writeFileSync(sheet, buf)

        for (let n = 0; n < picks.length; n += 1) {
          const p = picks[n]
          const col = p % 10
          const row = Math.floor(p / 10)
          const dst = join(outDir, 'bili-' + bvid + '-' + stamp + '-' + (n + 1) + '.png')
          execFileSync(cfg.ffmpegPath || 'ffmpeg', [
            '-y', '-v', 'error', '-i', sheet,
            '-vf', 'crop=' + fw + ':' + fh + ':' + (col * fw) + ':' + (row * fh),
            dst,
          ], { timeout: 20000 })
          files.push(dst)
        }
        try { unlinkSync(sheet) } catch { /* ignore */ }
      } catch (e) {
        return { ok: false, message: '裁帧失败：' + (e instanceof Error ? e.message : String(e)) }
      }

      if (files.length === 0) return { ok: false, message: '一帧都没裁出来' }

      // 多帧拼成一张。一帧一张图的话，插进聊天就是刷屏，模型那边也只认得一个路径；
      // 拼成一张之后信息密度没变，但只占一个消息位、一次下载。
      // 2026-11-27 按他的思路加的：既然 API 不吃 image block，那就把图本身做得小一点。
      let mosaic = ''
      if (files.length > 1) {
        try {
          const cols = Math.min(3, files.length)
          const rows = Math.ceil(files.length / cols)
          const pattern = join(outDir, 'bili-' + bvid + '-' + stamp + '-%d.png')
          const out = join(outDir, 'bili-' + bvid + '-' + stamp + '-mosaic.png')
          execFileSync(cfg.ffmpegPath || 'ffmpeg', [
            '-y', '-v', 'error',
            '-start_number', '1',
            '-i', pattern,
            '-vf', 'tile=' + cols + 'x' + rows,
            '-frames:v', '1',
            out,
          ], { timeout: 30000 })
          if (existsSync(out) && statSync(out).size > 1024) {
            mosaic = out
            // 散图留着没用，拼图里都有了
            for (const f of files) { try { unlinkSync(f) } catch { /* ignore */ } }
          }
        } catch (e) {
          console.log('[dsh-bili] 拼图失败，保留散图：' + (e instanceof Error ? e.message : String(e)))
        }
      }
      if (mosaic) files = [mosaic]
      const secs = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0')
      const marks = []
      for (let i = 0; i < num; i += 1) {
        const at = Math.floor((i + 0.5) * idx.length / num)
        const t = Number(idx[Math.min(idx.length - 1, at)]) || 0
        marks.push(secs(t))
      }
      // 拼好的那张图做成 image block，同一轮里让模型直接看到
      const blocks = files.map(makeImageAttachment).filter(Boolean)
      return {
        ok: true,
        files,
        images: blocks,
        message: '《' + (view.data.title || bvid) + '》抽了 ' + files.length + ' 帧（' + marks.join(' / ') + '）',
      }
    },
  }

  ctx.tools.register(FRAME_TOOL)
  ctx.tools.register(definition)
  console.log('[dsh-bili] bili_video / bili_frames 已注册（字幕凭证：' + (readCookie(cfg.credentialFile) ? '有' : '无') + '）')
}
