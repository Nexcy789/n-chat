/**
 * 协调器：决定这一轮谁说话。
 *
 * 存在的唯一理由：群是个公开场合，三个人都回就是刷屏 + 三倍成本。
 * 私聊不经过这里 —— 只有一个候选，选它就行。
 *
 * 判定顺序（和设计图一致）：
 *   1. 上一条消息里点到谁的名字，谁优先
 *   2. 没人被点名，按每个人的活跃度掷骰
 *   3. 掷中的里面挑情绪分最高的
 *   4. 一个都没掷中 → 这条不回
 *   5. 收尾：别让同一个人连说超过两条；留一点概率让第二个人补一句
 */

/** 上一条消息里提了谁。中文不用整词匹配，角色名本身够独特。 */
export function mentionedRoles(text, roles) {
  if (typeof text !== 'string' || text === '') return []
  const hit = []
  for (const role of roles) {
    for (const name of [role.name, role.id]) {
      if (typeof name === 'string' && name !== '' && text.includes(name)) {
        hit.push(role.id)
        break
      }
    }
  }
  return hit
}

/**
 * @param {object} opts
 * @param {Array<{id:string,name:string}>} opts.roles
 * @param {Record<string, number>} opts.talkativeness 0~1
 * @param {number} opts.mentionBoost 被点名时额外加的概率
 * @param {number} opts.maxConsecutive 同一人最多连说几条
 * @param {number} opts.secondSpeakerChance 第二个人补话的概率
 * @param {(roleId: string) => number} [opts.impulseOf] 情绪分，0~100，用来在同分时排序
 */
