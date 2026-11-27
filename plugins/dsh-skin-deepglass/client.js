/**
 * dsh-skin-deepglass —— 浏览器半侧。
 *
 * 做什么
 *   1) 在 body 上铺两层缓慢漂移/呼吸的径向光晕（纯 CSS 动画，GPU 合成）；
 *   2) 把主区容器（frame / conversation root）的背景清成透明，让光晕透上来；
 *   3) 输入框卡片和用户消息气泡换成毛玻璃（半透明 + backdrop-filter + 上沿高光）。
 *
 * 为什么必须清背景
 *   DSH 的 .pI_x6G_frame / .wSkVaW_root 都画了一层不透明的 --dsw-alias-bg-base。
 *   不清掉，光晕被盖在下面，backdrop-filter 也采样不到东西，玻璃就是个死色块。
 *
 * 为什么不用祖先加 filter
 *   backdrop-filter / filter / transform 会给元素创建 backdrop root。只要给输入框的
 *   任一祖先（composerSeat 之类）加滤镜，内部卡片的 backdrop-filter 就只能采样到
 *   祖先内部，玻璃立刻退化成实色。所以玻璃只加在卡片自己身上。
 *
 * 维护
 *   下面 PROBE 里的类名是 DSH 构建产物的 CSS Modules 哈希（uV2eYG / Sixlwa / wSkVaW…）。
 *   DSH 一升级它们大概率会变，表现是"皮肤只剩光晕、玻璃没了"。到时候只要把 PROBE
 *   的值改成新哈希即可，别处不用动。查新哈希的办法：在浏览器里 devtools 选中输入框
 *   卡片，看 class 名里 `_card` 前面的那段 6 位前缀。
 */

