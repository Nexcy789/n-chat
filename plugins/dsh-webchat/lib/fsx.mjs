import { writeFileSync, renameSync, unlinkSync } from 'node:fs'

/**
 * 原子写一个文本文件。
 *
 * 先写同目录的临时文件，再 rename 覆盖目标。
 * rename 在同一分区上是原子操作：要么还是旧文件，要么已经是完整的新文件，
 * 不会出现「写了一半断电」那种半截 JSON。
 *
 * 为什么需要：state.json 每次推游标都全量重写（一天上千次），moods.json 每分钟一次。
 * 直接 writeFileSync 撞上断电或强制结束，文件就是坏的 —— 而 load() 里 catch 到
 * 就当空文件处理，游标全丢、三个角色从头补，表现是「突然失忆」。
 *
 * 失败不抛：状态存不上不该把主流程带崩，调用方按返回值决定要不要记日志。
 *
 * @param {string} path 目标文件
 * @param {string} text 完整内容
 * @returns {boolean} 写成功没有
 */
export function writeFileAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      /* 临时文件可能压根没建出来 */
    }
    return false
  }
}
