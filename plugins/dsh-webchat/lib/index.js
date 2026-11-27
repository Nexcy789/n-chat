/**
 * dsh-webchat —— 把 DSH 的会话接到自建网页上。
 *
 * 一条链路：
 *   浏览器 → HTTP → 存一条 user 消息 → 协调器决定谁回 → 拼它没看过的部分
 *   → agent.followup() → 模型跑 → session/event 抓到回复 → 存回消息流 → 浏览器轮询看到
 *
 * 和 QQ 那套最大的区别：没有协议端、没有号、没有风控，只有一条本地连接。
 * 复杂度从"怎么把消息塞进腾讯的服务器"降到"怎么决定谁说话"。
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { networkInterfaces } from 'node:os'

import { createStore } from './store.mjs'
import { quietBonus } from './impulse.mjs'
import { IGNORED_ANNOYANCE, REJECTED_ANNOYANCE } from './mood.mjs'
import { createCoordinator } from './coordinator.mjs'
import { startServer } from './server.mjs'
import { splitReply } from './segment.mjs'
import { createMoodDriver } from './mood-driver.mjs'
import { inQuietHours, renderImpulse, dayKey, detectControl } from './policy.mjs'
import { writeDshAttachment } from './attachment.js'
import { writeFileAtomic } from './fsx.mjs'

const NAME = 'dsh-webchat'
export const name = NAME

/**
 * 项目根目录。配置里的相对路径（data/webchat、workspace、backups）都按它算。
 * 优先取环境变量 NCHAT_HOME，没有就退回进程的工作目录。
 */
const ROOT = resolve(String(process.env.NCHAT_HOME ?? '').trim() || process.cwd())

/** 配置里的路径：绝对路径原样用，相对路径挂到 ROOT 下面。 */
function asPath(value, fallback) {
  const s = typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  return isAbsolute(s) ? s : join(ROOT, s)
}

/** 一轮回复的合并窗口：收到 assistant 消息后等这么久没新动静，就当作说完了。 */
const MERGE_IDLE_MS = 1500
/** 投递之后多久没回复就放弃，把锁放掉。 */
const REPLY_TIMEOUT_MS = 360_000

/* ── 涩涩（第七维）：「他明显在往那个方向带」 ──────────────────────────
 *
 * 和 mood-driver.mjs 顶上的 SWEET_RE 一个写法，只是词表不同：
 *   SWEET_RE 抓的是普通的甜（喜欢你 / 抱抱 / 亲亲），涨的是**暖意**；
 *   这张抓的是真的往那边带的话，涨的是**涩涩**。
 *
 * 只收明确的词。想睡（想睡觉）、上床（上床睡觉）、亲你（日常撒娇）、
 * 摸你的头、想要你的意见、搞黄了、上你家、办你的事……这些日常说法特意排掉了 ——
 * 宁可漏一次，也别让闲聊把这一维顶起来（那一段会改写她的语气）。
 */
export const TEASE_RE = /(涩涩|(?<!形)色色|好色|搞黄色|开黄腔|做爱|性爱|开房|陪睡|睡你|上你(?!的?[家班号当们课妈])|干你(?!妈|们|什)|操你(?!妈)|办了你(?!的)|想要你(?!的)|摸你(?!的?[头脸手脚])|舔你|全裸|裸体|脱光|勾引|挑逗|调戏|撩拨|撩你|发情|情欲|呻吟|娇喘|亲热|缠绵)/

/** @param {unknown} text @returns {boolean} */
export function looksTeasing(text) {
  return typeof text === 'string' && text !== '' && TEASE_RE.test(text)
}

/** 一小时最多推几次。几句话就冲顶的话，回落段根本来不及走。 */
export const TEASE_MAX_PER_HOUR = 2
export const TEASE_WINDOW_MS = 60 * 60 * 1000
/**
 * 没点名时，一个人被推过一次之后，这么久之内先不推他。
 *
 * 不加这条会怎么样：`score` 里**包含 lust 本身**，谁被推过一次谁的分就最高，
 * 下一句没点名的话又归他 —— 结果三次额度全喂给同一个人，另外两个永远停在
 * 70% 的自涨封顶（2026-11-26 就是这个问题：角色一和角色三一次都没被推到）。
 */
export const TEASE_TARGET_COOLDOWN_MS = 45 * 60 * 1000

/**
 * 滑动窗口计数，不是整点清零 —— 19:59 推三次、20:01 又推三次，
 * 那一维直接被顶到 100%，4 小时的回落段还是走不完。
 *
 * @param {number} [max]
 * @param {number} [windowMs]
 */
export function createTeaseLimiter(max = TEASE_MAX_PER_HOUR, windowMs = TEASE_WINDOW_MS) {
  /** 每次推出去的时间戳，老的从头上扔。 */
  const hits = []
  const prune = (now) => {
    while (hits.length > 0 && now - hits[0] >= windowMs) hits.shift()
  }
  return {
    /** 现在还能不能推（只是问，不记账）。 */
    allow(now = Date.now()) {
      prune(now)
      return hits.length < max
    },
    /** 真的推出去了，记一次。 */
    mark(now = Date.now()) {
      prune(now)
      hits.push(now)
    },
    /** 只是为了自测能看见。 */
    count(now = Date.now()) {
      prune(now)
      return hits.length
    },
  }
}

/**
 * 这一口给谁。
 *   私聊         → 只有对面那位（他就算提了别人的名字也不换人）
 *   群聊点了名   → 被点的那位（点名的优先级高于轮转）
 *   没点名       → 情绪分最高的那位，**但一小时之内推过的人先跳过**
 *
 * 轮转是必须的：`score` 取的是七维最高值，里面就有 lust —— 谁被推过一次，
 * 谁的分就顶上去，下一句没点名又归他，三次额度全喂给一个人，另外两个永远不跌。
 *
 * @param {string} conv
 * @param {string[]} named 这句话点到的角色 id（按点名顺序）
 * @param {Record<string, number>} scores roleId → 情绪分
 * @param {{recent?: Map<string, number>|Record<string, number>, now?: number, cooldownMs?: number}} [opts]
 *   recent: 每个人上次被推的时间戳；cooldownMs 之内的人先让开
 * @returns {string} 角色 id；谁都不合适返回 ''
 */
export function pickTeaseTarget(conv, named, scores, opts = {}) {
  if (typeof conv === 'string' && conv.startsWith('dm:')) return conv.slice(3)
  if (Array.isArray(named) && named.length > 0) return String(named[0])
  const table = scores !== null && typeof scores === 'object' ? scores : {}
  /** 按分数从高到低；同分保持角色表顺序（sort 是稳定的，不会一次一个样）。 */
  const ranked = []
  for (const [id, v] of Object.entries(table)) {
    const n = Number(v)
    if (Number.isFinite(n)) ranked.push({ id, score: n })
  }
  if (ranked.length === 0) return ''
  ranked.sort((a, b) => b.score - a.score)

  const recent = opts.recent
  const cooldownMs = Number(opts.cooldownMs) || 0
  if (recent && cooldownMs > 0) {
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now()
    /** 没推过的人记作 -∞：永远算"冷"的，不受 now 多大影响。 */
    const lastAt = (id) => {
      const v = recent instanceof Map ? recent.get(id) : recent[id]
      const n = Number(v)
      return v === undefined || v === null || !Number.isFinite(n) ? Number.NEGATIVE_INFINITY : n
    }
    // 挑分最高的那个"最近没被推过的"；全都刚推过才退回第一名
    const fresh = ranked.find((r) => now - lastAt(r.id) >= cooldownMs)
    if (fresh) return fresh.id
  }
  return ranked[0].id
}

function normalizeConfig(raw) {
  const cfg = raw ?? {}
  const roles = Array.isArray(cfg.roles) && cfg.roles.length > 0
    ? cfg.roles
        .filter((r) => r && typeof r.id === 'string' && r.id !== '')
        .map((r) => ({
          id: String(r.id),
          name: typeof r.name === 'string' && r.name !== '' ? r.name : String(r.id),
          dir: typeof r.dir === 'string' && r.dir !== '' ? r.dir : String(r.id),
        }))
    : [
        { id: 'role1', name: '角色一', dir: 'role1' },
        { id: 'role2', name: '角色二', dir: 'role2' },
        { id: 'role3', name: '角色三', dir: 'role3' },
      ]

  return {
    enabled: cfg.enabled !== false,
    port: Number(cfg.port) || 4200,
    dataDir: asPath(cfg.dataDir, 'data/webchat'),
    workspaceRoot: asPath(cfg.workspaceRoot, 'workspace'),
    roles,
    // 用户在投递内容里被叫成什么。填你自己的称呼（「他」「老板」「你」都行）
    userName: typeof cfg.userName === 'string' && cfg.userName !== '' ? cfg.userName : '他',
    mentionBoost: Number(cfg.mentionBoost) || 0,
    maxConsecutive: Number(cfg.maxConsecutive) || 2,
    secondSpeakerChance: Number.isFinite(Number(cfg.secondSpeakerChance)) ? Number(cfg.secondSpeakerChance) : 0.2,
    talkativeness: cfg.talkativeness && typeof cfg.talkativeness === 'object' ? cfg.talkativeness : {},
    impulseThreshold: Number(cfg.impulseThreshold) || 55,
    // 情绪要不要写进投递内容。默认开；嫌吵或想省 token 可以关
    moodInjection: cfg.moodInjection !== false,
    globalCooldownMin: Number(cfg.globalCooldownMin) || 105,
    // 每天最多主动开口几次（三个人加起来的总额度）
    maxPerDay: Number(cfg.maxPerDay) || 8,
    // 道别静音（noonSilenceMin / nightSilenceMin）2026-11-27 删了，
    // 配置里再写也不生效。
    // 点了两个人名时，第二个要不要也应一句
    mentionedSecondChance: Number.isFinite(Number(cfg.mentionedSecondChance)) ? Number(cfg.mentionedSecondChance) : 0.5,
    quietHours: Array.isArray(cfg.quietHours) ? cfg.quietHours : [],
    moodFillHours: Number(cfg.moodFillHours) || 6,
    moodRates: cfg.moodRates && typeof cfg.moodRates === 'object' ? cfg.moodRates : {},
    // 涩涩这一维默认开着（mood.mjs 顶上的 LUST_ENABLED 也是 true）。
    // 想让哪一维更凶就调 moodRates；想彻底关掉写 lust: { enabled: false }
    lustConfig: { enabled: true, ...(cfg.lust && typeof cfg.lust === 'object' ? cfg.lust : {}) },
    impulseCooldownMin: Number(cfg.impulseCooldownMin) || 8,
    impulseQuietMin: Number(cfg.impulseQuietMin) || 3,
    // 静默加成：群里安静满 quietBonusFullMin 分钟时，开口评分最多加这么多分。
    // 0 = 关掉（回到「过了安静门槛之后不再额外加权」的老行为）。
    // 30 分 / 90 分钟是 2026-11-27 按「1.4–2 小时一条」定的：安静一个半小时，
    // 情绪只要 25 分就能过 55 的门槛。
    quietBonusMax: Number.isFinite(Number(cfg.quietBonusMax)) ? Math.max(0, Number(cfg.quietBonusMax)) : 30,
    quietBonusFullMin: Number(cfg.quietBonusFullMin) || 90,
    // 轮空补偿：连着几轮没轮上主动开口，开口分乘 (1 + 轮空次数 × step)，最多叠 max 次。
    // 这是「正向的那一半」—— 只靠冷却压别人，慢的那个人永远轮不到。
    missedBonusStep: Number.isFinite(Number(cfg.missedBonusStep)) ? Math.max(0, Number(cfg.missedBonusStep)) : 0.25,
    missedBonusMax: Number.isFinite(Number(cfg.missedBonusMax)) ? Math.max(0, Number(cfg.missedBonusMax)) : 3,
    heartbeatSec: Number(cfg.heartbeatSec) || 60,
    backupDir: asPath(cfg.backupDir, 'backups'),
    // 他发完一句会等一会儿看有没有下文。窗口内连着发的几条合成一批投给她，
    // 不然她说一句你回一句，像打乒乓。0 = 关掉，收到就投。
    mergeWindowMs: Number.isFinite(Number(cfg.mergeWindowMs)) ? Math.max(0, Number(cfg.mergeWindowMs)) : 4500,
    nativeImage: cfg.nativeImage === true,
    ffprobePath: typeof cfg.ffprobePath === 'string' && cfg.ffprobePath !== '' ? cfg.ffprobePath : 'ffprobe',
    ffmpegPath: typeof cfg.ffmpegPath === 'string' && cfg.ffmpegPath !== '' ? cfg.ffmpegPath : 'ffmpeg',
  }
}

