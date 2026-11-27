/**
 * 把一段回复切成几条发出去。
 *
 * 规则和 QQ 那边（dsh-qq-bot/lib/policy.mjs 的 segmentText）保持一致 ——
 * 那套是他 2026-10 连改三轮才定下来的，别在这里另立一套：
 *
 *   切分只认语意，不认字数。
 *   优先级：换行 > 句末标点（。！？!?…~～） > 逗号类（，、；;：:） > 语气词/连词。
 *   前一级切不动才退到下一级。
 *   切完把不到 4 个字的碎片并回前一段（"嗯"不该自己飞出去）。
 *
 * 这里只搬了规则，没搬 QQ 那边的「整条」标记和工作内容识别 ——
 * 聊天界面不是发消息，长段也看得下，暂时不需要那个通道。
 */

/** 硬停顿：换行 + 句末标点。标点跟着前一段。 */
const HARD_BREAK = /[^。！？!?…~～\n]*[。！？!?…~～\n]+|[^。！？!?…~～\n]+$/g

/** 软停顿：逗号、顿号、分号、冒号 —— 一层语意说完的地方。 */
const SOFT_BREAK = /[^，、；;：:,]*[，、；;：:,]+|[^，、；;：:,]+$/g

/** 一点标点都没有时，还能喘气的地方。 */
const PAUSE_WORD = /(?:啊|呀|呢|吧|哦|喔|诶|欸|嘛|啦|咯|耶|然后|但是|不过|所以|而且|因为|其实|就是|反正|可是|结果)/g

function sliceByRegex(body, re) {
  const raw = body.match(re) ?? [body]
  return raw.map((s) => s.trim()).filter((s) => s !== '')
}

function sliceByPauseWord(body) {
  const chars = [...body]
  if (chars.length < 12) return [body]
  const mid = chars.length / 2
  let best = -1
  let bestDist = Infinity
  for (const m of body.matchAll(PAUSE_WORD)) {
    const cut = [...body.slice(0, m.index + m[0].length)].length
    if (cut < 6 || cut > chars.length - 6) continue
    const dist = Math.abs(cut - mid)
    if (dist < bestDist) {
      bestDist = dist
      best = cut
    }
  }
  if (best < 0) return [body]
  return [chars.slice(0, best).join(''), chars.slice(best).join('')]
}

/** 碎段回收：不到 4 个字的一段并进前一段。 */
function mergeTiny(pieces) {
  const out = []
  for (const piece of pieces) {
    if (out.length > 0 && [...piece].length < 4) out[out.length - 1] += piece
    else out.push(piece)
  }
  return out
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function segmentText(text) {
  const body = String(text ?? '').trim()
  if (body === '') return []
  let pieces = sliceByRegex(body, HARD_BREAK)
  if (pieces.length <= 1) pieces = sliceByRegex(body, SOFT_BREAK)
  if (pieces.length <= 1) pieces = sliceByPauseWord(body)
  return mergeTiny(pieces)
}

/**
 * 去掉结尾的句号。只删句号，问号、感叹号、省略号、波浪号都是语气，动了就变味。
 * @param {string} text
 * @returns {string}
 */
export function stripTrailingPeriod(text) {
  let out = String(text ?? '').replace(/\s+$/u, '')
  if (out === '') return out
  if (out.endsWith('。')) return out.replace(/。+$/u, '').replace(/\s+$/u, '')
  if (out.endsWith('.') && !out.endsWith('...')) return out.slice(0, -1).replace(/\s+$/u, '')
  return out
}

/**
 * 一次切好、去掉空段、去掉尾句号。
 * @param {string} text
 * @returns {string[]}
 */
export function splitReply(text) {
  return segmentText(text)
    .map(stripTrailingPeriod)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}
