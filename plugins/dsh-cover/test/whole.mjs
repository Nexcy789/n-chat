/**
 * 整首模式：真跑一遍，preview=true 不发 QQ。约 80~120 秒，会占 GPU。
 *   node test/whole.mjs [歌名]
 */
import { apply } from '../index.js'

const tools = new Map()
apply({ tools: { register: (d) => tools.set(d.name, d) } }, {})

const song = process.argv[2] || '雨爱'
const t0 = Date.now()
const out = await tools.get('cover_sing').execute({ song, whole: true, preview: true })
console.log('墙钟 ' + Math.round((Date.now() - t0) / 1000) + 's')
console.log('ok=' + out.ok)
console.log(out.message)