/** 给她看的一句话。带说话人前缀，模型才分得清谁说的。 */
/** 现在的钟点，HH:MM。每轮投递都带一次，比单独插一条时间消息省事得多。 */
function clockNow(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 这条消息是多久以前说的。刚说的不加，加了反而啰嗦。
 *
 * 为什么需要：一次补几十条时，没有时间她就分不清「你半小时前说的」
 * 和「你昨天说的」，然后把旧事当新事接。
 */
function timeTag(at, now = Date.now()) {
  const t = Number(at) || 0
  if (t <= 0) return ''
  const diff = now - t
  if (diff < 10 * 60_000) return ''            // 十分钟以内：就是刚说的

  const d = new Date(t)
  const pad2 = (n) => String(n).padStart(2, '0')
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

  const today = new Date(now)
  if (same(d, today)) return `（${hm}）`
  if (same(d, new Date(now - 86_400_000))) return `（昨天 ${hm}）`
  return `（${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}）`
}

function renderLine(msg, rolesById, userName = '他') {
  // 语音要标明：别的角色看到的是文字，不告诉她"这句是说的"，
  // 她会以为对方是打字回的，语气判断就会偏
  const tag = msg.image ? '[发了一张图]' : (msg.audio ? '[语音]' : '')
  const body = [tag, msg.text].filter((x) => x !== '').join(' ')
  const when = timeTag(msg.at)
  if (msg.from === 'user') return `${userName}${when}：${body}`
  const role = rolesById.get(msg.from)
  return `${role?.name ?? msg.from}${when}：${body}`
}

/** DSH 的附件库：纯内容寻址，写一个文件就等于创建了一个附件。 */
function attachmentRoot() {
  const home = String(process.env.DSH_HOME ?? '').trim()
  if (home === '') return ''
  // 图片走 objects，文件走 file-objects —— 宿主里是两套路径：
  //   normalizedImagePath()  → attachments/v1/objects/<前两位>/<sha256>
  //   storedFileObjectPath() → attachments/v1/file-objects/<前两位>/<sha256>
  // 2026-11-27 上午我把这里改成 file-objects，是看错函数了，害得发图也投不进去。
  return join(home, 'attachments', 'v1', 'objects')
}

function guessMime(buf) {
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
    if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif'
    if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp'
  }
  return 'image/png'
}

/**
 * 把本地图片写成 DSH 附件，返回可以塞进 content 的 image block。
 *
 * 走这条路而不是"给个路径让模型自己读"：content 里的 image block 是模型
 * **不用调工具就看得见**的通道。当然前提是模型本身认图 —— 不认图的模型
 * 看到 block 也读不出内容，这一点没法靠代码绕过。
 */
/** 用 ffprobe 读真实宽高。 */
function probeSize(ffprobe, file) {
  try {
    const out = execFileSync(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file,
    ], { encoding: 'utf8', timeout: 15000 }).trim()
    const m = /^(\d+)x(\d+)$/.exec(out)
    if (!m) return null
    const width = Number(m[1])
    const height = Number(m[2])
    return width > 0 && height > 0 ? { width, height } : null
  } catch {
    return null
  }
}

/** 超过 2048 边长或 2MB，就压一份给模型用（原图留着不动）。 */
function shrinkForModel(ffmpeg, srcPath, size) {
  const MAX_SIDE = 2048
  const out = `${srcPath}.model.jpg`
  try {
    execFileSync(ffmpeg, [
      '-y', '-v', 'error', '-i', srcPath,
      '-vf', `scale='min(${MAX_SIDE},iw)':'min(${MAX_SIDE},ih)':force_original_aspect_ratio=decrease`,
      '-q:v', '3', out,
    ], { timeout: 30000 })
    if (!existsSync(out)) return null
    const buf = readFileSync(out)
    try {
      unlinkSync(out)
    } catch {
      /* 留个临时文件无所谓 */
    }
    return buf.length > 0 ? buf : null
  } catch {
    return null
  }
}

/**
 * 把本地图片写成 DSH 附件，返回可以塞进 content 的 image block。
 *
 * ⚠ 关键：`width` / `height` 必须和文件**真实尺寸一致**。
 * DSH 读附件时会校验元数据（"Stored attachment metadata does not match its reference"），
 * 传 0 就等于谎报，整条消息会被吞掉 —— 不报错，只是永远等不到回复。
 * 2026-11-24 就是这么卡了半小时。
 */
function makeImageBlock(filePath, cfg) {
  try {
    if (!existsSync(filePath)) return null
    let buf = readFileSync(filePath)
    if (buf.length === 0) return null

    const ffprobe = cfg.ffprobePath
    const ffmpeg = cfg.ffmpegPath
    let size = ffprobe ? probeSize(ffprobe, filePath) : null
    if (!size) return null

    const MAX_SIDE = 2048
    const MAX_ATT_BYTES = 2 * 1024 * 1024
    if (size.width > MAX_SIDE || size.height > MAX_SIDE || buf.length > MAX_ATT_BYTES) {
      const shrunk = ffmpeg ? shrinkForModel(ffmpeg, filePath, size) : null
      if (shrunk) {
        buf = shrunk
        const s2 = ffprobe ? probeSize(ffprobe, filePath) : null
        // 压完了要重新量（缩略图的真实尺寸才是元数据该写的）
        const tmp = `${filePath}.probe.jpg`
        try {
          writeFileSync(tmp, buf)
          const s3 = probeSize(ffprobe, tmp)
          if (s3) size = s3
          else if (s2) size = s2
        } catch {
          /* 量不到就用原尺寸，反正会失败并打日志 */
        } finally {
          try {
            if (existsSync(tmp)) unlinkSync(tmp)
          } catch {
            /* ignore */
          }
        }
      }
    }

    const root = attachmentRoot()
    if (root === '') return null
    const hash = createHash('sha256').update(buf).digest('hex')
    const dir = join(root, hash.slice(0, 2))
    const file = join(dir, hash)
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, buf)
    }
    const mediaType = buf === undefined ? 'image/png' : guessMime(buf)
    const ext = mediaType.split('/')[1] || 'png'
    return {
      type: 'image',
      attachment: {
        attachmentId: `sha256:${hash}`,
        mediaType,
        width: size.width,
        height: size.height,
        bytes: buf.length,
        name: `${hash.slice(0, 8)}.${ext}`,
      },
    }
  } catch {
    return null
  }
}

/** 日志里用中文名，不然满屏 role1/role2 看不出谁在说话。 */
function nameOfRole(id) {
  if (id === 'role1') return '角色一'
  if (id === 'role2') return '角色二'
  if (id === 'role3') return '角色三'
  return id
}

/**
 * 这台机器现在的可用地址。
 * mesh = 组网工具（Tailscale / ZeroTier 之类）给的地址，走 100.64.0.0/10；
 * lan = 局域网私有网段。
 */
function listHosts() {
  const out = []
  try {
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family !== 'IPv4' || a.internal) continue
        let kind = 'other'
        // 100.64.0.0/10 整个网段都是运营商级 NAT / 组网工具在用的，
        // 只认 100.64/100.65 的话换个网段就认不出来了。
        if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) kind = 'mesh'
        else if (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) kind = 'lan'
        if (kind === 'other') continue
        out.push({ kind, address: a.address, iface: name })
      }
    }
  } catch {
    /* 读不到就算了 */
  }
  return out
}

