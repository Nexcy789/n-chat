/**
 * 情绪驱动层：给每个角色一份独立的七维情绪。
 *
 * 计算全在 mood.mjs 里（从 dsh-alive 原样搬过来的，598 行纯函数，零依赖）——
 * 这边只负责三件事：
 *   1. 每个角色一份状态，落盘到 moods.json，互不干扰
 *   2. 把聊天里发生的事翻译成 mood 模块认识的事件
 *   3. 定时让它随时间自己长
 *
 * 七个维度：想他 / 吃醋 / 暖意 / 担心 / 闲得慌 / 涩涩 / 恼火
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as moodModule from './mood.mjs'
import { writeFileAtomic } from './fsx.mjs'

/** 说甜话的判定。和 alive 那边同一个正则，别自己另写一套。 */
const SWEET_RE = /(喜欢你|爱你|爱你们|想你|抱抱|亲亲|宝贝|乖|心疼|辛苦|宝宝|老婆|媳妇)/

const DEFAULT_CONFIG = {
  moodFillHours: moodModule.DEFAULT_FILL_HOURS,
  moodRates: moodModule.DEFAULT_RATES,
  lust: moodModule.LUST_DEFAULTS,
}

/**
 * 本地日期键。
 *
 * 别用 toISOString().slice(0,10) —— 那是 UTC，北京时间要到早上八点才换天，
 * 每日开口额度会变成「早八点到早八点」。文档 10.7 记的就是这条。
 */