window.__ModuleLoader__.load({
  id: 'dsh-skin-deepglass',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** 归属 id：必须等于模块注册 id，宿主按同一个 id 认领/摘除 style 标签。 */
    const PLUGIN_ID = 'dsh-skin-deepglass'
    const STYLE_KEY = PLUGIN_ID + '/skin'

    /**
     * 依赖的构建哈希。升级 DSH 后如果玻璃失效，只改这里。
     *  - composerCard：输入框卡片（背景 var(--dsw-specific-input-major)）
     *  - userBubble  ：用户消息气泡（背景 var(--dsw-specific-bubble)）
     *  - composerSeat：输入区座位（active 态有一层不透明渐变遮罩，会糊住玻璃）
     *  - frameRoot   ：最外层 grid 容器（画了不透明的 bg-base）
     *  - convoRoot   ：会话列容器（同上）
     *  - sidebarCol  ：侧栏外层列（实色 sidebar-fill + 右分割线）
     *  - sidebarRoot ：侧栏内层（又铺了一层 sidebar-fill）
     *  - schedulePage：自动化任务面板的根容器（整页铺 bg-base，点开就是一块实色）
     *  - browserRoot / previewFrame：侧栏里网页 / 文档预览的视图根（同样铺 bg-base）
     */
    const PROBE = {
      composerCard: 'uV2eYG_card',
      userBubble: 'Sixlwa_bubble',
      composerSeat: 'wSkVaW_composerSeat',
      frameRoot: 'pI_x6G_frame',
      convoRoot: 'wSkVaW_root',
      bottomRow: 'pI_x6G_bottomRow',
      centerCol: 'pI_x6G_centerCol',
      sidebarCol: 'pI_x6G_sidebarCol',
      sidebarRoot: 'hHd-Xa_root',
      schedulePage: 't-XoWW_page',
      browserRoot: 'SB_kFW_root',
      browserFrame: 'SB_kFW_frame',
      previewFrame: 'HyIruq_frame',
    }

    /** 配色：深空玻璃。 */
    const C = {
      base: '#0f1115',
      glass: 'rgba(38,42,52,.54)',
      glassBlur: '20px',
      glassSat: '160%',
      bubbleBlur: '16px',
      bubbleSat: '155%',
      sidebarGlass: 'rgba(11,13,18,.58)',
      sidebarBlur: '24px',
      sidebarSat: '150%',
      line: 'rgba(255,255,255,.12)',
      hilite: 'rgba(255,255,255,.22)',
      shade: 'rgba(0,0,0,.35)',
      blue: '86,134,254',
      cyan: '45,200,235',
      slate: '52,65,91',
    }

    /** 深色作用域：只在 body[data-ds-dark-theme] 下生效，切回浅色就是原版。 */
    const D = `body[data-ds-dark-theme]`

    const CSS = `
/* ==========================================================================
   dsh-skin-deepglass — 深空玻璃
   只在深色模式生效；不改变任何布局尺寸、间距、栅格。
   ========================================================================== */

${D}{
  background-color: ${C.base} !important;
  --dsk-glass-fill: ${C.glass};
  --dsk-line: ${C.line};
  --dsk-hilite: ${C.hilite};
  --dsk-shade: ${C.shade};
}

/* --------------------------------------------------------------------------
   1. 动态极光背景
   两层分工：::before 负责"四处移动"（3 个光斑整体缓慢漂移），
   ::after 负责"缩小放大"（一个大柔光做呼吸）。两层周期分别是 72s / 53s，
   互质，所以重叠出来的轨迹长时间不重复，看着像自然起伏而不是机械循环。
   z-index:-1 让它落在 body 背景色之上、页面内容之下，不必动 #root 的层叠。
   -------------------------------------------------------------------------- */
${D}::before{
  content: "";
  position: fixed;
  inset: -25vmax;
  z-index: -1;
  pointer-events: none;
  background:
    radial-gradient(32vmax 32vmax at 72% 12%, rgba(${C.blue},.32) 0%, rgba(${C.blue},0) 58%),
    radial-gradient(26vmax 26vmax at 10% 80%, rgba(${C.cyan},.13) 0%, rgba(${C.cyan},0) 62%),
    radial-gradient(40vmax 40vmax at 42% 52%, rgba(${C.slate},.42) 0%, rgba(${C.slate},0) 68%),
    radial-gradient(30vmax 30vmax at 62% 88%, rgba(${C.blue},.20) 0%, rgba(${C.blue},0) 60%);
  transform: translate3d(0,0,0);
  will-change: transform;
  animation: dsk-drift 72s cubic-bezier(.45,0,.55,1) infinite;
}

${D}::after{
  content: "";
  position: fixed;
  left: 50%;
  top: 64%;
  width: 104vmax;
  height: 104vmax;
  margin: -52vmax 0 0 -52vmax;
  z-index: -1;
  pointer-events: none;
  background: radial-gradient(circle, rgba(${C.blue},.13) 0%, rgba(${C.blue},0) 54%);
  will-change: transform, opacity;
  animation: dsk-breathe 53s cubic-bezier(.45,0,.55,1) infinite;
}

@keyframes dsk-drift{
  0%   { transform: translate3d(0,0,0) scale(1); }
  18%  { transform: translate3d(5%,3%,0) scale(1.04); }
  37%  { transform: translate3d(8%,-4%,0) scale(1.08); }
  54%  { transform: translate3d(1%,-7%,0) scale(1.03); }
  73%  { transform: translate3d(-6%,-2%,0) scale(1.06); }
  88%  { transform: translate3d(-3%,5%,0) scale(1.02); }
  100% { transform: translate3d(0,0,0) scale(1); }
}

@keyframes dsk-breathe{
  0%   { transform: scale(.86); opacity: .55; }
  30%  { transform: scale(1.08); opacity: .85; }
  55%  { transform: scale(.94); opacity: .62; }
  78%  { transform: scale(1.12); opacity: .78; }
  100% { transform: scale(.86); opacity: .55; }
}

@media (prefers-reduced-motion: reduce){
  ${D}::before, ${D}::after{ animation: none; }
}

/* --------------------------------------------------------------------------
   2. 让光晕透上来：把画了不透明底色的层容器清空。
   这一批是"页面级容器"——它们铺的是整块 bg-base，不清掉光晕就全被压在下面。
   局部元素（工具卡片、附件缩略图、遮罩、下拉框）故意不碰，那些地方需要
   实色来托住文字。
   -------------------------------------------------------------------------- */
${D} .${PROBE.frameRoot},
${D} .${PROBE.centerCol},
${D} .${PROBE.convoRoot},
${D} .${PROBE.bottomRow},
${D} .${PROBE.schedulePage},
${D} .${PROBE.browserRoot},
${D} .${PROBE.browserFrame},
${D} .${PROBE.previewFrame}{
  background: transparent !important;
}

/* 第三方插件的面板不走类名，配色直接写在 style 属性里（ebbinghaus-memory 的
   "记忆"面板就是这样：C.bg = var(--dsw-alias-bg-base)）。类名选择器够不着，
   改 token 又会连带伤到工具卡片那些局部元素，所以由 JS 扫出这些元素、打上
   data-dsk-flat，再用一条规则统一清背景。 */
${D} [data-dsk-flat]{
  background: transparent !important;
}

/* --------------------------------------------------------------------------
   2b. 侧栏 → 同一套玻璃
   原来两层都铺不透明的 --dsw-specific-sidebar-fill（深色 #1b1b1c），主区透光
   而侧栏不透，接缝处就是一道硬边，这就是"割裂"的来源。
   玻璃只加在外层列上、内层清成透明 —— 两层都挂 backdrop-filter 会叠加模糊，
   背景被糊两遍，又费一层合成。
   -------------------------------------------------------------------------- */
${D} .${PROBE.sidebarCol}{
  background: ${C.sidebarGlass} !important;
  -webkit-backdrop-filter: blur(${C.sidebarBlur}) saturate(${C.sidebarSat});
  backdrop-filter: blur(${C.sidebarBlur}) saturate(${C.sidebarSat});
  border-right: .5px solid rgba(255,255,255,.07) !important;
  box-shadow: inset -1px 0 0 rgba(0,0,0,.35), inset -24px 0 40px -34px rgba(0,0,0,.9);
}

${D} .${PROBE.sidebarRoot}{
  background: transparent !important;
}

/* --------------------------------------------------------------------------
   3. 输入框卡片 → 毛玻璃
   原样式：background:var(--dsw-specific-input-major) + box-shadow:var(--dsw-elevation-soft)
   换成半透明底 + 背后模糊，描边改用「0.5px 外线 + 内侧上沿高光 + 内侧下沿暗边」，
   深色下阴影几乎看不见，玻璃的立体感八成靠这条上沿高光。
   -------------------------------------------------------------------------- */
${D} .${PROBE.composerCard}{
  background: var(--dsk-glass-fill) !important;
  -webkit-backdrop-filter: blur(${C.glassBlur}) saturate(${C.glassSat});
  backdrop-filter: blur(${C.glassBlur}) saturate(${C.glassSat});
  box-shadow:
    0 0 0 .5px var(--dsk-line),
    inset 0 1px 0 var(--dsk-hilite),
    inset 0 -1px 0 var(--dsk-shade),
    0 18px 40px -20px rgba(0,0,0,.75) !important;
}

/* --------------------------------------------------------------------------
   4. 用户消息气泡 → 毛玻璃（比输入框薄一档，避免整屏都是重玻璃）
   -------------------------------------------------------------------------- */
${D} .${PROBE.userBubble}{
  background: var(--dsk-glass-fill) !important;
  -webkit-backdrop-filter: blur(${C.bubbleBlur}) saturate(${C.bubbleSat});
  backdrop-filter: blur(${C.bubbleBlur}) saturate(${C.bubbleSat});
  box-shadow:
    0 0 0 .5px var(--dsk-line),
    inset 0 1px 0 var(--dsk-hilite),
    0 10px 24px -16px rgba(0,0,0,.7);
}

/* --------------------------------------------------------------------------
   5. 会话进行中，输入区座位上有一条从透明渐到不透明 bg-base 的遮罩，
   会把卡片下半截后面的光晕整个盖死。改成同色但半透明，保留"消息淡出"的
   作用，又不至于变成一块实心板。
   -------------------------------------------------------------------------- */
${D} .${PROBE.convoRoot}[data-phase=active] .${PROBE.composerSeat},
${D} .wSkVaW_embeddedBody[data-content-phase=active] .${PROBE.composerSeat}{
  background: linear-gradient(
    180deg,
    rgba(15,17,21,0) 0px,
    rgba(15,17,21,.78) 100%
  ) !important;
}

/* --------------------------------------------------------------------------
   6. 兜底：不支持 backdrop-filter 的环境（老 WebView / 关了 GPU 合成）
   退回不透明底 —— 至少不会出现"半透明脏块"。
   -------------------------------------------------------------------------- */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))){
  ${D} .${PROBE.composerCard}{
    background: rgba(38,42,52,.94) !important;
  }
  ${D} .${PROBE.userBubble}{
    background: rgba(38,42,52,.92) !important;
  }
}
`

    /**
     * 插入 / 更新样式表。
     *
     * 必须先打 data-plugin 标记：宿主的客户端模块系统在工厂体跑完后会 claimStyles，
     * 把当时所有"无主"的 style 认到刚物化的模块名下，之后那个模块一变更就被连标签
     * 删掉（dsh-meme issue #32 踩过这个坑，表现是样式整块消失、重启才好）。
     * 预标记的标签不会被认领。
     */
    function apply() {
      if (typeof document === 'undefined') return

      const selector = 'style[data-plugin-css="' + STYLE_KEY + '"]'
      const existing = document.querySelector(selector)
      const el = existing || document.createElement('style')

      if (!existing) {
        el.setAttribute('data-plugin', PLUGIN_ID)
        el.setAttribute('data-plugin-css', STYLE_KEY)
      }
      el.textContent = CSS

      if (!existing) document.head.appendChild(el)

      startFlatWatcher()
    }

    /* ==========================================================================
       内联样式面板兜底
       --------------------------------------------------------------------------
       官方组件走 CSS Modules，能按类名覆盖；第三方插件常把配色写成内联 style。
       ebbinghaus-memory 的"记忆"面板就是：根容器 background 直接写
       var(--dsw-alias-bg-base)，一块不透明底，点开就盖住整个背景。
       这类元素点不了名（类名是人家起的，还会变），但它们的 style 属性里引用的
       token 名是固定的，扫这个比猜类名稳。

       只认"直接引用 bg-base"的元素：内部卡片用的是 bg-layer-*，不会被误伤。
       ========================================================================== */
    const FLAT_ATTR = 'data-dsk-flat'
    const FLAT_MATCH = '[style*="--dsw-alias-bg-base"]'
    /**
     * 高度门槛。同样是内联 bg-base，dsh-qq-bot 那个面板里的**输入框**也命中
     * （width:100% + border）；把输入框清成透明会露出底下，显得空。
     * 面板根容器都是整块撑满的，160px 能干净地把两类分开。
     */
    const FLAT_MIN_HEIGHT = 160

    /** 标记一个元素；返回是否已定性（true = 已处理或确认不该处理）。 */
    function settleFlat(el) {
      if (el.hasAttribute(FLAT_ATTR)) return true
      if (el.getBoundingClientRect().height >= FLAT_MIN_HEIGHT) {
        el.setAttribute(FLAT_ATTR, '')
        return true
      }
      return false
    }

    /** 刚插入时可能还没布局（高度 0），这一批等下一拍再判一次；最多三次，避免长驻定时器。 */
    const flatRetry = new Map()
    let flatRetryTimer = 0

    function scheduleRetry() {
      if (flatRetryTimer || !flatRetry.size) return
      flatRetryTimer = setTimeout(() => {
        flatRetryTimer = 0
        const batch = [...flatRetry]
        flatRetry.clear()
        for (const [el, tries] of batch) {
          if (!el.isConnected) continue
          if (!settleFlat(el) && tries > 1) flatRetry.set(el, tries - 1)
        }
        if (flatRetry.size) scheduleRetry()
      }, 400)
    }

    /** 给 root 自身和后代里引用了 bg-base 的元素定性。 */
    function markFlat(root) {
      if (!root || root.nodeType !== 1) return
      try {
        if (root.matches(FLAT_MATCH) && !settleFlat(root)) flatRetry.set(root, 3)
        const list = root.querySelectorAll(FLAT_MATCH)
        for (let i = 0; i < list.length; i += 1) {
          if (!settleFlat(list[i])) flatRetry.set(list[i], 3)
        }
        scheduleRetry()
      } catch {
        /* 面板卸载过程中拿到的节点可能是残的，跳过 */
      }
    }

    /**
     * 跟着 DOM 走。面板是点开才 new 出来的，apply 那一刻文档里还没有它们。
     * 用 rAF 合批：一次开面板可能插入几百个节点，逐条处理会把主线程钉住。
     */
    let flatObserver = null
    let flatPending = null
    let flatRaf = 0

    function flushFlat() {
      flatRaf = 0
      const batch = flatPending
      flatPending = null
      if (batch) {
        for (const node of batch) markFlat(node)
        batch.clear()
      }
    }

    function startFlatWatcher() {
      markFlat(document.body)
      if (flatObserver || typeof MutationObserver === 'undefined') return

      flatPending = new Set()
      flatObserver = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes') {
            flatPending.add(record.target)
            continue
          }
          for (const node of record.addedNodes) {
            if (node.nodeType === 1) flatPending.add(node)
          }
        }
        if (!flatRaf && flatPending.size) flatRaf = requestAnimationFrame(flushFlat)
      })

      flatObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style'],
      })
    }

    exports.apply = apply
    exports.name = PLUGIN_ID
    exports.inject = []
    exports.__probe = PROBE
    return module.exports
  },
})