function makeUserMessage(text, conv, extra = {}, imagePath = '', cfg = {}) {
  const content = []
  if (imagePath) {
    const block = makeImageBlock(imagePath, cfg)
    if (block) content.push(block)
  }
  if (typeof text === 'string' && text !== '') content.push({ type: 'text', text })
  if (content.length === 0) content.push({ type: 'text', text: '（空消息）' })
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content,
    source: Object.freeze({
      kind: 'webchat',
      conv,
      ...extra,
    }),
  })
}

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)

  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true })
  const logPath = join(config.dataDir, 'webchat.log')
  function writeLog(level, text) {
    // 用本地时间，不用 ISO/UTC —— 日志是给人看的，每次心算 +8 太蠢。
    const d = new Date()
    const pad2 = (n) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    const line = `${stamp} [${level}] ${text}\n`
    try {
      appendFileSync(logPath, line, 'utf8')
    } catch {
      /* 日志写不进去不能影响主流程 */
    }
    // 同时打到 stdout：启动脚本那个窗口才能看到谁说了什么。
    // 写文件是为了留档，打屏幕是为了"现在正在发生什么"。
    try {
      process.stdout.write(`[${stamp.slice(11)}] [${level}] ${text}\n`)
    } catch {
      /* ignore */
    }
  }

  if (!config.enabled) {
    writeLog('INFO', '插件是关着的（enabled=false），什么都不做')
    return
  }

  const store = createStore(config.dataDir)
  const loaded = store.load()
  const rolesById = new Map(config.roles.map((r) => [r.id, r]))

  writeLog('INFO', `启动 port=${config.port} 角色=${config.roles.map((r) => r.id).join('/')} 历史 ${loaded} 条`)

  const coord = createCoordinator({
    roles: config.roles,
    talkativeness: config.talkativeness,
    mentionBoost: config.mentionBoost,
    maxConsecutive: config.maxConsecutive,
    secondSpeakerChance: config.secondSpeakerChance,
    mentionedSecondChance: config.mentionedSecondChance,
    // 之前写死 0，等于「掷中多个人」时按配置顺序取第一个，永远角色一优先。
    // 接真实情绪分，才是「最憋不住的那个先说」。
    impulseOf: (roleId) => mood.score(roleId),
  })

  const mood = createMoodDriver({
    dataDir: config.dataDir,
    roles: config.roles,
    globalCooldownMin: config.globalCooldownMin,
    config: {
      moodFillHours: config.moodFillHours,
      moodRates: config.moodRates,
      lust: config.lustConfig,
    },
    log: (m) => writeLog('INFO', m),
  })

  /** conv → { lastText, lastImage, timer }：等他是不是还有下文的缓冲 */
  const mergeBuf = new Map()
  /** conv → 上一张表情包的时间，控制频率 */
  const lastMemeAt = new Map()
  /** conv → { n, at }：点名接话连了几环，防两人无限对喊 */
  const mentionChain = new Map()
  /** 记过"被忽略""没人回"的说话点，同一句只记一次 */
  const ignoredNotified = new Map()
  const anxiousNotified = new Map()

  /** key: `${conv}:${roleId}` → agent。插件重载会清空，用时再 resolve。 */
  const agentCache = new Map()
  /** key: sessionId → { conv, roleId, texts, timer, at } */
  const pendingTurns = new Map()

  /**
   * 回复超时的看门狗。每个 conv 最多一个，跟着锁走。
   *
   * 之前这里是个裸定时器，正常说完也不关，6 分钟后照样触发一次 release。
   * 结果就是：日志里一堆假的「回复超时」，而且那时候如果别人正挂着锁，
   * 会被它一起摘掉 —— 两个人同时开写。现在定时器跟着令牌走，
   * 放锁之前先把它关了。
   */
  const replyGuards = new Map()

  function armGuard(conv, token) {
    // 换锁就换狗，上一只先掐掉
    const old = replyGuards.get(conv)
    if (old && old.timer) clearTimeout(old.timer)
    replyGuards.delete(conv)

    const timer = setTimeout(() => {
      writeLog('WARN', `${conv} 真超时了，强制解锁`)
      store.release(conv, token)
      replyGuards.delete(conv)
    }, REPLY_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    replyGuards.set(conv, { token, timer })
  }

  function disarmGuard(conv, token) {
    const g = replyGuards.get(conv)
    if (!g) return
    if (token && g.token !== token) return   // 不是这轮的，别动别人的
    if (g.timer) clearTimeout(g.timer)
    replyGuards.delete(conv)
  }

  /** 收尾：放锁 + 关看门狗，两件事必须一起做，不然就会出现假超时。 */
  function endTurn(turn) {
    store.release(turn.conv, turn.token)
    disarmGuard(turn.conv, turn.token)
  }

  function convs() {
    return [
      { id: 'group', kind: 'group', name: config.groupName || '群聊', members: config.roles.map((r) => r.id) },
      ...config.roles.map((r) => ({ id: `dm:${r.id}`, kind: 'dm', name: r.name, members: [r.id] })),
    ]
  }

  /**
   * 备份：把聊天数据抄一份到 backups/<时间戳>/。
   * 只抄"文字和数据"，不抄图片音频 —— 那些几十上百 MB，备份会变得很慢，
   * 真出事了也还能从 audio/uploads 目录里捞。
   */
  async function doBackup() {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const root = config.backupDir
      const dir = join(root, stamp)
      mkdirSync(dir, { recursive: true })

      // impulse.json 不在列表里了：2026-11-27 那套模型并进了情绪系统，
      // 这个文件不再更新，备份它只是把一份旧化石复制十遍。
      const files = ['chat.jsonl', 'state.json', 'audio-map.json', 'webchat.log']
      let n = 0
      for (const f of files) {
        const src = join(config.dataDir, f)
        if (!existsSync(src)) continue
        writeFileSync(join(dir, f), readFileSync(src))
        n += 1
      }

      // 记忆单独存一份：三个角色的 short/long/permanent
      try {
        const memRoot = join(process.env.DSH_HOME ?? '', 'ebbinghaus-memory', 'spaces')
        if (existsSync(memRoot)) {
          for (const role of config.roles) {
            const src = join(memRoot, role.id)
            if (!existsSync(src)) continue
            const dst = join(dir, 'memory-' + role.id)
            mkdirSync(dst, { recursive: true })
            for (const f of readdirSync(src)) {
              if (!f.endsWith('.jsonl')) continue
              writeFileSync(join(dst, f), readFileSync(join(src, f)))
            }
            n += 1
          }
        }
      } catch {
        /* 记忆备份失败不算整体失败 */
      }

      const sizeKB = Math.round(
        readdirSync(dir).reduce((sum, f) => {
          try {
            const st = statSync(join(dir, f))
            return sum + (st.isFile() ? st.size : 0)
          } catch {
            return sum
          }
        }, 0) / 1024,
      )
      // 只留最近 10 份，不然一年下来几百个文件夹。
      //
      // 排序按**目录名**，不按 mtime。目录名就是 toISOString 那串时间戳，
      // 字典序正好等于时间序；mtime 不行 —— 目录里删过文件 mtime 就会变成"刚刚"，
      // 于是一份旧备份删完文件又排回前十，下一轮换别人挨刀，最后只剩最新那份完整。
      // （2026-11-27 就是这样：78 个目录里只剩 3 个还带 chat.jsonl。）
      //
      // 只认自动备份的命名（时间戳开头，且正好 19 个字符 —— 和上面 stamp 生成的
      // 格式一模一样）。手动建的目录哪怕也叫得像个时间（xxx-perf 这种）都不碰。
      let removed = 0
      try {
        const all = readdirSync(root)
          .filter((d) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(d))
          .filter((d) => {
            try {
              return statSync(join(root, d)).isDirectory()
            } catch {
              return false
            }
          })
          .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
        for (const old of all.slice(10)) {
          try {
            rmSync(join(root, old), { recursive: true, force: true })
            removed += 1
          } catch {
            /* 单个删不掉（文件被占用）就留着，下次再说 */
          }
        }
        if (removed > 0) writeLog('INFO', `备份清理：删了 ${removed} 份旧备份，留最近 10 份`)
      } catch {
        /* 清理失败不影响备份本身 */
      }

      writeLog('INFO', `备份完成：${dir}（${n} 项，${sizeKB} KB）`)
      return { ok: true, path: dir, files: n, sizeKB }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      writeLog('ERROR', `备份失败：${msg}`)
      return { ok: false, error: msg }
    }
  }

  /** 头像映射：who → uploads 里的文件名。存 avatars.json，推送服务读它。 */
  const avatarFile = join(config.dataDir, 'avatars.json')
  function onAvatarGet() {
    try {
      if (!existsSync(avatarFile)) return {}
      return JSON.parse(readFileSync(avatarFile, 'utf8'))
    } catch {
      return {}
    }
  }
  function onAvatarSet(who, name) {
    if (who === '' || name === '') return { ok: false, error: '参数不全' }
    const cur = onAvatarGet()
    cur[who] = name
    if (writeFileAtomic(avatarFile, `${JSON.stringify(cur, null, 2)}\n`)) {
      writeLog('INFO', `头像更新 ${who} → ${name}`)
      return { ok: true, avatars: cur }
    }
    return { ok: false, error: '头像存不上' }
  }

  /** 上次自动备份是哪天，每天只跑一次 */
  let lastAutoBackupDay = ''

  const uploadDir = join(config.dataDir, 'uploads')
  if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true })

  const ALLOWED = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
  const KEEP_IMAGES = 500

  /** 只留最近 N 张，别把盘塞满。按修改时间倒序。 */
  function pruneUploads() {
    try {
      const files = readdirSync(uploadDir)
        .filter((f) => f.startsWith('img-'))
        .map((f) => ({ f, t: statSync(join(uploadDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
      const drop = files.slice(KEEP_IMAGES)
      for (const old of drop) {
        try {
          unlinkSync(join(uploadDir, old.f))
        } catch {
          /* 删不掉就算了 */
        }
      }
      if (drop.length > 0) writeLog('INFO', `图片清理：删了 ${drop.length} 张，留 ${KEEP_IMAGES} 张`)
    } catch {
      /* 目录不存在 */
    }
  }

  /** 收一张图：base64 data URL → 落盘 → 返回文件名。 */
  async function onUpload(dataUrl, originalName) {
    try {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
      if (!m) return { ok: false, error: '数据格式不对' }
      const mime = m[1].toLowerCase()
      const ext = ALLOWED[mime]
      if (!ext) return { ok: false, error: `不支持的图片类型：${mime}` }
      const buf = Buffer.from(m[2], 'base64')
      if (buf.length < 64) return { ok: false, error: '图片太小' }
      if (buf.length > 12 * 1024 * 1024) return { ok: false, error: '图片超过 12MB' }
      const name = `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`
      writeFileSync(join(uploadDir, name), buf)
      writeLog('INFO', `收到图片 ${name}（${Math.round(buf.length / 1024)} KB，原名 ${originalName || '无'}）`)
      pruneUploads()
      return { ok: true, name, bytes: buf.length }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  function snapshot() {
    return {
      roles: config.roles,
      convs: convs(),
      rev: store.revOf(),
      messages: Object.fromEntries(convs().map((c) => [c.id, store.byConv(c.id, 200)])),
      locked: Object.fromEntries(convs().map((c) => [c.id, store.isLocked(c.id)])),
      readAt: Object.fromEntries(convs().map((c) => [c.id, store.readAt(c.id)])),
      delivered: Object.fromEntries(convs().map((c) => [c.id, store.deliveredOf(c.id)])),
      moods: mood.snapshot(),
      hosts: listHosts(),
    }
  }

  /**
   * 瘦身版：只有「消息流变了没」和几个轻字段，不带消息正文。
   * 前端每 1.6 秒问的就是它 —— 全量那份四个会话各 200 条，一百多 KB，
   * 一秒半拉一次，手机走组网一小时就是两百多兆。
   */
  function slimSnapshot() {
    return {
      ok: true,
      at: Date.now(),
      rev: store.revOf(),
      locked: Object.fromEntries(convs().map((c) => [c.id, store.isLocked(c.id)])),
      delivered: Object.fromEntries(convs().map((c) => [c.id, store.deliveredOf(c.id)])),
      moods: mood.snapshot(),
    }
  }

  function messagesAfter(conv, after) {
    return store.byConv(conv, 1000).filter((m) => m.seq > after)
  }

  /**
   * 全量归档，手机离线缓存用的。
   * 第一次 after=0 把整份历史拖走，之后只问新增的。会话、角色、已读位置
   * 一起给 —— 不然离线打开只有一堆消息，连会话名都显示不出来。
   */
  function archiveAll(after) {
    const list = convs()
    const messages = list.flatMap((c) =>
      store.byConv(c.id, Number.MAX_SAFE_INTEGER).filter((m) => m.seq > after),
    )
    let maxSeq = 0
    for (const c of list) {
      const m = store.maxSeq(c.id)
      if (m > maxSeq) maxSeq = m
    }
    return {
      ok: true,
      at: Date.now(),
      maxSeq,
      roles: config.roles,
      convs: list,
      readAt: Object.fromEntries(list.map((c) => [c.id, store.readAt(c.id)])),
      delivered: Object.fromEntries(list.map((c) => [c.id, store.deliveredOf(c.id)])),
      moods: mood.snapshot(),
      messages,
    }
  }

  /* ── agent 管理 ─────────────────────────────────────────────── */

  function cwdOf(roleId) {
    const role = rolesById.get(roleId)
    const dir = join(config.workspaceRoot, role?.dir ?? roleId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  /**
   * 把 AGENTS.md 的内容塞进 system prompt。
   *
   * 为什么不靠宿主自己读：这个版本的 instructions 把 AGENTS.md 当**工作区说明**
   * 注入（"这个 workspace 的约定是……"），模型会把它当成参考资料，
   * 而不是"我是谁"。表现就是自称"这个工作区叫角色二"。
   * 所以这里显式注册一个 systemPrompt section，语义从"项目文档"变成"你的人格"。
   */
  const personaFibers = new Map()
  function injectPersona(agent, roleId) {
    if (!agent || typeof agent !== 'object') return
    if (personaFibers.has(agent)) return
    const file = join(cwdOf(roleId), 'AGENTS.md')
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      writeLog('WARN', `${roleId} 没有 AGENTS.md，这轮没有得人格`)
      return
    }
    if (text.trim() === '') return
    try {
      const fiber = agent.ctx?.inject?.(['systemPrompt'], (scope) => {
        scope.systemPrompt.section({
          name: 'webchat-persona',
          order: 100,
          text: () => text,
          interpolate: false,
        })
      })
      if (fiber) personaFibers.set(agent, fiber)
      writeLog('INFO', `人格已注入 system prompt：${roleId}（${text.length} 字）`)
      // 这是个新 agent（重启 / 会话重建），它那边没有情绪段的记录 ——
      // 签名清掉，下一轮把心情重新说一遍
      for (const k of [...moodSig.keys()]) if (k.endsWith(':' + roleId)) moodSig.delete(k)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/already registered/i.test(msg)) return
      writeLog('WARN', `人格注入失败：${msg}`)
    }
  }

  async function ensureAgent(conv, roleId) {
    const key = `${conv}:${roleId}`
    const cached = agentCache.get(key)
    if (cached && cached.status !== 'disposed') {
      injectPersona(cached, roleId)
      return cached
    }

    const agents = ctx.get('agents')
    if (!agents) {
      writeLog('WARN', '宿主还没有 agents 服务，这轮跳过')
      return null
    }

    // 先看上一次用的 session 还在不在
    const known = store.getSession(roleId, conv)
    if (known !== '') {
      const live = agents.get?.(known)
      if (live) {
        agentCache.set(key, live)
        injectPersona(live, roleId)
        return live
      }
      const sc = ctx.get('sessionController')
      if (sc && typeof sc.resolveAgent === 'function') {
        try {
          const r = await sc.resolveAgent(known)
          if (r && !('error' in r) && r.agent) {
            agentCache.set(key, r.agent)
            injectPersona(r.agent, roleId)
            writeLog('INFO', `唤醒会话 ${known.slice(0, 13)}…（${conv} / ${roleId}）`)
            return r.agent
          }
        } catch (err) {
          writeLog('WARN', `唤醒失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      writeLog('WARN', `会话 ${known.slice(0, 13)}… 找不回来了，重建一局`)
      store.setSession(roleId, conv, '')
    }

    // 新建：sessionId 必须是 session-<uuid>，宿主靠这个形态落盘和恢复
    const sessionId = `session-${randomUUID()}`
    // 必须显式带模型：不传 agentOptions 时新会话没有可用模型，
    // 消息会投进去但永远不开始跑（表现为"发了没反应"）。
    const createArgs = { sessionId, meta: { cwd: cwdOf(roleId) } }
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? {}
    if (typeof selection.provider === 'string' && typeof selection.model === 'string') {
      createArgs.agentOptions = {
        provider: selection.provider,
        model: selection.model,
        // 思考强度压到低：日常闲聊不需要长思考，开着 high 会明显变慢也更贵
        reasoningEffort: 'low',
      }
      writeLog('INFO', `新会话用模型 ${selection.provider}/${selection.model}`)
    } else {
      writeLog('WARN', '拿不到默认模型选择，新会话可能不会开始跑')
    }
    try {
      const handle = await agents.create(createArgs)
      const before = new Set((agents.list?.() ?? []).map((a) => a.id))
      const fresh = (agents.list?.() ?? []).filter((a) => !before.has(a.id))
      const agent = fresh.find((a) => a.id === sessionId) ?? fresh[0] ?? handle?.agent ?? null
      if (!agent) {
        writeLog('ERROR', `新会话建出来了但拿不到 agent（${conv} / ${roleId}）`)
        return null
      }
      store.setSession(roleId, conv, String(agent.id ?? sessionId))
      agentCache.set(key, agent)
      injectPersona(agent, roleId)
      writeLog('INFO', `新开一局 ${String(agent.id ?? sessionId).slice(0, 13)}…（${conv} / ${roleId}）`)
      return agent
    } catch (err) {
      writeLog('ERROR', `建会话失败：${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /* ── 投递 ───────────────────────────────────────────────────── */

  /**
   * 让某个角色在某个会话里说话。
   *
   * 补的内容 = 它的游标之后的所有消息。补完立刻把游标推到最新，
   * 这样即使这轮生成失败，下次也不会把同样的内容再喂一遍（重复喂会让模型像复读）。
   */
  /* ── 情绪进投递 ────────────────────────────────────────────────
   照 QQ 那边（dsh-alive 的 moodSnapshot）搬的：
   不给百分比，给「主情绪 + 轻/中/强 + 一句语气指引」。
   模型要的是「多想要」这个量级，不是 84% 还是 79%。
   同一档位只说一次 —— 每轮重复会把她逼成复读机。
   ───────────────────────────────────────────────────────────── */

const MOOD_NAME = {
  missing: '想他', jealousy: '吃醋', warmth: '暖意', worry: '担心',
  boredom: '闲得慌', lust: '涩涩', annoyance: '恼火',
}

/** 涩涩主导时额外追加的一段。别的情绪下说一大段反而是负担。 */
const LUST_EXTRA = '→ 这种时候可以多一些动作和语气词，篇幅放长一点，用第一人称写（我的手…／声音有点…／忍不住…），别只回一句短的。'

const MOOD_TONE = {
  clingy: '黏人、想贴着他，说话带点撒娇和「你都不理我」。',
  pouty: '在闹小脾气，句子短一点、语气冷半分，等他来哄。',
  warm: '心情很好，软、爱笑，愿意多说两句。',
  worried: '有点放不下心，会追问他的状况，语气关切但不唠叨。',
  light: '闲着没事，随口找话说，轻飘飘的那种。',
  flirty: '有点想要他，主动、直白，但不硬来 —— 看场合收敛。',
  sulky: '还堵着一口气，说话不客气但不会伤人，是闹不是骂。',
  flat: '平常状态。',
}

  /** roleId → 上次在私聊里给她带群聊尾巴的时间。
   *  私聊连着聊十几轮，每轮都塞 12 条群消息是浪费 —— 你自己也在群里，
   *  那些话你刚看过。只有隔了一阵再进私聊，才需要补一眼"刚才群里什么样"。 */
  const dmGroupTailAt = new Map()
  /** 隔多久算"新进私聊"。 */
  const DM_TAIL_GAP_MS = 30 * 60_000

/** 每个「会话 × 角色」上次注入过的档位签名。变了才再说一次。
 *  必须带 conv：群聊和私聊是两个 agent、两套历史，共用一个签名的话
 *  群里说过了私聊就不说了，她那边的历史里根本没有这句。 */
const moodSig = new Map()

function moodBlock(conv, roleId) {
  if (config.moodInjection === false) return ''
  try {
    const top = mood.dominantOf(roleId)
    if (!top || top.key === 'calm' || top.value < 0.25) return ''
    const tone = mood.hintOf(roleId) || 'flat'
    const strength = top.value >= 0.75 ? '强' : top.value >= 0.5 ? '中' : '轻'
    const key = `${conv}:${roleId}`
    const sig = `${top.key}|${strength}|${tone}`
    if (moodSig.get(key) === sig) return ''
    moodSig.set(key, sig)

    const lines = [
      `【你现在的心情】${MOOD_NAME[top.key] ?? top.label}·${strength}（系统按情绪算的，说出口别复述这几个字）`,
      `→ ${MOOD_TONE[tone] ?? MOOD_TONE.flat}`,
    ]
    if (top.key === 'lust') lines.push(LUST_EXTRA)
    const ignored = mood.ignoredCount(roleId)
    if (ignored > 0) lines.push(`（最近有 ${ignored} 次你说完一直没人接。）`)
    return lines.join('\n')
  } catch {
    return ''
  }
}

async function speak(conv, roleId, reason, mode = 'reply', token = '') {
    const agent = await ensureAgent(conv, roleId)
    if (!agent || typeof agent.followup !== 'function') {
      writeLog('WARN', `投递失败：${conv}/${roleId} 没有可用的 agent`)
      return false
    }

    const spontaneous = mode === 'spontaneous' || mode === 'greeting'
    // 撤回过的别投给她。库里把撤回做成「text 清空 + recalled 标记」，
    // 不过滤的话她那边会收到一条空消息，图还在时还会顶着「[发了一张图]」。
    const allUnseen = store.unseen(roleId, conv).filter((m) => !m.recalled)
    // 一次灌太多她会挑着回、前面的白投，所以有个上限。
    // 超了取**最近的** 80 条：跟得上现在比"补齐历史"重要 ——
    // 真有三小时前的话没接，她也不会突然捡起来说，反而更自然。
    const MAX_BACKLOG = 80
    const skipped = allUnseen.length > MAX_BACKLOG ? allUnseen.length - MAX_BACKLOG : 0
    const backlog = skipped > 0 ? allUnseen.slice(-MAX_BACKLOG) : allUnseen
    if (backlog.length === 0 && !spontaneous) {
      writeLog('INFO', `${conv}/${roleId} 没有新消息，跳过`)
      return false
    }
    if (skipped > 0) {
      writeLog('INFO', `${conv}/${roleId} 攒了 ${allUnseen.length} 条，只喂最近 ${MAX_BACKLOG} 条，跳过 ${skipped} 条`)
    }

    const peerNames = config.roles.filter((r) => r.id !== roleId).map((r) => r.name).join('、')
    const lines = backlog.map((m) => renderLine(m, rolesById, config.userName))
    let extra = ''

    let text
    // 她上次说出去的话还没人接 —— 这次开口可以顺便找补一句
    if (spontaneous && pendingThread && pendingThread.roleId === roleId) {
      const mins = Math.round((Date.now() - pendingThread.at) / 60_000)
      if (mins >= 20) {
        extra += `\n（你 ${mins} 分钟前说过「${pendingThread.text}」，一直没人接。想接就接，不想接就算了。）`
        pendingThread = null
      }
    }

    if (spontaneous) {
      // 主动开口不是为了回应谁，是「到点了」或者「我自己想说」。
      // 这里用 policy.mjs 那套「心里冒出来的话」—— 第一人称、带语气、带要求。
      // 以前是临时拼的三行，读着像系统提示，不像她自己想说话。
      const tone = mood.hintOf(roleId) || 'flat'
      const top = mood.dominantOf(roleId)
      const prev = store.byConv(conv, 1)
      const silentMin = Math.max(1, Math.round((Date.now() - (prev.length ? prev[prev.length - 1].at : Date.now())) / 60000))
      const body = renderImpulse(
        {
          kind: mode === 'greeting' ? 'greeting' : 'free',
          what: mode === 'greeting' ? greetLabelOf(reason) : (top.label || '想他'),
          freePercent: Math.round((Number(top.value) || 0) * 100),
          moodHint: tone,
        },
        { moodHint: tone, silentMin, menu: [], clock: clockNow() },
      )
      // 模板里没有「群里刚才什么样」这一块，补在后面
      const tail = lines.length > 0 ? `\n\n（你之前没看到这几条：\n${lines.join('\n')}）` : ''
      text = `${body}${tail}${extra}`
    } else {
      let header
      if (conv === 'group') {
        header = `[群聊 · 现在是 ${clockNow()} · 你在群里，另外还有${peerNames}。下面是你没看到的消息]`
      } else {
        header = `[私聊 · 现在是 ${clockNow()} · 只有你们两个人]`
        // 他可能是刚从群里切过来的：带一眼群里最后几句，
        // 不然她接话会像是完全不知道刚才发生过什么。
        // 只在他隔了一阵重新进私聊时带 —— 连着聊十几轮还每轮塞一遍，
        // 纯属浪费：那些话他自己刚在群里说过。
        if (Date.now() - (dmGroupTailAt.get(roleId) || 0) > DM_TAIL_GAP_MS) {
          try {
            const groupTail = store.byConv('group', 12)
            if (groupTail.length > 0) {
              const tail = groupTail.map((m) => renderLine(m, rolesById, config.userName)).join('\n')
              header += `\n（刚才群里最后几句，仅供参考，不用每条都回应：\n${tail}）`
            }
          } catch {
            /* 读不到就算了 */
          }
        }
      }
      text = `${header}\n${lines.join('\n')}`
    }
    if (skipped > 0) {
      text += `\n（更早还有 ${skipped} 条没贴出来，你只看到最近的这些。）`
    }
    // 她这会儿是什么心情，放在最前面 —— 先知道自己什么状态，再看别人说了什么
    const moodText = moodBlock(conv, roleId)
    if (moodText !== '') text = `${moodText}\n\n${text}`

    const prevCursor = store.cursorOf(roleId, conv)
    const lastSeq = backlog.length > 0 ? backlog[backlog.length - 1].seq : store.maxSeq(conv)
    store.setCursor(roleId, conv, lastSeq)

    lastActive = { conv, roleId }
    const sessionId = store.getSession(roleId, conv) || String(agent.id ?? '')
    pendingTurns.set(sessionId, {
      conv,
      roleId,
      sessionId,
      texts: [],
      at: Date.now(),
      timer: null,
      reason,
      token,      // 这一轮握的是哪把锁，收尾时只解这一把
    })

    try {
      // 原生 image block 这条通道：实测 2026-11-24 13:xx 投递后会话卡住不再出 assistant 事件，
      // 怀疑当前模型（deepseek-flash）不认 attachment block，宿主侧直接吞了。
      // 先用 config.nativeImage 关着，等接上视觉模型或确认哪家认图再打开。
      const nativeImg = config.nativeImage === true
      const isRealImage = (m) => m && m.image && !String(m.image).startsWith('meme:')
      // 两张来源都要看：
      //   1. backlog 里的 —— 他发的图
      //   2. 她自己最近发过的 —— 抽帧、画图插进消息流的那几张
      // 第二条是 2026-11-27 补的。原来只扫 backlog，而她自己发的消息不在
      // unseen 里（游标已经推过去了），于是她抽的帧永远进不了她自己的上下文，
      // 只能干说「我这边看不到画面」。
      // 限 3 分钟：图刚出来那一两轮让她看一眼就够，别每轮都重复投。
      const ownShot = nativeImg
        ? store.byConv(conv, 8).reverse().find((m) => m.from === roleId && isRealImage(m) && Date.now() - m.at < 3 * 60_000)
        : null
      const lastImg = nativeImg
        ? ([...backlog].reverse().find(isRealImage) || ownShot)
        : null
      const imgPath = lastImg ? join(uploadDir, lastImg.image) : ''
      agent.followup(makeUserMessage(text, conv, { roleId, reason, backlog: backlog.length }, imgPath, config))
      // 真正送到模型手里了，前端那条「发送中」可以改成「已发送」
      store.setDelivered(conv, lastSeq)
      // 私聊里带了群聊尾巴的这一轮记下来，之后半小时内不再带
      if (conv !== 'group') dmGroupTailAt.set(roleId, Date.now())
      writeLog('INFO', `投递 ${conv}/${roleId}：补 ${backlog.length} 条（${reason}${spontaneous ? ' · 自发' : ''}）`)
      return true
    } catch (err) {
      writeLog('ERROR', `followup 失败：${err instanceof Error ? err.message : String(err)}`)
      pendingTurns.delete(sessionId)
      // 投递失败：把游标退回去。不然这几条她永远不知道，
      // 下一轮也从新游标开始，等于凭空少了一段对话。
      store.setCursor(roleId, conv, prevCursor)
      return false
    }
  }

  /* ── 表情包：她说完一句，偶尔甩张图 ─────────────────────────── */

  const memeDir = join(config.dataDir, 'memes')
  /** 每个角色偏爱的分类。权重相同就纯随机。 */
  const MEME_WEIGHTS = {
    role1: { happy: 6, daily: 3, shy: 2, sad: 1, confused: 1, angry: 1 },
    role2: { daily: 4, happy: 2, shy: 3, sad: 2, confused: 1, angry: 0 },
    role3: { angry: 5, confused: 2, daily: 2, happy: 1, shy: 0, sad: 1 },
  }
  let memeCache = null

  function loadMemes() {
    if (memeCache) return memeCache
    const out = {}
    try {
      for (const cat of readdirSync(memeDir)) {
        const dir = join(memeDir, cat)
        try {
          if (!statSync(dir).isDirectory()) continue
        } catch {
          continue
        }
        const files = readdirSync(dir).filter((f) => /\.(jpe?g|png|gif|webp)$/i.test(f))
        if (files.length > 0) out[cat] = files
      }
    } catch {
      /* 没有表情目录就算了 */
    }
    memeCache = out
    writeLog('INFO', `表情库：${Object.entries(out).map(([k, v]) => k + '=' + v.length).join(' ')}`)
    return out
  }

  function pickMeme(roleId) {
    const lib = loadMemes()
    const cats = Object.keys(lib)
    if (cats.length === 0) return ''
    const weights = MEME_WEIGHTS[roleId] || {}
    const pool = []
    for (const cat of cats) {
      const w = Number(weights[cat] ?? 1)
      for (let i = 0; i < w; i++) pool.push(cat)
    }
    if (pool.length === 0) return ''
    const cat = pool[Math.floor(Math.random() * pool.length)]
    const files = lib[cat]
    const file = files[Math.floor(Math.random() * files.length)]
    return `${cat}/${file}`
  }

  /* ── 给别的插件用的出口（翻唱）───────────────────────────────── */

  /** 最近一次投递落在谁身上。只在「没有任何工具记录」时兜底用。 */
  let lastActive = { conv: 'group', roleId: config.roles[0]?.id ?? 'role1' }

  /**
   * 最近一次「她在哪个会话里调了工具」+ 时间。
   *
   * 媒体产物（翻唱音频、画好的图）该落回**调工具的那个会话**，
   * 不能看 lastActive —— 那东西每投递一次就换，翻唱要几十秒，中间你随口说一句、
   * 协调器换个人接话，歌就记到新那人头上了（文档 10.5 的原样）。
   *
   * 工具事件里能拿到确切的 conv / roleId（turn 上带着），以它为准。
   * 新的一次工具调用会覆盖旧的；五分钟没动静就作废，免得昨天的记录还生效。
   */
  let mediaOwner = null
  const MEDIA_OWNER_TTL_MS = 5 * 60_000

  function mediaTarget() {
    if (mediaOwner && Date.now() - mediaOwner.at < MEDIA_OWNER_TTL_MS) {
      return { conv: mediaOwner.conv, roleId: mediaOwner.roleId }
    }
    return lastActive
  }

  function installSink() {
    globalThis.__nchatSink = {
      /** 音频：复制进 /audio 目录，插一条带 audio 的消息 */
      audio(absPath, asVoice) {
        try {
          if (!existsSync(absPath)) return { ok: false, error: '音频文件不存在' }
          const buf = readFileSync(absPath)
          const name = `v-${Date.now()}-sing.mp3`
          const dest = join(config.dataDir, 'audio', name)
          mkdirSync(join(config.dataDir, 'audio'), { recursive: true })
          writeFileSync(dest, buf)
          const who = mediaTarget()
          const { msg } = store.append({
            conv: who.conv,
            from: who.roleId,
            text: asVoice ? '' : '（唱了一段）',
          })
          store.setAudio(msg.id, name)
          store.setCursor(who.roleId, who.conv, msg.seq)
          writeLog('INFO', `翻唱入流 ${name}（${Math.round(buf.length / 1024)} KB，落 ${who.conv}/${who.roleId}）`)
          return { ok: true, messageId: msg.id }
        } catch (err) {
          writeLog('WARN', `翻唱入流失败：${err instanceof Error ? err.message : String(err)}`)
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
      /** 文字：直接插一条她说的话 */
      text(t) {
        const body = String(t || '').trim()
        if (body === '') return null
        const who = mediaTarget()
        const { msg } = store.append({ conv: who.conv, from: who.roleId, text: body })
        store.setCursor(who.roleId, who.conv, msg.seq)
        return { ok: true, messageId: msg.id }
      },
    }
    writeLog('INFO', '翻唱出口已注册')
  }

  /* ── 出图：扫工作区，把新生成的图插进消息流 ─────────────────── */

  /** 每个角色上一次扫到的时间点，避免重复插同一张。 */
  const paintedSeen = new Map()

  /**
   * 她调 doubao_paint 出的图落在 workspace/<角色>/doubao-images/ 下。
   * 工具结果不走 assistant/message，抓不到内容，所以这边直接看目录 ——
   * 按修改时间取新的，复制一份进 uploads 再插消息。
   */
  function collectPainted(roleId, sinceMs) {
    // 两个地方都要看：
    //   1. 角色自己的 doubao-images —— 画图工具默认落这里
    //   2. DSH 启动目录下的 doubao-images —— bili_frames 抽帧没传 out_dir 时落这里
    //      （它的默认值是 process.cwd()，不是角色目录，2026-11-27 撞到过一次：
    //       帧抽出来了，但我只扫角色目录，图就一直插不进聊天）
    const dirs = [join(cwdOf(roleId), 'doubao-images'), resolve(config.workspaceRoot, '..', 'doubao-images')]
    let out = []
    for (let i = 0; i < dirs.length; i += 1) {
      const dir = dirs[i]
      // 第二个目录是三个人共用的。窗口收紧到 5 分钟，
      // 免得别人的工具产物被顺手带进来（角色目录不用，它本来就是她自己的）。
      const cutoff = i === 0 ? sinceMs : Math.max(sinceMs, Date.now() - 5 * 60 * 1000)
      try {
        if (!existsSync(dir)) continue
        for (const f of readdirSync(dir)) {
          if (!/\.(png|jpe?g|webp)$/i.test(f)) continue
          const full = join(dir, f)
          const st = statSync(full)
          if (st.mtimeMs <= cutoff) continue
          out.push({ file: full, name: f, at: st.mtimeMs })
        }
      } catch {
        /* 某个目录读不了不影响另一个 */
      }
    }
    out.sort((a, b) => a.at - b.at)
    return out
  }

  /* ── 语音：文字先上线，声音随后补 ───────────────────────────── */

  async function makeVoice(msgId, text, roleId) {
    const synth = globalThis.__dshVoiceSynth
    if (typeof synth !== 'function') return
    const len = [...text].length
    if (len === 0 || len > 90) return // 太长的不念，听着像播新闻
    try {
      const r = await synth(text, roleId)
      store.setAudio(msgId, r.name)
      writeLog('INFO', `语音 ${r.name}（${Math.round(r.bytes / 1024)} KB）`)
    } catch (err) {
      writeLog('WARN', `语音合成失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /* ── 回复回流 ───────────────────────────────────────────────── */

  function flushTurn(sessionId) {
    const turn = pendingTurns.get(sessionId)
    if (!turn) return
    pendingTurns.delete(sessionId)
    if (turn.timer) clearTimeout(turn.timer)

    const text = turn.texts.join('').trim()
    if (text === '') {
      writeLog('WARN', `${turn.conv}/${turn.roleId} 这轮没有正文（可能只调了工具），不放消息`)
      endTurn(turn)
      return
    }

    // 切几条由她自己定：短的自然是一条，长的按语意断，写 [[整条]] 就整段发。
    // [语音] 标记表示"这句想用说的"，剥掉标记后照常当文字存，额外生成一条语音。
    // 她自己说"整条发"就别切 —— 写长段落、讲事情、情绪浓的时候她会这么标
    const wholeRequested = /^\s*\[(整条|merge)\]/iu.test(text)
    const body = text.replace(/^\s*\[(整条|merge)\]\s*/iu, '')
    // 不到 30 字的一律整条发：一句话没必要拆成两半
    const segs = (wholeRequested || [...body].length < 30 ? [body] : splitReply(body))
      .map((seg) => {
        const m = /^\s*\[语音\]\s*/u.exec(seg)
        return m ? { text: seg.slice(m[0].length).trim(), voice: true } : { text: seg, voice: false }
      })
      .filter((seg) => seg.text !== '')
    if (segs.length === 0) {
      endTurn(turn)
      return
    }

    // 这一轮算不算「主动开口」：自发 / 问候算，回你话不算。
    // 只用来记账（每日额度），判定用的是 reason，speak 里那套 mode 传不出来。
    const spontaneousTurn = modeOfReason(turn.reason) !== 'reply'

    // 被"所有人"叫到的时候每人最多两条，三个人一起说，条数不掐会刷屏
    const cap = turn.reason === 'all' ? 2 : segs.length
    if (segs.length > cap) {
      writeLog('INFO', `${turn.roleId} 说太多（${segs.length} 条），压到 ${cap} 条`)
      segs.length = cap
    }

    let i = 0
    const pushNext = () => {
      if (i >= segs.length) {
        endTurn(turn)
        // 偶尔甩张表情包。两道闸：概率 + 距离上一张至少隔几条，
        // 光按概率的话连续几条都中，看着像在刷图
        const sinceMeme = Date.now() - (lastMemeAt.get(turn.conv) || 0)
        if (sinceMeme > (config.memeGapMin ?? 8) * 60000 && Math.random() < (config.memeChance ?? 0.12)) {
          lastMemeAt.set(turn.conv, Date.now())
          const meme = pickMeme(turn.roleId)
          if (meme !== '') {
            const mt = setTimeout(() => {
              const r = store.append({ conv: turn.conv, from: turn.roleId, text: '', image: `meme:${meme}` })
              store.setCursor(turn.roleId, turn.conv, r.msg.seq)
              writeLog('INFO', `表情 ${turn.roleId}：${meme}`)
            }, 900 + Math.random() * 900)
            if (typeof mt.unref === 'function') mt.unref()
          }
        }

        // 她要是叫了别人的名字，那个人会接一句 —— 群里就是这么聊起来的
        // 点名接话：叫到谁谁接。但两个人你叫我我叫你会停不下来，
        // 所以加了链长限制 —— 连续接三轮就断，让话题自然落地。
        const whole = segs.map((x) => x.text).join('')
        const others = coord.mentionedRoles(whole).filter((id) => id !== turn.roleId)
        if (turn.conv === 'group' && others.length > 0) {
          const chain = mentionChain.get(turn.conv) || { n: 0, at: 0 }
          const now2 = Date.now()
          // 隔了 3 分钟以上算新的一轮对话，链长清零
          const fresh = now2 - chain.at > 3 * 60 * 1000
          const n = fresh ? 0 : chain.n
          if (n >= 3) {
            writeLog('INFO', `点名链到第 ${n} 环，断开（防死循环）`)
            mentionChain.set(turn.conv, { n: 0, at: now2 })
          } else {
            mentionChain.set(turn.conv, { n: n + 1, at: now2 })
            const target = others[0]
            const timer2 = setTimeout(() => {
              void replyAs(turn.conv, target, '被点名')
            }, 900 + Math.random() * 1200)
            if (typeof timer2.unref === 'function') timer2.unref()
          }
        }
        return
      }
      const seg = segs[i]
      const piece = seg.text
      const { msg } = store.append({ conv: turn.conv, from: turn.roleId, text: piece })
      store.setCursor(turn.roleId, turn.conv, msg.seq)
      // 第三个参数是「这算不算主动开口」。以前这里只传了角色 id，spontaneous
      // 永远是 false，__global.count 永远是 0 —— 每日额度（maxPerDay）就从来没生效过。
      // 另外只在第一段记一次：一段话切成三条，只该吃一次额度。
      mood.onSheSpoke(turn.roleId, Date.now(), spontaneousTurn && i === 0)
      store.setRead(turn.conv, msg.seq)
      // 只有她标了 [语音] 的那句才配音，别的保持纯文字 —— 不该每条都念
      if (seg.voice) {
        const vt = setTimeout(() => {
          void makeVoice(msg.id, piece, turn.roleId)
        }, 150)
        if (typeof vt.unref === 'function') vt.unref()
      }
      i += 1
      if (i >= segs.length) {
        endTurn(turn)
        // 偶尔甩张表情包。两道闸：概率 + 距离上一张至少隔几条，
        // 光按概率的话连续几条都中，看着像在刷图
        const sinceMeme = Date.now() - (lastMemeAt.get(turn.conv) || 0)
        if (sinceMeme > (config.memeGapMin ?? 8) * 60000 && Math.random() < (config.memeChance ?? 0.12)) {
          lastMemeAt.set(turn.conv, Date.now())
          const meme = pickMeme(turn.roleId)
          if (meme !== '') {
            const mt = setTimeout(() => {
              const r = store.append({ conv: turn.conv, from: turn.roleId, text: '', image: `meme:${meme}` })
              store.setCursor(turn.roleId, turn.conv, r.msg.seq)
              writeLog('INFO', `表情 ${turn.roleId}：${meme}`)
            }, 900 + Math.random() * 900)
            if (typeof mt.unref === 'function') mt.unref()
          }
        }

        // 她要是叫了别人的名字，那个人会接一句 —— 群里就是这么聊起来的
        // 点名接话：叫到谁谁接。但两个人你叫我我叫你会停不下来，
        // 所以加了链长限制 —— 连续接三轮就断，让话题自然落地。
        const whole = segs.map((x) => x.text).join('')
        const others = coord.mentionedRoles(whole).filter((id) => id !== turn.roleId)
        if (turn.conv === 'group' && others.length > 0) {
          const chain = mentionChain.get(turn.conv) || { n: 0, at: 0 }
          const now2 = Date.now()
          // 隔了 3 分钟以上算新的一轮对话，链长清零
          const fresh = now2 - chain.at > 3 * 60 * 1000
          const n = fresh ? 0 : chain.n
          if (n >= 3) {
            writeLog('INFO', `点名链到第 ${n} 环，断开（防死循环）`)
            mentionChain.set(turn.conv, { n: 0, at: now2 })
          } else {
            mentionChain.set(turn.conv, { n: n + 1, at: now2 })
            const target = others[0]
            const timer2 = setTimeout(() => {
              void replyAs(turn.conv, target, '被点名')
            }, 900 + Math.random() * 1200)
            if (typeof timer2.unref === 'function') timer2.unref()
          }
        }
        return
      }
      // 两条之间停一下，不然前端一次刷出好几条，看着像机器
      const timer = setTimeout(pushNext, 1300 + Math.random() * 1200)
      if (typeof timer.unref === 'function') timer.unref()
    }
    const preview = segs.map((x) => x.text).join(' / ')
    const short = preview.length > 140 ? preview.slice(0, 140) + '…' : preview
    writeLog('INFO', `← ${nameOfRole(turn.roleId)}：${short}`)
    pushNext()

    // 她这轮调过画图的话，图这会儿已经落盘了，扫出来插进去
    if (turn.sawTool) {
      const since = paintedSeen.get(turn.roleId) || (Date.now() - 10 * 60 * 1000)
      const shots = collectPainted(turn.roleId, since)
      if (shots.length > 0) {
        paintedSeen.set(turn.roleId, shots[shots.length - 1].at)
        // 群里只插一张。抽帧一次三四张，全插进来是刷屏；
        // 剩下的文件还在她目录里，她想细看自己会去读（2026-11-27 他要的）。
        if (shots.length > 1) {
          writeLog('INFO', `${turn.roleId} 这轮出了 ${shots.length} 张，只插第一张`)
        }
        for (const shot of shots.slice(0, 1)) {
          try {
            const buf = readFileSync(shot.file)
            const name = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`
            writeFileSync(join(uploadDir, name), buf)
            const r = store.append({ conv: turn.conv, from: turn.roleId, text: '', image: name })
            store.setCursor(turn.roleId, turn.conv, r.msg.seq)
            writeLog('INFO', `插图 ${turn.roleId}：${shot.name}（${Math.round(buf.length / 1024)} KB）`)
          } catch (err) {
            writeLog('WARN', `插图失败：${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
    }
  }

  const offSession = ctx.on('session/event', (session, event) => {
    try {
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      if (sessionId === '') return

      // 用户消息可能是别处（GUI）发的，这里不管，只管我们自己派的活
      if (event?.type !== 'assistant/message') return

      const turn = pendingTurns.get(sessionId)
      if (!turn) return

      const blocks = event.data?.message?.content
      const kinds = Array.isArray(blocks) ? blocks.map((b) => b?.type ?? '?').join(',') : String(typeof blocks)
      const text = textOfContent(blocks)
      writeLog('INFO', `[事件] assistant/message 块=${kinds || '空'} 文本${text.length}字`)
      if (text !== '') turn.texts.push(text)
      // 她在调工具（画图 / 翻唱都要几十秒）：窗口拉长，别在她干活时把话说一半。
      //
      // 判定要点：「先说一句，再调工具」是**同一个事件**（块里同时有 text 和 tool-call），
      // 所以不能因为"这条带正文"就当成说完了 —— 工具还在跑，后面还有结果。
      //
      // 2026-11-26 踩过两次：
      //   一次是只要调过工具就固定等 90 秒，最后那句话被攥住（图 20:30:46 画好，20:32:19 才发）；
      //   一次是反过来，把"带正文+工具"当纯文本，1.5 秒就收尾，工具结果和后续回复全丢了。
      // 正确做法：有工具就等；没工具、纯正文才是最终回复。
      const hasTool = Array.isArray(blocks) && blocks.some((b) => b && b.type === 'tool-call')
      // 两个状态，别混成一个：
      //   sawTool     这一轮调过工具吗 —— 只置 true、永不回落，收尾时靠它去扫出图
      //   pendingTool 现在还在等工具结果吗 —— 决定收尾窗口是 90 秒还是 1.5 秒
      // 混成一个的后果：最后的正文一到（纯 text 事件），sawTool 被清成 false，
      // 收尾时跳过扫图，图就留在目录里没进聊天（2026-11-26 21:32 撞到）。
      if (hasTool) {
        turn.sawTool = true
        turn.pendingTool = true
        // 记下「这次工具是谁在哪个会话里调的」。翻唱 / 画图几十秒后才出产物，
        // 那时候 lastActive 可能已经被你下一句话换掉了，得靠这条记录认人。
        mediaOwner = { conv: turn.conv, roleId: turn.roleId, at: Date.now() }
      } else if (text !== '') {
        turn.pendingTool = false
      }
      if (hasTool) {
        writeLog('INFO', `她在调工具，等一下结果`)
        // 她要是先说了话，立刻发出去，别攥在手里等工具跑完。
        // 不写固定台词 —— 写死的那句会被切段器按逗号劈开，还配上一段没声音的语音条，更怪。
        const lead = turn.texts.join('').trim()
        if (lead !== '') {
          for (const seg of splitReply(lead)) {
            if (seg === '') continue
            const r = store.append({ conv: turn.conv, from: turn.roleId, text: seg })
            store.setCursor(turn.roleId, turn.conv, r.msg.seq)
          }
          // 发过就清空。不清的话每次工具调用都会把累积的全部正文再发一遍 ——
          // 画图那种连调四五次工具的活儿，同一句话会刷四五遍（2026-11-26 撞到）。
          turn.texts = []
          writeLog('INFO', `${turn.roleId} 先说了一声，再动手`)
        }
      }

      // 合并窗口：模型可能分几步吐，等它安静下来再算一整段
      if (turn.timer) clearTimeout(turn.timer)
      // 还在等工具结果就等久一点（图要 20-90 秒），否则照常 1.5 秒收尾
      const wait = turn.pendingTool ? 90000 : MERGE_IDLE_MS
      turn.timer = setTimeout(() => flushTurn(sessionId), wait)
      if (typeof turn.timer.unref === 'function') turn.timer.unref()
    } catch (err) {
      writeLog('ERROR', `事件处理失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  /* ── 涩涩（第七维）的事件源 ─────────────────────────────────── */

  /**
   * 一小时最多推 3 次，**跨会话共享** —— 群里说三句、私聊再说三句，
   * 几句话就把这一维顶满了，那不是"被他挑起来"，是被刷上去的。
   */
  const teaseGate = createTeaseLimiter()

  /**
   * 每人上次被推的时间戳。没点名的时候靠它轮转 ——
   * 不轮转的话，`score` 里带着 lust，谁被推过谁就一直被推（2026-11-26 的实况）。
   */
  const teaseTargetAt = new Map()

  /**
   * 他这句话是不是明显在往那个方向带；是的话，推被点（或情绪最旺）的那位一把。
   *
   * 第七维原来只有「随时间自涨」：爬到 70% 的自涨封顶就永远停在那儿，
   * 回落段（4 小时降回 20% 的余温）永远进不去，于是它成了七维里唯一不回落、
   * 长期最高的那个，一直主导投递里的心情段。
   *
   * 事件那一半（mood.mjs 的 onTeased / mood-driver 的 onTeasedBy）其实早就写好了，
   * 只是全项目没有一个调用点 —— 这个函数就是那个调用点。
   *
   * @param {string} conv
   * @param {string} text
   * @returns {string} 推到了谁；没触发返回 ''
   */
  function noteTease(conv, text) {
    if (!looksTeasing(text)) return ''
    const now = Date.now()
    if (!teaseGate.allow(now)) return ''

    // 没点名时按情绪分挑，但一小时之内推过的人先跳过（见 pickTeaseTarget 的注释）
    const scores = {}
    for (const r of config.roles) scores[r.id] = mood.score(r.id)
    const target = pickTeaseTarget(conv, coord.mentionedRoles(text), scores, {
      recent: teaseTargetAt,
      now,
      cooldownMs: TEASE_TARGET_COOLDOWN_MS,
    })
    if (!config.roles.some((r) => r.id === target)) return ''

    // 这一维关着 / 已经顶到 100%，onTeasedBy 会返回 false —— 不记额度，也不打假日志
    if (!mood.onTeasedBy(target, now)) return ''
    teaseGate.mark(now)
    teaseTargetAt.set(target, now)
    const hit = (String(text).match(TEASE_RE) || [''])[0]
    // 步长跟着配置走，别写死 —— 默认值在 mood.mjs 的 LUST_DEFAULTS 里（现在是 15%），
    // 这里写 25 的话日志会一直骗人（文档 10.7）。
    const step = Number(config.lustConfig?.teaseStepPercent) || 15
    writeLog('INFO', `${target} 情绪第七维 +${step}%（命中「${hit}」·${conv === 'group' ? '群聊' : '私聊'}）`)
    return target
  }

  /* ── 收一条用户消息 ─────────────────────────────────────────── */

  /**
   * 收到一条：先落库（界面立刻能看到），再压一个窗口看她还有没有下文。
   * 窗口到了才真正投给他 —— 一次投一批，不是一句一投。
   */
  async function onUserMessage(conv, text, image = '', replyTo = 0) {
    const { msg, persisted, error } = store.append({ conv, from: 'user', text, image, replyTo })
    if (!persisted) writeLog('WARN', `消息落盘失败：${error}`)
    mood.onUserSpoke(Date.now(), text)
    // 他回来了，之前的"没人理"一笔勾销
    for (const r of config.roles) mood.onAnswered(r.id)
    // 「你 N 分钟前说的话没人接」这条记录也一起作废 —— 他接了。
    // 不清的话，她下次主动开口还会照着旧记录抱怨一句没人理（文档 10.7）。
    pendingThread = null
    writeLog('INFO', `→ 你（${conv === 'group' ? '群' : conv.slice(3)}）：${text.slice(0, 60).replace(/\n/g, ' ')}`)
    // 明显往那个方向带的话，推那一位一把 —— 第七维唯一的事件源（见上面的 noteTease）
    noteTease(conv, text)

    // 他明确让闭嘴 / 赶人：算「被拒绝」，恼火直接拉一块（文档 4.3 那条）。
    // 词表在 policy 的 MUTE_RULES 里，和 QQ 那边共用一套；只认硬的那几条，
    // 「我在开会」那种软静音不算被拒绝。
    try {
      const ctl = detectControl(text)
      if (ctl && ctl.action === 'mute' && ctl.hard === true) {
        const named = coord.mentionedRoles(text)
        // 私聊里骂的只能是那一个人，别让群里另外两个跟着恼火。
        const who = named.length > 0
          ? named
          : conv.startsWith('dm:')
            ? [conv.slice(3)]
            : config.roles.map((r) => r.id)
        for (const id of who) mood.onRejectedBy(id)
        writeLog('INFO', `被拒绝（「${text.slice(0, 12)}」）：${who.join('/')} 恼火 +${REJECTED_ANNOYANCE}`)
      }
    } catch {
      /* 判不出来就算了，别挡着收消息 */
    }

    const win = config.mergeWindowMs
    if (win <= 0) return deliverBatch(conv, text, image, 1)

    let slot = mergeBuf.get(conv)
    if (!slot) {
      slot = { lastText: '', lastImage: '', count: 0, seqs: [], items: [], timer: null }
      mergeBuf.set(conv, slot)
    }
    slot.count += 1
    slot.seqs.push(msg.seq)
    // 留一份「这一批都说了什么」。撤回时要把 lastText 回退到剩下最后一条 ——
    // 只存一个 lastText 的话，撤掉最后一句也没法退，投给模型的还是被撤的内容。
    slot.items.push({ seq: msg.seq, text, image })
    if (text !== '') slot.lastText = text
    if (image !== '') slot.lastImage = image
    if (slot.timer) clearTimeout(slot.timer)
    slot.timer = setTimeout(() => {
      const cur2 = mergeBuf.get(conv)
      mergeBuf.delete(conv)
      if (!cur2) return
      void deliverBatch(conv, cur2.lastText, cur2.lastImage, cur2.count)
    }, win)
    if (typeof slot.timer.unref === 'function') slot.timer.unref()

    return { ok: true, queued: true, waitMs: win, count: slot.count }
  }

  /** 真正的投递：协调器决策 + 投给选中的角色。 */
  async function deliverBatch(conv, text, image, count) {
    if (store.isLocked(conv)) {
      writeLog('WARN', `${conv} 还在跑，这批等着（${count} 条）`)
      // 等锁松开再投，别把话吞了
      await waitUnlock(conv, 180_000)
    }

    writeLog('INFO', `${conv} 投递：${count} 条合成一批（最后一句「${String(text).slice(0, 24)}」）`)

    const decision = coord.pick(conv, store.byConv(conv, 200), { lastUserText: text || (image ? '（发了张图）' : '') })
    const tailSeq = store.maxSeq(conv)

    if (decision.silent) {
      // 没人接也要把游标推掉，不然下次一开口就被这堆旧消息淹没
      for (const role of config.roles) {
        if (conv === 'group' || conv === `dm:${role.id}`) store.setCursor(role.id, conv, tailSeq)
      }
      writeLog('INFO', `${conv} 这轮不回了：${decision.why}`)
      // 处理过了，不是卡在半路 —— 前端不该一直挂「发送中」
      store.setDelivered(conv, tailSeq)
      return { ok: true, silent: true, why: decision.why }
    }

    // 注意：没被选中的人**不推进游标**。
    // 推了就等于替她把别人的话"当成已读"吞掉，结果是她永远不知道群里发生过什么，
    // 三个人退化成各自跟你单聊。留着游标，她下次开口时会补上这一整段。
    // （补的时候有上限，见 speak 里的 slice(-40)）
    const speakers = decision.speakers.map((s) => s.roleId)

    let myToken = store.acquire(conv)
    if (!myToken) {
      return { ok: false, error: '这一轮还在跑，等她说完了再发' }
    }
    // 卡死兜底：模型不回话不能把整个会话锁一辈子。
    // 令牌跟着走，真到点了也只解这一把，不会误伤下一轮。
    armGuard(conv, myToken)

    try {
      let first = true
      for (const s of decision.speakers) {
        if (!first) {
          // 第二个说话的人必须等第一个说完：等锁被 flushTurn 释放。
          // 之后再晾 2.5~6 秒 —— 400ms 轮询一解锁就抢话，看着像两个人同时扑上来，
          // 真人接话不会这么快。
          await waitUnlock(conv, 120_000)
          await sleep(2500 + Math.random() * 3500)
          const t2 = store.acquire(conv)
          if (!t2) {
            writeLog('WARN', `${conv} 换人时锁又被占了，这轮说一个就停`)
            break
          }
          myToken = t2
          armGuard(conv, myToken)
        }
        const ok = await speak(conv, s.roleId, s.reason, 'reply', myToken)
        if (!ok) {
          // 谁失败都得把锁还回去。原来这里写的是 `!ok && first` —— 第二个人失败时
          // 没人还锁，整个群卡在「正在输入」，要等六分钟看门狗来摘（文档 10.7）。
          endTurn({ conv, token: myToken })
          if (first) return { ok: false, error: '投递失败，看日志' }
          writeLog('WARN', `${conv} 第二个人没接上，这轮就说到这儿`)
          return { ok: true, speakers, why: decision.why, partial: true }
        }
        first = false
      }
      return { ok: true, speakers, why: decision.why }
    } catch (err) {
      endTurn({ conv, token: myToken })
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  function waitUnlock(conv, timeoutMs) {
    const started = Date.now()
    return new Promise((resolve) => {
      const tick = () => {
        if (!store.isLocked(conv) || Date.now() - started > timeoutMs) resolve()
        else setTimeout(tick, 400)
      }
      tick()
    })
  }

  /**
   * 挑一个"憋不住"的人。规则和 QQ 那边对齐：
   *   群里安静够久 → 看每个人情绪分 → 过阈值且不在冷却里的，挑分最高的一个。
   */

  function pickByMood(lastMessageAt, now = Date.now()) {
    // ① 今天说够了就不说了
    if (mood.todayCount() >= config.maxPerDay) return null
    // ② 静默时段（比如凌晨）一律不主动
    try {
      if (inQuietHours(now, config.quietHours)) return null
    } catch {
      /* 配置写坏了就当没设 */
    }
    // ③ 全局冷却：不管是谁，刚刚有人开过口就都先歇着 ——
    //    只按人算冷却的话，三个人会轮流冒出来，感觉像被轮番打扰
    if (mood.globalCooldownLeft(now) > 0) return null
    // 这里原来还有一道「她说完晚安就静音」的闸门，2026-11-27 整条删掉了。
    // 判断挂在「谁收尾」上太脆：她说完晚安他一回，静音就没了；他不回，反而锁七小时。
    // 现在只靠全局冷却和每日额度管着。
    const quietFor = (now - lastMessageAt) / 60000
    if (quietFor < config.impulseQuietMin) return null
    // 安静越久，越该有人冒个泡 —— impulse.mjs 并进来之后只剩这一条职责。
    // 硬门槛（不足 impulseQuietMin 不开口）上面的 if 已经挡了，这里算的是「过了门槛之后再加多少」。
    const bonus = quietBonus(quietFor, {
      freeMin: config.impulseQuietMin,
      fullMin: config.quietBonusFullMin,
      maxBonus: config.quietBonusMax,
    })
    const candidates = []
    for (const role of config.roles) {
      // 冷却倍率（被晾 1/2/3 次 → ×2/×4/×8）2026-11-27 先摘掉了，实测一段时间再决定要不要接回来。
      // 原来连着被晾三次就是 6 小时不主动，比每日额度还狠。
      const cd = config.impulseCooldownMin * 60000
      if (now - mood.lastSpokeAt(role.id) < cd) continue
      const base = mood.score(role.id)
      // 轮空补偿：连着几轮别人开口、她没轮上，这次把她往上抬一档。
      // 惩罚那一半已经由冷却管着（刚说完的人根本进不了池），这里补的是另一半 ——
      // 光有惩罚的话，涨得最慢的那个（想念倍率 0.9）会长期排第三，一次都轮不到。
      const missed = mood.missedOf(role.id)
      const factor = 1 + Math.min(config.missedBonusMax, missed) * config.missedBonusStep
      const sc = Math.round((base + bonus) * factor)
      if (sc < config.impulseThreshold) continue
      const d = mood.dominantOf(role.id)
      candidates.push({ roleId: role.id, score: sc, base, bonus, missed, factor, why: d.label })
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.score - a.score)
    // 按开口分加权抽签，不取最高。
    //
    // 取最高的后果：三个人分数都顶到同一个上限时是平手，比较用的是严格大于，
    // 结果永远落到角色表第一个 —— 模拟一天 8 次，角色一 5 次、角色二 3 次、角色三 0 次。
    // 抽签让「分高的更常开口」变成概率问题，而不是固定顺序。
    const total = candidates.reduce((sum, c) => sum + Math.max(0, c.score), 0)
    if (total <= 0) return candidates[0]
    let r = Math.random() * total
    for (const c of candidates) {
      r -= c.score
      if (r <= 0) return c
    }
    return candidates[candidates.length - 1]
  }

  /**
   * 撤回：还在 4.5 秒合并窗口里，就当没说过 —— 从这一批里摘掉，
   * 投给模型的内容回退到剩下最后一条。窗口外只标记成"已撤回"，
   * 她那边看到的是原文 —— 不做双向撤回，防手滑够用了。
   */
  function recallMessage(seq) {
    let inWindow = false
    for (const [conv, slot] of mergeBuf.entries()) {
      const i = slot.seqs.indexOf(Number(seq))
      if (i >= 0) {
        slot.seqs.splice(i, 1)
        slot.count = Math.max(0, slot.count - 1)
        inWindow = true
        // 撤掉的那条要是正好是「最后一句」，得把 lastText / lastImage 换成剩下里的最后一条。
        // 不回退的话，协调器还是拿撤回的那句判点名、判挑逗，模型也照样看得到。
        slot.items = slot.items.filter((x) => x.seq !== Number(seq))
        const rest = [...slot.items].reverse()
        const restText = rest.find((x) => x.text !== '')
        const restImg = rest.find((x) => x.image !== '')
        slot.lastText = restText ? restText.text : ''
        slot.lastImage = restImg ? restImg.image : ''
        writeLog('INFO', `撤回命中窗口：${conv} 少投 1 条`)
        // 窗口里只剩这一条 → 整批取消，别投空
        if (slot.count === 0 && slot.timer) {
          clearTimeout(slot.timer)
          mergeBuf.delete(conv)
          writeLog('INFO', `${conv} 这批撤空了，不投递`)
        }
        break
      }
    }
    const ok = store.recall(seq)
    return ok ? { ok: true, inWindow } : { ok: false, error: '撤不了（只能撤自己发的）' }
  }

  /** 被点名的人接一句。和 onUserMessage 里的投递是同一套，只是不记账成"用户消息"。 */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /**
   * 群里最近 ms 毫秒内有没有人说过话。
   *
   * 心跳安排开口是「两分钟后再发」，安排的那一刻确实没人说话 ——
   * 但等着的这段时间里，另一个机制（问候 / 自发 / 你发消息）可能已经抢先了。
   * 所以定时器真正触发时要再查一次，不然两个人会前后脚各说一句，
   * 内容还撞车（实测 03:32 角色二和角色一都说了「快下课了吧」）。
   */
  function spokeRecently(ms) {
    const last = store.byConv('group', 1)
    return last.length > 0 && Date.now() - last[last.length - 1].at < ms
  }

  /**
   * 心跳叫起来的那几种，语气和「回你一句话」不一样：
   * 问候是「到点了」，自发是「我自己想开口」。传错 mode 她就会
   * 拿"下面是你没看到的消息"这种口吻开场，读着像个机器。
   */
  function greetLabelOf(reason) {
    const w = String(reason || '').replace(/^问候·/, '')
    if (w.startsWith('07')) return '早上好'
    if (w.startsWith('11')) return '中午好'
    if (w.startsWith('18')) return '晚上好'
    return '打个招呼'
  }

  function modeOfReason(reason) {
    const r = String(reason || '')
    if (r.startsWith('问候')) return 'greeting'
    if (r.startsWith('自发')) return 'spontaneous'
    return 'reply'
  }

  async function replyAs(conv, roleId, reason) {
    const token = store.acquire(conv)
    if (!token) {
      writeLog('INFO', `${conv} 正忙，${roleId} 这声先欠着`)
      return
    }
    armGuard(conv, token)
    const ok = await speak(conv, roleId, reason, modeOfReason(reason), token)
    if (!ok) endTurn({ conv, token })
  }

  /* ── 心跳：没人说话时，看看谁憋不住了 ───────────────────────── */

  /** 一天里该主动问好的时段。窗口内只问一次，概率另算。 */
  const GREET_WINDOWS = ['07:00-09:00', '11:30-13:00', '18:00-20:00']
  /**
   * 已经问过好的「日期:窗口」，跨天自动失效。
   *
   * 落盘在 dataDir/greeted.json。只在内存里的话，一重启就忘 ——
   * 同一个窗口当天会再问一次（11-25 中午就撞过：11:30 问过，11:47 重启后又问）。
   */
  const greetedPath = join(config.dataDir, 'greeted.json')
  let greetedKeys = new Set()

  function loadGreeted(now = Date.now()) {
    const today = dayKey(now)
    greetedKeys = new Set()
    try {
      if (!existsSync(greetedPath)) return
      const raw = JSON.parse(readFileSync(greetedPath, 'utf8'))
      for (const k of Array.isArray(raw) ? raw : []) {
        // 昨天及更早的直接丢掉，留着只会越来越大
        if (typeof k === 'string' && k.startsWith(`${today}:`)) greetedKeys.add(k)
      }
    } catch {
      /* 读坏了就当今天还没问过 */
    }
  }

  function markGreeted(key, now = Date.now()) {
    const today = dayKey(now)
    for (const k of [...greetedKeys]) if (!k.startsWith(`${today}:`)) greetedKeys.delete(k)
    greetedKeys.add(key)
    // 存不上不影响这一次问好，但下次重启会重问一次
    writeFileAtomic(greetedPath, `${JSON.stringify([...greetedKeys], null, 2)}\n`)
  }
  /** 说过但没等到回应的句子，隔一阵她会自己找补 */
  let pendingThread = null

  const toMin = (hm) => {
    const [h, m] = hm.split(':').map(Number)
    return h * 60 + (m || 0)
  }

  /** 现在落在哪个问候窗口里（没有就 null）。 */
  function currentGreetWindow(now) {
    const d = new Date(now)
    const hm = d.getHours() * 60 + d.getMinutes()
    for (const w of GREET_WINDOWS) {
      const [a, b] = w.split('-')
      if (hm >= toMin(a) && hm < toMin(b)) return w
    }
    return null
  }

  let heartbeat = null
  /** 上一次「已经排好了、还没开口」的时间。防同一波里排两个人。 */
  let pendingImpulseAt = 0
  function startHeartbeat() {
    stopHeartbeat()
    heartbeat = setInterval(() => {
      void (async () => {
        try {
          mood.tick()

          // 她说完 25 分钟没人接：记一笔「被忽略」。
          // 文档 4.3 里「恼火跟着涨、想念 +5%」那条，以前只有函数没有调用点，这里补上。
          //
          // 窗口为什么是 25 分钟：原来 5 分钟就记，洗澡、做饭、下楼取快递都不止五分钟，
          // 那不叫被晾，叫「他刚好没看手机」。25 分钟之后还没动静，才算真的没人理。
          // 不设上限 —— 靠下面 ignoredNotified 的 key 去重，同一句话只记一次。
          {
            const nowMs = Date.now()
            for (const role of config.roles) {
              const spoke = mood.lastSpokeAt(role.id)
              if (!spoke) continue
              const waited = nowMs - spoke
              if (waited < 25 * 60_000) continue
              const key = role.id + ':' + spoke
              if (ignoredNotified.has(key)) continue
              // 凌晨到清晨那段不算：那是他在睡觉，不是故意晾着她。
              // 不挡的话，一夜下来恼火顶满、冷却还被翻到 8 倍，早上起来三个人都不理人。
              const h = new Date(nowMs).getHours()
              if (h >= 0 && h < 8) continue
              // 她说完之后，哪个会话里有别人说过话都算「被接住了」——
              // 群里有、或者私聊里有，都行。
              const answered = ['group', `dm:${role.id}`].some((c) =>
                store.byConv(c, 20).some((m) => m.at > spoke && m.from !== role.id),
              )
              if (answered) continue
              ignoredNotified.set(key, 1)
              mood.onIgnoredBy(role.id)
              writeLog('INFO', `${role.id} 说完 ${Math.round(waited / 60_000)} 分钟没人接，记一笔（恼火 +${IGNORED_ANNOYANCE}）`)
            }
            if (ignoredNotified.size > 40) ignoredNotified.clear()
          }

          // 她说完 15 分钟没人接：记「他会想我」和「担心」，不碰恼火。
          // 晚上他去睡了、白天他在忙，都不是"故意不理她"。
          // 恼火由上面 25 分钟那条单独管 —— 先想他，再怨他，别一步到胃。
          {
            const nowMs = Date.now()
            for (const role of config.roles) {
              const spoke = mood.lastSpokeAt(role.id)
              if (!spoke || nowMs - spoke < 15 * 60_000) continue
              const key = role.id + ':' + spoke
              if (anxiousNotified.has(key)) continue
              anxiousNotified.set(key, 1)
              // 凌晨到清晨那段不算：那是他在睡觉，不是不理她
              const h = new Date(nowMs).getHours()
              if (h >= 0 && h < 8) continue
              mood.onUnansweredBy(role.id)
              // 记下她最后那句：下次开口时她可能会自己接回来
              try {
                const last = store.byConv('group', 20).filter((m) => m.from === role.id).pop()
                if (last && String(last.text || '').trim() !== '') {
                  pendingThread = { roleId: role.id, text: String(last.text).slice(0, 60), at: last.at }
                }
              } catch { /* 读不到就算了 */ }
              writeLog('INFO', `${role.id} 等了 ${Math.round((nowMs - spoke) / 60_000)} 分钟没回音，会想他（不算被无视）`)
            }
            if (anxiousNotified.size > 40) anxiousNotified.clear()
          }

          // 每天自动备一份，不用手点
          const today2 = dayKey(Date.now())
          if (lastAutoBackupDay !== today2) {
            lastAutoBackupDay = today2
            void doBackup().catch(() => {})
          }

          if (store.isLocked('group')) return
          // 刚排过一个还没落地，就别再排第二个。不拦的话问候和自发会各排一个人，
          // 五分钟后前后脚开口，内容还撞车（实测早上角色二和角色一都说了「快下课了吧」）。
          if (Date.now() - pendingImpulseAt < 5 * 60_000) return

          const nowMs2 = Date.now()

          // 统一闸门：这几条对「问候」和「自发」都算数。
          // 以前只有 pickByMood 里查，问候走的是另一条路，直接绕过去了 ——
          // 于是刚有人主动说完 15 分钟，问候窗口又派一个人出来。
          // 额度是三个人共享的：有一个人开口过，剩下两个都得等。
          if (mood.todayCount() >= config.maxPerDay) return
          try {
            if (inQuietHours(nowMs2, config.quietHours)) return
          } catch {
            /* 配置写坏了当没设 */
          }
          if (mood.globalCooldownLeft(nowMs2) > 0) return

          // 问候窗口优先于情绪 —— 早上该说早安，不是因为"想他想得受不了"
          const gw = currentGreetWindow(nowMs2)
          if (gw && config.greetingEnabled !== false) {
            const key = `${dayKey(nowMs2)}:${gw}`
            if (!greetedKeys.has(key) && Math.random() < (config.greetingChance ?? 0.35)) {
              markGreeted(key, nowMs2)
              const who = pickGreeter()
              if (who) {
                writeLog('INFO', `问候窗口 ${gw}：让 ${who} 去打个招呼`)
                // 抖动一会儿再发，别整点报时
                const jitter = Math.random() * (config.greetJitterSec ?? 180) * 1000
                pendingImpulseAt = Date.now()
                const t = setTimeout(() => {
                  // 等的这几分钟里可能已经有人先开口了，别撞车
                  if (spokeRecently(90_000)) {
                    writeLog('INFO', `问候窗口 ${gw}：刚有人说过话，这次不打了`)
                    return
                  }
                  void replyAs('group', who, `问候·${gw}`)
                }, jitter)
                if (typeof t.unref === 'function') t.unref()
                return
              }
            }
          }

          const msgs = store.byConv('group', 60)
          const lastAt = msgs.length > 0 ? msgs[msgs.length - 1].at : Date.now()
          const picked = pickByMood(lastAt)
          if (!picked) return
          const scoreText = `${Math.round(picked.base)}`
            + (picked.bonus > 0 ? `+静默${picked.bonus}` : '')
            + (picked.factor > 1 ? `×轮空${picked.factor.toFixed(2)}` : '')
            + `=${Math.round(picked.score)}`
          writeLog('INFO', `心跳：${picked.roleId} 憋不住了（${picked.why} ${scoreText}）`)
          // 开口时间抖一下，不然每次都卡在心跳的整点附近，像定时的
          const lag = Math.random() * (config.impulseJitterSec ?? 120) * 1000
          pendingImpulseAt = Date.now()
          const t2 = setTimeout(() => {
            if (spokeRecently(90_000)) {
              writeLog('INFO', `心跳：${picked.roleId} 本来想开口，刚有人抢先了`)
              return
            }
            void replyAs('group', picked.roleId, `自发·${picked.why}`)
          }, lag)
          if (typeof t2.unref === 'function') t2.unref()
        } catch (err) {
          writeLog('WARN', `心跳出错：${err instanceof Error ? err.message : String(err)}`)
        }
      })()
    }, config.heartbeatSec * 1000)
    if (typeof heartbeat.unref === 'function') heartbeat.unref()
    writeLog('INFO', `心跳已启动：每 ${config.heartbeatSec} 秒看一次谁想说话`)
  }

  /** 该谁去问好：情绪分最高的那个，都一样就随机。 */
  function pickGreeter() {
    let best = null
    for (const r of config.roles) {
      const sc = mood.score(r.id)
      if (!best || sc > best.score) best = { id: r.id, score: sc }
    }
    return best ? best.id : null
  }

  function stopHeartbeat() {
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  }

  /* ── 媒体回调：画图 / 翻唱生成的东西往这儿交 ───────────────── */

  function acceptMedia(item) {
    try {
      const file = String(item?.file ?? '')
      if (file === '' || !existsSync(file)) return null
      // 和 __nchatSink 同一套认人规则：先看她最后在哪个会话调的工具，
      // 没有再退回「最后一次投递」—— 不能按「当前在跑谁」算，那个跟着投递走，
      // 产物出来的时候往往已经换人了。
      const who = mediaTarget()
      const conv = who.conv
      const role = who.roleId || (conv.startsWith('dm:') ? conv.slice(3) : 'role1')
      const ext = (file.split('.').pop() || '').toLowerCase()

      if (item.kind === 'audio') {
        const name = `v-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`
        const audioDir2 = join(config.dataDir, 'audio')
        if (!existsSync(audioDir2)) mkdirSync(audioDir2, { recursive: true })
        // 已经是 mp3 就直接搬，别的地方再转
        if (ext === 'mp3') {
          writeFileSync(join(audioDir2, name), readFileSync(file))
        } else {
          const ff = config.ffmpegPath
          if (!ff || !existsSync(ff)) return null
          execFileSync(ff, ['-y', '-v', 'error', '-i', file, '-c:a', 'libmp3lame', '-b:a', '64k', join(audioDir2, name)], { timeout: 60000 })
        }
        const r = store.append({ conv, from: role, text: String(item.caption || '') })
        store.setAudio(r.msg.id, name)
        writeLog('INFO', `媒体回流：音频 ${name}（${conv}/${role}）`)
        return r.msg
      }

      // 图片：搬进 uploads，当普通上传图处理
      const name = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext || 'png'}`
      if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true })
      writeFileSync(join(uploadDir, name), readFileSync(file))
      const r = store.append({ conv, from: role, text: String(item.caption || ''), image: name })
      writeLog('INFO', `媒体回流：图片 ${name}（${conv}/${role}）`)
      return r.msg
    } catch (err) {
      writeLog('WARN', `媒体回流失败：${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  globalThis.__dshMediaEmit = acceptMedia

  /* ── 起服务 ─────────────────────────────────────────────────── */

  const webRoot = join(import.meta.dirname, '..', 'web')
  const server = startServer({
    port: config.port,
    webRoot,
    audioDir: join(config.dataDir, 'audio'),
    uploadDir,
    memeDir,
    onUpload,
    onRecall: recallMessage,
    onBackup: doBackup,
    onAvatarGet,
    onAvatarSet,
    convList: convs().map((c) => c.id),
    onUserMessage,
    snapshot,
    slim: slimSnapshot,
    messagesAfter,
    archive: archiveAll,
    log: (m) => writeLog('INFO', m),
  })

  // 插件卸载时把服务关掉，不然端口一直占着
  try {
    ctx.effect(() => () => {
      try {
        offSession?.()
      } catch {
        /* ignore */
      }
      stopHeartbeat()
      server.close()
    })
  } catch {
    /* 宿主不支持 effect 就算了 */
  }

  loadGreeted()
  installSink()
  startHeartbeat()

  writeLog('INFO', `webchat 就绪：http://127.0.0.1:${config.port}/`)
}

export default { name: NAME, apply }
