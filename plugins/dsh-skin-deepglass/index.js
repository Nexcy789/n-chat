/**
 * dsh-skin-deepglass —— 宿主半侧（空实现）。
 *
 * 皮肤完全是浏览器侧的事：client.js 往页面里插一段 <style>，覆盖 DSH 的深色
 * token 和两个容器的绘制方式。这里不注册工具、不订阅事件，只是为了满足
 * cordis bundle 的 entry 约定（cordis.patch.yml 里 insert 的那一行需要一个模块）。
 */
export const name = 'dsh-skin-deepglass'

/** 不依赖任何宿主服务。 */
export const inject = []

export function apply() {}
