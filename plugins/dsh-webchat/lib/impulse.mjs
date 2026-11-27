/**
 * 静默加成：群里安静了多久，值多少分。
 *
 * 这个文件原来是另一套「想说话冲动」模型 —— 给每个角色记 missing / boredom
 * 两个 0~100 的数，按分钟往上爬（0.55 / 1.2 每分钟），过了 65 就挑人开口，
 * 状态存在 impulse.json 里，和情绪系统各算各的。
 *
 * 2026-11-27 并进情绪系统，因为它和七维有两处重复：
 *   · 它的 missing 就是七维里的「想他」，只是爬得快一点 —— 留一份就够
 *   · 它的 boredom 其实在测「这个群多久没动静了」，这是**场合信号**，
 *     不是她心里的状态，不该和情绪放在同一个分数里比大小
 *
 * 但它有一条直觉是对的，现在缺的就是这个：安静越久，越该有人冒个泡。
 * 原来 index.js 只做了硬门槛（安静不足 12 分钟不许开口），过了 12 分钟之后
 * 安静 12 分钟和安静 3 小时在评分上一模一样。
 *
 * 所以现在它只做一件事：把「安静分钟数」折算成开口评分上的加成。
 * 存状态、落盘、阈值判定全交给 index.js 和 mood-driver，这里只管算。
 */

export const QUIET_DEFAULTS = Object.freeze({
  /** 安静不到这么久，一点都不加（和 impulseQuietMin 对齐，那边是硬门槛） */
  freeMin: 12,
  /** 安静到这么久，加成拉满 */
  fullMin: 180,
  /** 拉满时加多少分。0 = 关掉这个机制 */
  maxBonus: 20,
})

/**
 * @param {number} quietMin 群里安静了多少分钟
 * @param {{freeMin?:number, fullMin?:number, maxBonus?:number}} [opts]
 * @returns {number} 要加到开口评分上的分（0 ~ maxBonus 的整数）
 */
export function quietBonus(quietMin, opts = {}) {
  const freeMin = Number.isFinite(Number(opts.freeMin)) ? Number(opts.freeMin) : QUIET_DEFAULTS.freeMin
  const fullMin = Number.isFinite(Number(opts.fullMin)) ? Number(opts.fullMin) : QUIET_DEFAULTS.fullMin
  const maxBonus = Number.isFinite(Number(opts.maxBonus)) ? Number(opts.maxBonus) : QUIET_DEFAULTS.maxBonus
  if (maxBonus <= 0) return 0

  const m = Number(quietMin)
  if (!Number.isFinite(m) || m <= freeMin) return 0

  // freeMin 到 fullMin 之间线性涨，之后封顶。
  // fullMin 小于 freeMin 属于配置写反了，按「一过门槛就满额」处理，别除出负数。
  const span = fullMin - freeMin
  const k = span > 0 ? Math.min(1, (m - freeMin) / span) : 1
  return Math.round(k * maxBonus)
}
