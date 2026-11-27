/**
 * 端到端：真跑一次翻唱，但 preview=true 不发送。会占 GPU 几十秒。
 *   node test/e2e.mjs [歌名] [start] [end]
 */
import { apply } from '../index.js'

const tools = new Map()
apply({ tools: { register: (d) => tools.set(d.name, d) } }, {})

const song = process.argv[2] || '雨爱'
const start = Number(process.argv[3] ?? 40)
const end = Number(process.argv[4] ?? 53)

const t0 = Date.now()
const out = await tools.get('cover_sing').execute({ song, start, end, preview: true })
console.log('耗时 ' + Math.round((Date.now() - t0) / 1000) + 's')
console.log('ok=' + out.ok)
console.log(out.message)