function localDay(now) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function createMoodDriver(opts) {
  const { dataDir, roles } = opts
  const log = opts.log ?? (() => {})
  const cfg = {
    ...DEFAULT_CONFIG,
    ...(opts.config ?? {}),
  }
  // 配置里的倍率要过一遍校验，缺的键补 1
  const rates = moodModule.normalizeRates(cfg.moodRates, {})

  /**
   * 出厂人设：每个人对同一件事的反应速度不一样。
   *
   * 三套数字对应三种性格原型，照着自己角色的 AGENTS.md 改：
   *   角色一   外向、护人。吃醋吃得多但不会真拦，担心和闲涨得快
   *   角色二   慢热、稳。想念涨得快但吃醋极低，暖意来得快也退得慢
   *   角色三   敏感、易炸。吃醋最凶，想念最慢，气也最难消
   *
   * 只写和 1.0 不同的键，其余走全局 moodRates。
   */
  const PERSONA_RATES = {
    role1: { jealousy: 1.3, worry: 1.25, boredom: 1.1, warmthGain: 1, warmthDecay: 1, annoyanceDecay: 1, missing: 1 },
    role2: { missing: 1.15, jealousy: 0.5, warmthGain: 1.15, warmthDecay: 0.75, worry: 1, boredom: 0.85, annoyanceDecay: 0.9 },
    role3: { missing: 0.9, jealousy: 1.5, warmthGain: 0.85, warmthDecay: 1.2, worry: 0.9, boredom: 1.15, annoyanceDecay: 0.75 },
  }

  /** 这个人用哪套速度。配置里显式写了就以配置为准，没写就用出厂人设。 */
  const ratesOf = (roleId) => {
    const own = PERSONA_RATES[roleId] || {}
    const override = (cfg.moodRates && cfg.moodRates[roleId]) || null
    if (override && typeof override === 'object') {
      return moodModule.normalizeRates({ ...rates, ...own, ...override }, {})
    }
    return moodModule.normalizeRates({ ...rates, ...own }, {})
  }
  const fillHours = moodModule.normalizeFillHours(cfg.moodFillHours)
  const lustCfg = moodModule.normalizeLust(cfg.lust, {})

  const path = join(dataDir, 'moods.json')

  /** roleId → { mood, lastTickAt, lastHumanAt, spokeAt, ignored, replied } */
  let state = {}
  /** 全局：任意人最后一次自发开口的时间，以及今天的次数。防三个人轮流轰炸。 */
  let global = { lastSpokeAt: 0, dayKey: '', count: 0, cooldownMin: 0 }

  function blank(now) {
    return {
      mood: moodModule.normalizeMood({}),
      lastTickAt: now,
      lastHumanAt: 0,
      spokeAt: 0,
      /** 连续被忽略的次数：没人接她的话就 +1，有人接就清零。冷却靠它翻倍。 */
      ignored: 0,
      /** 连续被接住的次数，只用来判断"状态好不好"。 */
      replied: 0,
      /** 连续几轮别人开口、她自己没轮上（轮空补偿用，见 index.js 的 pickByMood）。 */
      missed: 0,
    }
  }

  function load() {
    let raw = null
    if (existsSync(path)) {
      try {
        raw = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        raw = null
      }
    }
    const now = Date.now()
    state = {}
    for (const role of roles) {
      const rec = raw?.[role.id]
      state[role.id] = rec
        ? {
            mood: moodModule.normalizeMood(rec.mood ?? {}),
            lastTickAt: Number(rec.lastTickAt) || now,
            lastHumanAt: Number(rec.lastHumanAt) || 0,
            spokeAt: Number(rec.spokeAt) || 0,
            ignored: Number(rec.ignored) || 0,
            replied: Number(rec.replied) || 0,
            missed: Number(rec.missed) || 0,
          }
        : blank(now)
    }
    // 全局状态跟着一起读
    const g = raw?.__global
    if (g && typeof g === 'object') {
      global = {
        lastSpokeAt: Number(g.lastSpokeAt) || 0,
        dayKey: typeof g.dayKey === 'string' ? g.dayKey : '',
        count: Number(g.count) || 0,
        cooldownMin: Number(g.cooldownMin) || 0,
      }
    }
    log(`情绪已载入：${roles.map((r) => r.id).join('/')}`)
  }

  function save() {
    // 原子写：moods.json 每分钟一次，撞上断电就是半截 JSON
    writeFileAtomic(path, `${JSON.stringify({ ...state, __global: global }, null, 2)}\n`)
  }

  /** 时间推进：每人按自己上次的基准往前长。一次最多补 6 小时，防休眠唤醒后暴涨。 */
  function tick(now = Date.now()) {
    const hourOfDay = new Date(now).getHours()
    const today = localDay(now)
    if (global.dayKey !== today) {
      global.dayKey = today
      global.count = 0
      // 新的一天，轮空补偿重新开始 —— 昨天没轮上不该算到今天头上
      for (const role of roles) {
        const s = state[role.id]
        if (s) s.missed = 0
      }
    }
    for (const role of roles) {
      const s = state[role.id]
      if (!s) continue
      const hours = Math.min(6, (now - s.lastTickAt) / 3_600_000)
      if (hours <= 0) {
        if (now < s.lastTickAt) s.lastTickAt = now // 时钟回拨，把基准拉回来
        continue
      }
      const hoursSinceHuman = s.lastHumanAt > 0 ? (now - s.lastHumanAt) / 3_600_000 : Infinity
      try {
        moodModule.evolve(s.mood, hours, {
          hourOfDay,
          hoursSinceQq: hoursSinceHuman,
          rates: ratesOf(role.id),
          fillHours,
          lust: lustCfg,
        })
      } catch (err) {
        log(`情绪演化出错（${role.id}）：${err instanceof Error ? err.message : String(err)}`)
      }
      s.lastTickAt = now
    }
    save()
  }

  /** 他说话了：每个人都"他来了"，说了甜话另算。 */
  function onUserSpoke(now = Date.now(), text = '') {
    const said = typeof text === 'string' ? text : ''
    // 这句话点了谁的名字。点了别人 = 当着她的面关注别人，没被点到的人吃醋。
    // 以前吃醋是跟着「他多久没出现」涨的，那其实是想念，两个人一起爆表没意义。
    const named = roles.filter((r) => r.name && said.includes(r.name)).map((r) => r.id)
    const sweet = SWEET_RE.test(said)

    for (const role of roles) {
      const s = state[role.id]
      if (!s) continue
      s.lastHumanAt = now
      try {
        moodModule.onHeCameBack(s.mood)
        // 甜话只给该听的人。点了名就只哄被点的那位，没点名才是三个人一起。
        if (sweet && (named.length === 0 || named.includes(role.id))) {
          moodModule.onSweetTalk(s.mood, now, { rates: ratesOf(role.id) })
        }
        if (named.length > 0 && !named.includes(role.id)) {
          // 一次点了两个就各算六成，别三个人一起酸。
          // 倍率跟着人设走：角色三最容易炸，角色二基本不吵。
          moodModule.onHePraisedOther(s.mood, named.length >= 2 ? 0.6 : 1, ratesOf(role.id).jealousy)
        }
      } catch {
        /* 单个事件失败不影响整体 */
      }
    }
    save()
  }

  /** 她说完没人接（5 分钟没人理）。恼火 +12，想他 +0.05。 */
  function onIgnoredBy(roleId) {
    const s = state[roleId]
    if (!s) return
    s.ignored += 1
    s.replied = 0
    try {
      moodModule.onIgnored(s.mood)
    } catch { /* ignore */ }
    save()
  }

  /** 她等到硬期限都没人回（15 分钟）。她会急，会委屈，但不会把自己憋哑。 */
  function onUnansweredBy(roleId) {
    const s = state[roleId]
    if (!s) return
    try {
      moodModule.onUnanswered(s.mood)
    } catch { /* ignore */ }
    save()
  }

  /** 被拒绝/被凶了。恼火 +30，暖意清零。 */
  function onRejectedBy(roleId, now = Date.now()) {
    const s = state[roleId]
    if (!s) return
    try {
      moodModule.onRejected(s.mood, now)
    } catch { /* ignore */ }
    save()
  }

  /**
   * 被挑逗了。涩涩那条往上走。**这是第七维唯一的事件入口**（index.js 的 noteTease 调）。
   *
   * 必须把 lust 配置一起传给 onTeased：它自己判 enabled，不传就等于"这一维没开"，
   * 数值一动不动 —— 原来这里只传了 rates，接口写好了却永远是个 no-op。
   *
   * @returns {boolean} 真的动了没有。没动（开关关着 / 已经满格）返回 false，
   *   调用方别记次数、也别打"+25%"的日志。
   */
  function onTeasedBy(roleId, now = Date.now()) {
    const s = state[roleId]
    if (!s) return false
    const beforeLust = s.mood.lust
    const beforePhase = s.mood.lustPhase
    try {
      moodModule.onTeased(s.mood, now, { rates: ratesOf(roleId), lust: lustCfg })
    } catch {
      return false
    }
    if (s.mood.lust === beforeLust && s.mood.lustPhase === beforePhase) return false
    save()
    return true
  }

  /**
   * 冷却倍率：连续被忽略 1 次 → ×2，2 次 → ×4，3 次及以上 → ×8（封顶）。
   *
   * 2026-11-27 从 pickByMood 里摘掉了 —— 连着被晾三次就是 6 小时不主动，比每日额度还狠。
   * 函数留着，等他实测一段时间再决定要不要接回来。
   */
  function cooldownFactor(roleId) {
    const n = Math.min(3, state[roleId]?.ignored ?? 0)
    return Math.pow(2, n)
  }

  /** 某个角色刚说完话。 */
  function onSheSpoke(roleId, now = Date.now(), spontaneous = false) {
    const s = state[roleId]
    if (!s) return
    s.spokeAt = now
    global.lastSpokeAt = now
    // 每次开口现掷一个冷却时长，不写死。
    // 固定时长会让间隔精确得像闹钟（每次都卡在第 100 分钟开口），
    // 真人不会这样 —— 90 到 120 分钟之间浮动比较自然。
    const base = Number(opts.globalCooldownMin) || 105
    global.cooldownMin = Math.round(base * (0.86 + Math.random() * 0.28))
    if (spontaneous) {
      const today = localDay(now)
      if (global.dayKey !== today) {
        global.dayKey = today
        global.count = 0
      }
      global.count += 1
      // 轮空计数：她开口了就清零，另外两个没轮上的 +1。
      // index.js 的 pickByMood 拿它做「这次该轮到谁」的正向补偿 ——
      // 光靠情绪分和冷却，涨得最慢的那个（想念倍率 0.9）会长期排第三，永远轮不到。
      for (const r of roles) {
        const st = state[r.id]
        if (!st) continue
        if (r.id === roleId) st.missed = 0
        else st.missed = Math.min(9, (Number(st.missed) || 0) + 1)
      }
    }
    try {
      moodModule.onReplied(s.mood, { rates: ratesOf(roleId) })
    } catch {
      /* ignore */
    }
    save()
  }

  /** 综合冲动分（0~100）：取最高的那一维。
   *
   * 恼火也算一维，按 60 点折成百分比（annoyancePercent）。
   * 以前这里漏了它，后果是「气得要死也不会先开口」—— 主导情绪判成 sulky、
   * 语气也换成了不高兴，score 却停在 0，永远够不到 55 那道门槛。
   */
  function score(roleId) {
    const s = state[roleId]
    if (!s) return 0
    try {
      const m = s.mood
      const vals = [
        moodModule.percentOf(m.missing),
        moodModule.percentOf(m.jealousy),
        moodModule.percentOf(m.warmth),
        moodModule.percentOf(m.worry),
        moodModule.percentOf(m.boredom),
        moodModule.percentOf(m.lust),
        moodModule.annoyancePercent(m.annoyanceDebt),
      ]
      return Math.max(...vals)
    } catch {
      return 0
    }
  }

  /** 当前主导情绪是什么（想他 / 吃醋 / …），用来解释"她为什么突然开口"。 */
  function dominantOf(roleId) {
    const s = state[roleId]
    if (!s) return { key: 'missing', label: '想他', value: 0 }
    try {
      const d = moodModule.dominant(s.mood, { lust: lustCfg })
      return {
        key: d?.key ?? 'missing',
        label: d?.label ?? moodModule.labelOf(d?.key ?? 'missing'),
        // 0~1 的强度，投递时要说「轻/中/强」，别让模型看百分比
        value: Number(d?.value) || 0,
      }
    } catch {
      return { key: 'missing', label: '想他', value: 0 }
    }
  }

  /** 给模型看的一句话：「你现在想他想得厉害」。 */
  function hintOf(roleId) {
    const s = state[roleId]
    if (!s) return ''
    try {
      return moodModule.moodHintOf(s.mood, { lust: lustCfg }) ?? ''
    } catch {
      return ''
    }
  }

  /** 给界面看的：每人七个百分比。 */
  function snapshot() {
    const out = {}
    for (const role of roles) {
      const s = state[role.id]
      if (!s) {
        out[role.id] = null
        continue
      }
      const m = s.mood
      out[role.id] = {
        missing: moodModule.percentOf(m.missing),
        jealousy: moodModule.percentOf(m.jealousy),
        warmth: moodModule.percentOf(m.warmth),
        worry: moodModule.percentOf(m.worry),
        boredom: moodModule.percentOf(m.boredom),
        lust: moodModule.percentOf(m.lust),
        annoyance: moodModule.annoyancePercent(m.annoyanceDebt),
      }
    }
    return out
  }

  load()
  /** 上次说话的时间戳，冷却判定用。 */
  function lastSpokeAt(roleId) {
    return state[roleId]?.spokeAt ?? 0
  }

  /** 全局冷却还剩多少毫秒（0 = 已经过了）。
   *  时长是上次开口时现掷的那个（global.cooldownMin），没有就用配置基准。 */
  function globalCooldownLeft(now = Date.now()) {
    const min = Number(global.cooldownMin) > 0 ? Number(global.cooldownMin) : Number(opts.globalCooldownMin) || 105
    const left = global.lastSpokeAt + min * 60000 - now
    return left > 0 ? left : 0
  }

  /** 今天自发说了几次。 */
  function todayCount() {
    return global.count
  }

  return {
    load, save, tick, onUserSpoke, onSheSpoke, score, dominantOf, hintOf, snapshot,
    lastSpokeAt, globalCooldownLeft, todayCount,
    onIgnoredBy, onUnansweredBy, onRejectedBy, onTeasedBy, cooldownFactor,
    ignoredCount: (roleId) => state[roleId]?.ignored ?? 0,
    /** 连续几轮没轮上主动开口（轮空补偿的输入）。 */
    missedOf: (roleId) => state[roleId]?.missed ?? 0,
    /** 有人接话了：她的"被忽略"清掉，"被接住"加一。 */
    onAnswered: (roleId) => {
      const s = state[roleId]
      if (!s) return
      s.ignored = 0
      s.replied += 1
      save()
    },
  }
}
