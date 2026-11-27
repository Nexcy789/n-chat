/**
 * 冒烟测试：不启动 DSH，直接加载插件、拿到两个工具、跑只读路径。
 * 不触发真实翻唱（那要几分钟且会真发 QQ）。
 *
 *   node test/smoke.mjs
 */
import { apply, name } from '../index.js'

const tools = new Map()
const ctx = {
  tools: {
    register(def) {
      tools.set(def.name, def)
    },
  },
}

apply(ctx, {})
console.log('[1] 插件 ' + name + ' 注册了 ' + tools.size + ' 个工具：' + [...tools.keys()].join(', '))
if (tools.size !== 2) throw new Error('工具数量不对')

const lib = tools.get('cover_lib')
const libOut = await lib.execute({})
console.log('[2] cover_lib ok=' + libOut.ok)
console.log(String(libOut.message).split('\n').slice(0, 6).join('\n'))
if (!libOut.ok) throw new Error('cover_lib 失败')

const sing = tools.get('cover_sing')
const secOut = await sing.execute({ song: '雨爱' })
console.log('[3] cover_sing 无 start → ok=' + secOut.ok + ' need_section=' + secOut.need_section)
console.log(String(secOut.message).split('\n').slice(0, 5).join('\n'))
if (!secOut.need_section) throw new Error('没走"先给候选段"的分支')

const missing = await sing.execute({ song: '这首歌肯定不存在啊xyz' })
console.log('[4] 不存在的歌 → ok=' + missing.ok + ' | ' + missing.message)
if (missing.ok) throw new Error('不存在的歌居然返回成功')

console.log('\n全部通过')