export function createCoordinator(opts) {
  const roles = opts.roles
  const talk = opts.talkativeness ?? {}
  const mentionBoost = Number(opts.mentionBoost) || 0
  const maxConsecutive = Number(opts.maxConsecutive) || 2
  const secondChance = Number(opts.secondSpeakerChance) || 0
  /** 点了两个人名时，第二个要不要也接。和上面那个不是一回事：
   *  那个是"掷骰掷出好几个人，随便再放一个"，这个是"你叫了她的名字，她该应"。 */
  const mentionedSecondChance = Number(opts.mentionedSecondChance) || 0.5
  const impulseOf = opts.impulseOf ?? (() => 0)

  /** 数一数末尾连续几条是同一个角色说的。 */
  function trailingRun(messages, roleId) {
    let n = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].from === roleId) n++
      else break
    }
    return n
  }

  /**
   * @param {string} conv 'group' 或 'dm:<roleId>'
   * @param {Array<{from:string,text:string}>} messages 这个会话的全部消息
   * @param {{lastUserText?: string}} [ctx]
   * @returns {{speakers: Array<{roleId:string, reason:string}>, silent: boolean, why: string}}
   */
  /** Fisher-Yates。三个元素用它才不会有偏，sort 里瞎减 0.5 是不均匀的。 */
  function shuffle(arr) {
    const a = arr.slice()
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const t = a[i]
      a[i] = a[j]
      a[j] = t
    }
    return a
  }

  function pick(conv, messages, ctx = {}) {
    // 私聊：只有一个候选，不掷骰
    if (conv.startsWith('dm:')) {
      const roleId = conv.slice(3)
      if (!roles.some((r) => r.id === roleId)) {
        return { speakers: [], silent: true, why: `私聊目标 ${roleId} 不在角色表里` }
      }
      return { speakers: [{ roleId, reason: 'private' }], silent: false, why: '私聊，直接回' }
    }

    const lastUserText = ctx.lastUserText ?? ''

    // @所有人：三个人都接，一人一到两条。排在点名之前判，
    // 因为"所有人"里也可能带着某个角色的名字（"大家都听听角色二怎么说"）。
    if (/(^|[\s，、。])@?所有人|@全体|全部人都在|你们仨|你们三个/.test(lastUserText)) {
      // 顺序打乱。固定成配置里的顺序（角色一→角色二→角色三）每次都一样，
      // 看着像三个人在排队报数，不像抢着说话。
      return {
        speakers: shuffle(roles).map((r) => ({ roleId: r.id, reason: 'all' })),
        silent: false,
        why: '叫了所有人，三个都接',
      }
    }

    const mentioned = mentionedRoles(lastUserText, roles)

    // 1. 被点名的人先接，不受活跃度影响
    if (mentioned.length > 0) {
      const first = mentioned[0]
      // 连说上限只挡"自己主动接着说"，不挡被点名
      const speakers = [{ roleId: first, reason: 'mentioned' }]
      if (mentioned.length > 1 && Math.random() < mentionedSecondChance) {
        speakers.push({ roleId: mentioned[1], reason: 'mentioned-second' })
      }
      return { speakers, silent: false, why: `被点名：${mentioned.join('/')}` }
    }

    // 2. 掷骰
    const rolled = []
    for (const role of roles) {
      const base = Number(talk[role.id] ?? 0.5)
      // 连说超过上限的人这一轮不参与
      if (trailingRun(messages, role.id) >= maxConsecutive) continue
      const p = Math.min(1, base + (mentioned.includes(role.id) ? mentionBoost : 0))
      if (Math.random() < p) rolled.push(role.id)
    }

    if (rolled.length === 0) {
      return { speakers: [], silent: true, why: '一个都没掷中，这条不回' }
    }

    // 3. 掷中的里面挑一个先说。
    //
    // 以前是「情绪分最高的先说」，结果高分的人垄断：被选中 → 说得多 →
    // 情绪分涨得更快 → 下次还是她。2026-11-26 就撞上了，角色一一个人回了一整晚。
    //
    // 现在综合两件事：她此刻多想说（情绪），和她多久没轮到（沉默）。
    // 公式：W = 0.4 × 情绪 + 0.6 × 沉默 + 小抖动
    //   情绪  = 七维最大值 / 100
    //   沉默  = 1 - e^(-距上次开口分钟 / 45)，指数饱和，久的人始终略优但不无敌
    //   抖动  = ±0.05，只够打乱接近的两个人
    // 沉默权重更高，是因为情绪分容易失真（某一维能顶满），而「多久没说话」是硬事实。
    const now = Date.now()
    const lastAt = {}
    for (const m of messages) {
      if (m && m.from !== 'user' && m.at) lastAt[m.from] = m.at
    }
    // 沉默分：十分钟内说过 = 0，之后 50 分钟线性涨到 1（60 分钟封顶）。
    // 试过"按这一轮最久的那位归一化"，不行 —— 三个人都刚说过（5 分钟 vs 7 分钟）
    // 会被放大成 0.71 vs 1.0，情绪分直接被盖掉，最后变成纯轮换。
    // 十分钟以内不算沉默，这才是人话：刚说完的人不该有"我很久没说话了"的优势。
    //
    // 注意 (m - 10) / 50 里的减 10：原来写的是 m / 60，会在 10 分钟那一刻
    // 从 0 直接跳到 0.167，权重凭空多一截。减掉这 10 分钟才是连续的。
    const minsOf = (id) => (lastAt[id] ? Math.max(0, (now - Number(lastAt[id])) / 60_000) : 180)
    const weightOf = (id) => {
      const e = Math.min(1, Math.max(0, (Number(impulseOf(id)) || 0) / 100))
      const m = minsOf(id)
      const silence = m < 10 ? 0 : Math.min(1, (m - 10) / 50)
      return 0.4 * e + 0.6 * silence + 0.02   // +0.02 兜底，别让权重归零
    }
    // 按权重抽，不是排第一。
    // 取最大的话，只要两个人的分差稳定，同一个人会连着被选中 —— 还是垄断。
    // 抽签让「分高的人更常被抽到」变成概率问题，而不是确定结果。
    const pickWeighted = (pool) => {
      const weights = pool.map((id) => weightOf(id))
      const total = weights.reduce((a, b) => a + b, 0)
      if (total <= 0) return pool[Math.floor(Math.random() * pool.length)]
      let r = Math.random() * total
      for (let i = 0; i < pool.length; i++) {
        r -= weights[i]
        if (r <= 0) return pool[i]
      }
      return pool[pool.length - 1]
    }

    const first = pickWeighted(rolled)
    const speakers = [{ roleId: first, reason: 'roll' }]

    // 5. 留一点概率让第二个人补一句。第二个人也从剩下的里面按权重抽。
    const rest = rolled.filter((id) => id !== first)
    if (rest.length > 0 && Math.random() < secondChance) {
      speakers.push({ roleId: pickWeighted(rest), reason: 'second' })
    }

    return { speakers, silent: false, why: `掷中 ${rolled.join('/')}，${first} 先说` }
  }

  return { pick, mentionedRoles: (t) => mentionedRoles(t, roles) }
}
