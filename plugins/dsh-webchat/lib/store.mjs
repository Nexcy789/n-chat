/**
 * 消息流水 + 游标 + 会话映射。
 *
 * 设计上只有一个真相：一条按 seq 递增的群/私聊消息流（chat.jsonl）。
 * 每个"角色 × 会话"记一个游标，表示它读到第几条了。
 * 谁被选中发言，就把游标之后的消息补给它 —— 不重复喂，也不失忆。
 *
 * 用 JSONL 而不是 SQLite：现在量级小（一天几百条），追加写最省事，
 * 出问题能直接打开看。真到几十万条再换。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFileAtomic } from './fsx.mjs'

const CHAT_FILE = 'chat.jsonl'
const STATE_FILE = 'state.json'
const AUDIO_FILE = 'audio-map.json'

export function createStore(dataDir) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })

  const chatPath = join(dataDir, CHAT_FILE)
  const statePath = join(dataDir, STATE_FILE)

  /** @type {Array<{seq:number, id:string, conv:string, from:string, text:string, at:number}>} */
  let messages = []
  let nextSeq = 1

  /** @type {{cursors: Record<string, number>, sessions: Record<string, string>, lock: Record<string, string>, readAt: Record<string, number>, delivered: Record<string, number>}} */
  let state = { cursors: {}, sessions: {}, lock: {}, readAt: {}, delivered: {} }
  /** msgId → 音频文件名。语音是异步生成的，生成完补在这里，前端合并着读 */
  let audioMap = {}
  /**
   * 消息流改了几版。只要有人追加、撤回、配上语音，就 +1。
   *
   * 前端每 1.6 秒拿它问一句「变了没」：没变就不拉全量（一次一百多 KB），
   * 变了才拉。没有这个号，前端只能一直拉全量，手机一小时能吃掉两百多兆。
   */
  let rev = 0

  function load() {
    messages = []
    if (existsSync(chatPath)) {
      const raw = readFileSync(chatPath, 'utf8')
      for (const line of raw.split('\n')) {
        const s = line.trim()
        if (s === '') continue
        try {
          const m = JSON.parse(s)
          if (typeof m?.seq === 'number' && typeof m?.conv === 'string') messages.push(m)
        } catch {
          /* 坏行跳过：宁可少一条，也别因为一行坏了整个历史打不开 */
        }
      }
    }
    nextSeq = messages.length > 0 ? messages[messages.length - 1].seq + 1 : 1

    if (existsSync(join(dataDir, AUDIO_FILE))) {
      try {
        const raw = JSON.parse(readFileSync(join(dataDir, AUDIO_FILE), 'utf8'))
        audioMap = raw && typeof raw === 'object' ? raw : {}
      } catch {
        audioMap = {}
      }
    }

    if (existsSync(statePath)) {
      try {
        const raw = JSON.parse(readFileSync(statePath, 'utf8'))
        state = {
          cursors: raw?.cursors && typeof raw.cursors === 'object' ? raw.cursors : {},
          sessions: raw?.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
          lock: raw?.lock && typeof raw.lock === 'object' ? raw.lock : {},
          readAt: raw?.readAt && typeof raw.readAt === 'object' ? raw.readAt : {},
          delivered: raw?.delivered && typeof raw.delivered === 'object' ? raw.delivered : {},
        }
      } catch {
        /* 读坏了就当空的，不挡启动 */
      }
    }
    // 进程重启了，文件里残留的锁没有主人 —— 全清掉。
    // 不清的话，上次崩溃时没释放的会话会一直显示"正在输入"，消息再也发不进去。
    state.lock = {}

    const lastSeqNow = messages.length > 0 ? messages[messages.length - 1].seq : 0

    // 聊天记录被清空或重建过时，游标会停在比现有最大 seq 还大的位置。
    // 那样 unseen() 永远是空，三个角色从此一句话都不说，还不报错。
    // 所以只要游标越过线了，就整体归零，让她们从头补。
    const maxCursor = Object.values(state.cursors).reduce((a, b) => (Number(b) > Number(a) ? b : a), 0)
    if (Number(maxCursor) > lastSeqNow) {
      console.warn(`[webchat] 游标 ${maxCursor} 超过现有最大 seq ${lastSeqNow}，聊天记录应该是被重置过，游标全部归零`)
      state.cursors = {}
    }

    // 老版本没有 delivered 这个概念：把历史当成已送达，
    // 不然升级后每条老消息都会挂着"发送中"
    if (Object.keys(state.delivered).length === 0) {
      for (const m of messages) {
        if (!state.delivered[m.conv] || m.seq > state.delivered[m.conv]) state.delivered[m.conv] = m.seq
      }
    }

    saveState()
    return messages.length
  }

  function saveState() {
    // 原子写：游标一天要重写上千次，撞上断电就是半截 JSON，读回来当空文件 → 全部失忆
    writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  function append({ conv, from, text, at = Date.now(), image = '', replyTo = 0 }) {
    // text 可能是 undefined（调用方少传一个参数）。JSON.stringify 会把 undefined
    // 的字段整个丢掉，读回来就是 undefined，前端一 .slice 就崩 —— 这里兜住。
    const body = typeof text === 'string' ? text : ''
    const msg = { seq: nextSeq++, id: randomUUID(), conv, from, text: body, at }
    if (image) msg.image = image
    if (replyTo) msg.replyTo = Number(replyTo)
    messages.push(msg)
    rev += 1
    try {
      appendFileSync(chatPath, `${JSON.stringify(msg)}\n`, 'utf8')
    } catch (err) {
      // 落盘失败也要让它出现在内存里，不然界面上会"发了没反应"
      return { msg, persisted: false, error: err instanceof Error ? err.message : String(err) }
    }
    return { msg, persisted: true, error: null }
  }

  /** 某个会话里的全部消息，按 seq 升序。带上音频文件名（有的话）。 */
  function byConv(conv, limit = 500) {
    const out = messages.filter((m) => m.conv === conv)
    const sliced = out.length > limit ? out.slice(out.length - limit) : out
    return sliced.map((m) => (audioMap[m.id] ? { ...m, audio: audioMap[m.id] } : m))
  }

  /** 撤回一条：正文清空、留个标记，历史不改行号。 */
  function recall(seq) {
    const m = messages.find((x) => x.seq === Number(seq))
    if (!m) return false
    if (m.from !== 'user') return false // 只能撤自己发的
    m.text = ''
    m.recalled = true
    rev += 1
    // 整个文件重写一遍（量不大，一天几百条）。
    // 必须原子：写一半断电就是这个群的全部历史没了。
    const body = messages.map((x) => JSON.stringify(x)).join('\n') + '\n'
    return writeFileAtomic(chatPath, body)
  }

  /** 语音生成好了，挂到消息上。 */
  function setAudio(msgId, fileName) {
    if (!msgId || !fileName) return
    audioMap[msgId] = fileName
    rev += 1
    writeFileAtomic(join(dataDir, AUDIO_FILE), `${JSON.stringify(audioMap, null, 2)}\n`)
  }

  /** 某个角色在某个会话里还没看过的消息。 */
  function unseen(roleId, conv) {
    const key = `${conv}:${roleId}`
    const cursor = state.cursors[key] ?? 0
    return messages.filter((m) => m.conv === conv && m.seq > cursor)
  }

  function setCursor(roleId, conv, seq) {
    state.cursors[`${conv}:${roleId}`] = seq
    saveState()
  }

  function cursorOf(roleId, conv) {
    return Number(state.cursors[`${conv}:${roleId}`] ?? 0)
  }

  /** 某个会话「已经送到模型手里」的最大 seq。前端拿它显示已发送 / 发送中。 */
  function setDelivered(conv, seq) {
    const cur = Number(state.delivered[conv] || 0)
    if (Number(seq) <= cur) return
    state.delivered[conv] = Number(seq)
    saveState()
  }

  function deliveredOf(conv) {
    return Number(state.delivered[conv] || 0)
  }

  /** 角色读过但没说话时，也要把游标推上去，否则下次会重复看到。 */
  function maxSeq(conv) {
    let max = 0
    for (const m of messages) if (m.conv === conv && m.seq > max) max = m.seq
    return max
  }

  function getSession(roleId, conv) {
    return state.sessions[`${conv}:${roleId}`] ?? ''
  }

  function setSession(roleId, conv, sessionId) {
    if (sessionId === '') delete state.sessions[`${conv}:${roleId}`]
    else state.sessions[`${conv}:${roleId}`] = sessionId
    saveState()
  }

  /** 会话级发言锁：同一个会话同一时刻只允许一个角色在生成。
   *  返回一个令牌，释放时要带回来 —— 上一轮遗留的超时定时器
   *  如果不带令牌，就会把这一轮刚挂上的锁一起摘掉。 */
  function acquire(conv) {
    if (state.lock[conv]) return ''
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    state.lock[conv] = token
    saveState()
    return token
  }

  /** 只解自己挂的那把。令牌对不上就当没这回事。 */
  function release(conv, token) {
    const held = state.lock[conv]
    if (!held) return false
    if (token && held !== token && held !== true) return false
    delete state.lock[conv]
    saveState()
    return true
  }

  function isLocked(conv) {
    return Boolean(state.lock[conv])
  }

  return {
    load,
    append,
    byConv,
    unseen,
    setCursor,
    cursorOf,
    setDelivered,
    deliveredOf,
    maxSeq,
    getSession,
    setSession,
    acquire,
    release,
    setAudio,
    recall,
    /** 她说到第几条了。只用来判断"她开过口"，不再当已读用 */
    setRead(conv, seq) {
      const cur = Number(state.readAt[conv] || 0)
      if (Number(seq) <= cur) return
      state.readAt[conv] = Number(seq)
      saveState()
    },
    readAt(conv) {
      return Number(state.readAt[conv] || 0)
    },
    isLocked,
    /** 消息流的版本号。前端靠它判断要不要拉全量。 */
    revOf() {
      return rev
    },
    get count() {
      return messages.length
    },
  }
}
