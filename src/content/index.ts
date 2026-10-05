// Content Script - 注入到页面
import type { TextError, UserConfig } from '../shared/types'
import { TextExtractor } from './extractor'
import { TextChecker } from './checker'
import { ErrorMarker } from './marker'
import { getFingerprint } from '../lib/fingerprint'
import { userService } from '../services/user.service'
import { discoveryService, DiscoveryResult } from '../services/discovery.service'
import { squareService } from '../services/square.service'
import './styles.css'
import { createRoot } from 'react-dom/client'
import { ReportPanel } from '../components/ReportPanel'
import { createElement } from 'react'
import { calculateVocabularyStats, VocabularyStats } from './vocabulary-stats'
import idiomDetails from '../data-idiom-details.json'
import { t } from '../lib/i18n'
import { Annotator } from './annotate/annotator'
import { collectBlocks, resetBlockState } from './dom/block'
import { RenderCache } from './dom/traverse'
import { batchBlocks, runConcurrent, yieldToBrowser, BLOCK_CONCURRENCY } from './check/pipeline'
import type { Mark, MarkKind, RegisteredMark } from './dom/types'

class MiaobContent {
  private extractor!: TextExtractor
  private checker!: TextChecker
  private marker!: ErrorMarker
  private annotator = new Annotator()
  private config!: UserConfig
  private debounceTimers: Map<HTMLElement, number> = new Map()
  private pageCheckTimer: number | null = null
  private pageCheckInFlight = false
  private lastPageCheckAt = 0
  private attachedElements: WeakSet<HTMLElement> = new WeakSet()
  private staticCheckedElements: WeakSet<HTMLElement> = new WeakSet()
  /** 所有发现（成语+名句+歇后语） */
  private allFindings: Array<{ kind: string; idiom?: { idiom: string; derivation?: string; explanation?: string }; phrase?: { text: string; type: string; answer?: string; from?: string } }> = []
  /** 阅读报告数据（供面板渲染） */
  private reportData: {
    errors: TextError[]
    idioms: Array<{ idiom: string; derivation?: string; explanation?: string }>
    quotes: Array<{ text: string; from?: string }>
    xiehouyu: Array<{ text: string; answer?: string }>
    expressions: Array<{ type: string; text: string; score?: number }>
    quota?: { remaining: number; isPaid: boolean; used: number; limit: number }
    vocabularyStats?: VocabularyStats
  } = { errors: [], idioms: [], quotes: [], xiehouyu: [], expressions: [] }
  private expressionFindings: Array<{ type: string; text: string; score?: number }> = []
  /** 已登记的发现 key，防止动态页面重复送检时重复计数 */
  private findingKeys = new Set<string>()
  private panelRoot: ReturnType<typeof createRoot> | null = null
  private idiomCard: HTMLElement | null = null
  private idiomTarget: RegisteredMark | null = null
  private hoverTarget: RegisteredMark | null = null
  private idiomHideTimer: number | null = null
  private idiomShowTimer: number | null = null
  private idiomPinned = false
  private idiomRequestId = 0
  private idiomDetailCache = new Map<string, { data: any; expiresAt: number }>()
  private tooltipsBound = false
  private moveRaf = 0
  private pendingPointer: MouseEvent | null = null
  private legacyTooltip: HTMLElement | null = null
  private lastCheckedText = ''
  /** 最近一次远端检查失败原因，展示"服务不可用"时一并打到 console */
  private lastFailureReason = ''

  constructor() {
    try {
      this.extractor = new TextExtractor()
      this.checker = new TextChecker()
      this.marker = new ErrorMarker()
      this.config = this.getDefaultConfig()
      this.setupMessageListener()
      this.init().catch((e) => {
        console.error('[miaob] init 失败:', e)
      })
    } catch (e) {
      console.error('[miaob] 构造函数失败:', e)
    }
  }

  setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === 'RUN_CHECK') {
        this.checkAllElements(true)
        this.checkPageContent(true)
        sendResponse({ success: true })
      }
      if (message.type === 'CLEAR_ALL_MARKS') {
        this.clearAllMarks()
        sendResponse({ success: true })
      }
      if (message.type === 'CONFIG_UPDATED') {
        this.config = message.data
        if (!this.config.enabled) {
          this.clearAllMarks()
        }
        sendResponse({ success: true })
      }
      return false
    })
  }

  async init() {
    this.config = await this.getConfig()

    if (!this.config.enabled) {
      console.log('妙笔已禁用')
      return
    }

    // Initialize user
    await this.initializeUser()

    // Initialize error panel
    this.initializePanel()

    this.watchEditableElements()

    if (this.config.autoCheck) {
      // 页面加载后立即检查（DOM 已就绪），无需等待 2 秒
      this.checkPageContent()
    }

    this.watchPageContent()

    // 悬浮交互只绑一次，和有没有标注无关
    this.initAnnotationTooltips()

    this.setupKeyboardShortcuts()

    // 标签页切回可见时，仅检查尚未检查过的内容
    if (this.config.autoCheck) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this.checkPageContent()
        }
      })
    }
  }

  async initializeUser() {
    try {
      const fingerprint = await getFingerprint()

      // 每次调服务端同步用户（按 fingerprint 去重，多 Tab 共享同一用户）
      const result = await userService.createAnonymousUser(fingerprint)

      // 读取本地 storage 对比，避免不必要的写入
      const stored = await chrome.storage.local.get(['userId'])
      if (stored.userId !== result.userId) {
        await chrome.storage.local.set({
          userId: result.userId,
          fingerprint,
          credits: result.credits,
          inviteCode: result.inviteCode,
          isActivated: result.isActivated || false
        })
      }

      console.log('用户:', result.userId)
    } catch (error) {
      console.error('初始化用户失败:', error)
    }
  }

  initializePanel() {
    const container = document.createElement('div')
    container.id = 'miaob-panel-root'
    document.body.appendChild(container)

    this.panelRoot = createRoot(container)
    this.renderPanel()
  }

  renderPanel() {
    if (!this.panelRoot) return

    const idiomSet = new Map<string, { idiom: string; derivation?: string; explanation?: string }>()
    const quoteSet = new Map<string, { text: string; from?: string }>()
    const xiehouyuSet = new Map<string, { text: string; answer?: string }>()
    for (const f of this.allFindings) {
      if (f.kind === 'idiom' && f.idiom) idiomSet.set(f.idiom.idiom, f.idiom)
      else if (f.kind === 'quote' && f.phrase) quoteSet.set(f.phrase.text, f.phrase)
      else if (f.kind === 'xiehouyu' && f.phrase) xiehouyuSet.set(f.phrase.text, f.phrase)
    }
    this.reportData = {
      errors: [],
      idioms: [...idiomSet.values()],
      quotes: [...quoteSet.values()],
      xiehouyu: [...xiehouyuSet.values()],
      expressions: this.expressionFindings,
      // 重建对象时必须带上，否则配额一刷新就丢
      quota: this.reportData.quota,
      vocabularyStats: this.reportData.vocabularyStats,
    }

    this.panelRoot.render(
      createElement(ReportPanel, {
        idioms: this.reportData.idioms,
        quotes: this.reportData.quotes,
        xiehouyu: this.reportData.xiehouyu,
      expressions: this.reportData.expressions,
        quota: this.reportData.quota,
        vocabularyStats: this.reportData.vocabularyStats,
        onItemClick: this.scrollToAnnotation.bind(this),
      })
    )
  }

  /**
   * 滚动到页面中标注的位置（成语/名句/歇后语/错误/表达高光）。
   * 标注层没有真实元素可查，改为在注册表里找到 Range 后滚动并闪烁。
   */
  private scrollToAnnotation(text: string, type: string) {
    const kinds: MarkKind[] = ['error', 'idiom', 'quote', 'xiehouyu', 'expression']
    const kind = (kinds.includes(type as MarkKind) ? type : 'idiom') as MarkKind
    this.annotator.scrollTo(kind, text)
  }

  async getConfig(): Promise<UserConfig> {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime?.id) {
          resolve(this.getDefaultConfig())
          return
        }
        chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, (response) => {
          if (chrome.runtime.lastError) {
            resolve(this.getDefaultConfig())
            return
          }
          resolve((response?.data as UserConfig | undefined) ?? this.getDefaultConfig())
        })
      } catch {
        resolve(this.getDefaultConfig())
      }
    })
  }

  private getDefaultConfig(): UserConfig {
    return {
      apiUrl: 'https://api.miaob.net',
      enabled: true,
      autoCheck: true,
      debounceMs: 800,
      minLength: 4,
      checkOnBlur: true,
    }
  }

  // 监听可编辑元素的输入
  watchEditableElements() {
    const editableSelector = 'textarea, [contenteditable="true"]'
    const inputSelector = 'input[type="text"], input:not([type])'

    const skipInputTypes = [
      'number',
      'tel',
      'email',
      'url',
      'password',
      'search',
      'date',
      'time',
      'datetime-local',
      'month',
      'week',
      'color',
      'range',
      'file',
      'hidden',
    ]

    const shouldSkipInput = (el: HTMLInputElement): boolean => {
      if (el.dataset.miaobSkip === 'true') return true
      if (skipInputTypes.includes(el.type)) return true
      if (el.maxLength > 0 && el.maxLength < this.config.minLength) return true
      return false
    }

    document.querySelectorAll(editableSelector).forEach((el) => {
      this.attachListeners(el as HTMLElement)
    })

    document.querySelectorAll(inputSelector).forEach((el) => {
      const input = el as HTMLInputElement
      if (!shouldSkipInput(input)) {
        this.attachListeners(input)
      }
    })

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as HTMLElement
            
            if (element.matches(editableSelector)) {
              this.attachListeners(element)
            } else if (element.matches(inputSelector)) {
              const input = element as HTMLInputElement
              if (!shouldSkipInput(input)) {
                this.attachListeners(input)
              }
            }

            element.querySelectorAll(editableSelector).forEach((el) => {
              this.attachListeners(el as HTMLElement)
            })
            element.querySelectorAll(inputSelector).forEach((el) => {
              const input = el as HTMLInputElement
              if (!shouldSkipInput(input)) {
                this.attachListeners(input)
              }
            })
          }
        })
      })
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    })
  }

  // 为元素添加监听器
  attachListeners(element: HTMLElement) {
    if (this.attachedElements.has(element)) return
    this.attachedElements.add(element)

    element.addEventListener('input', () => {
      if (this.config.autoCheck) {
        this.scheduleCheck(element)
      }
    })

    element.addEventListener('blur', () => {
      if (this.config.checkOnBlur) {
        this.checkElement(element)
      }
    })
  }

  scheduleCheck(element: HTMLElement) {
    const existingTimer = this.debounceTimers.get(element)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const timer = window.setTimeout(() => {
      this.debounceTimers.delete(element)
      const text = this.extractor.extractText(element)
      if (text.trim().length >= this.config.minLength) {
        this.checkElement(element)
      }
    }, this.config.debounceMs)

    this.debounceTimers.set(element, timer)
  }

  async checkElement(element: HTMLElement, force = false) {
    if (!force && !this.config.enabled) return

    const text = this.extractor.extractText(element)

    if (!text || text.trim().length === 0) {
      this.marker.clearMarkers(element)
      return
    }

    if (text.trim().length < this.config.minLength) {
      this.marker.clearMarkers(element)
      return
    }

    try {
      const { errors, failed, reason } = await this.checker.checkEditable(text)

      this.marker.clearMarkers(element)

      if (errors.length > 0) {
        this.marker.markErrors(element, errors)
        this.reportData.errors = errors
        this.renderPanel()
      } else if (failed) {
        console.warn('[miaob] 可编辑元素检查失败:', reason || '未知原因')
        this.marker.showServiceError(element, t('ct_serverUnavailable'))
      }
    } catch (error) {
      this.marker.showServiceError(
        element,
        error instanceof Error ? error.message : t('ct_connectFailed')
      )
    }
  }

  // 快捷键
  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+Shift+E: 检查整个页面
      if (e.ctrlKey && e.shiftKey && e.key === 'E') {
        e.preventDefault()
        this.checkAllElements()
        this.checkPageContent()
      }
    })
  }

  // 清除所有标注，还原页面
  clearAllMarks() {
    // 静态正文标注走 CSS Custom Highlight API，页面结构从未被改动，
    // 清掉 highlight registry 即可 100% 还原（不需要反向替换 DOM）。
    this.annotator.clear()

    // 兼容清理：若页面上还残留旧版本注入的 inline wrapper，一并还原
    document.querySelectorAll('.miaob-inline-wrapper').forEach((wrapper) => {
      const text = wrapper.textContent || ''
      const textNode = document.createTextNode(text)
      wrapper.parentNode?.replaceChild(textNode, wrapper)
    })

    // 清除可编辑元素的标注
    document.querySelectorAll('.miaob-error-panel, .miaob-service-error').forEach(el => el.remove())
    document.querySelectorAll('.miaob-has-errors').forEach(el => el.classList.remove('miaob-has-errors'))
    document.querySelectorAll('.miaob-service-unavailable').forEach(el => el.classList.remove('miaob-service-unavailable'))

    // 还原 wrapper 包裹的元素
    document.querySelectorAll('.miaob-wrapper').forEach((wrapper) => {
      const child = wrapper.firstElementChild
      if (child) {
        wrapper.parentNode?.replaceChild(child, wrapper)
      }
    })

    // 清除 tooltip / 服务不可用提示
    document.querySelectorAll('.miaob-tooltip').forEach(el => el.remove())
    const serverError = document.getElementById('miaob-server-error')
    if (serverError) serverError.style.display = 'none'

    // 重置检查状态，允许重新检查
    this.staticCheckedElements = new WeakSet()
    this.checker.clearCache()
    this.marker.clearAll()
    this.closeIdiomCard()
    this.hoverTarget = this.idiomTarget = null

    // 重置发现列表并刷新面板（旧实现漏了这一步，清完面板还在显示旧结果）
    this.allFindings = []
    this.expressionFindings = []
    this.findingKeys.clear()
    this.reportData.errors = []
    this.reportData.vocabularyStats = undefined
    this.lastCheckedText = ''
    this.renderPanel()
  }

  // 检查所有可编辑元素
  async checkAllElements(force = false) {
    const selector = 'input[type="text"], textarea, [contenteditable="true"]'
    const elements = document.querySelectorAll(selector)

    for (const el of Array.from(elements)) {
      await this.checkElement(el as HTMLElement, force)
    }
  }

  // 检查页面静态文本（分块 → 服务端，偏移按块回填）
  async checkPageContent(force = false) {
    if (!force && !this.config.enabled) return
    if (this.pageCheckInFlight) return
    if (!force && Date.now() - this.lastPageCheckAt < 3000) return
    this.pageCheckInFlight = true
    this.lastPageCheckAt = Date.now()

    try {
      await this.runPagePass()
    } catch (error) {
      console.error('[miaob] 页面内容检查失败:', error)
    } finally {
      this.pageCheckInFlight = false
    }
  }

  /**
   * 一轮整页检查：
   *  收集未检查的块 → 分批 → 有限并发送检 → 逐块注册标注。
   *  与旧实现的关键差异：单批失败不再中断整轮，且块间按时间片让出主线程。
   */
  private async runPagePass() {
    const blocks = collectBlocks(document.body, {
      checked: this.staticCheckedElements,
      render: new RenderCache(),
    })
    if (blocks.length === 0) return

    // 增量轮次只会重新送检被改动的块，这里按整页可见文本重建上下文窗口，
    // 否则累加会把改过的内容重复塞进去
    this.lastCheckedText = this.getPageTextForStats()
    if (!this.reportData.vocabularyStats) {
      this.reportData.vocabularyStats = calculateVocabularyStats(this.lastCheckedText)
    }

    let anyFailed = false
    await runConcurrent(batchBlocks(blocks), BLOCK_CONCURRENCY, async (batch) => {
      const remote = await this.checker.checkRemote(batch)
      if (remote.failed) {
        anyFailed = true
        this.lastFailureReason = remote.reason || '未知原因'
        return
      }
      if (remote.quota) this.reportData.quota = remote.quota

      let sliceStart = performance.now()
      for (const block of batch) {
        const marks = this.checker.localMarks(block.text).concat(remote.marks.get(block.id) || [])
        this.registerFindings(marks)
        // 恒调用：命中清零的块要能摘掉上一轮残留的高光
        this.annotator.apply(block, marks)
        this.staticCheckedElements.add(block.root)

        if (performance.now() - sliceStart > 16) {
          await yieldToBrowser()
          sliceStart = performance.now()
        }
      }
    })

    if (anyFailed) {
      console.warn('[miaob] 本页有一批请求失败，展示服务不可用提示:', this.lastFailureReason || '未知原因')
      this.showServerUnavailable()
    } else {
      // 上一次可能只是瞬时失败（服务重启 / 网络抖动），本轮成功后要收起提示，
      // 否则提示会一直挂在页面上，看起来像“服务器一直不可用”。
      this.hideServerUnavailable()
    }

    // 记录发现（成语/名句/歇后语）并通知
    this.recordDiscoveries()
    // 提交成语到广场
    this.submitToSquare()
    // 展示阅读报告 + 初始化悬浮卡片
    this.renderPanel()
    this.initAnnotationTooltips()
  }

  /** 汇总命中的标注进面板数据（同一文本只记一次） */
  private registerFindings(marks: Mark[]) {
    for (const mark of marks) {
      if (mark.kind === 'expression') {
        const expr = mark.expression
        if (!expr || !expr.text) continue
        if (expr.score !== undefined && expr.score < 0.8) continue
        if (!this.expressionFindings.some((e) => e.type === expr.type && e.text === expr.text)) {
          this.expressionFindings.push({ type: expr.type, text: expr.text, score: expr.score })
        }
        continue
      }

      const key = mark.kind === 'idiom' && mark.idiom
        ? 'idiom|' + mark.idiom.idiom
        : (mark.kind === 'quote' || mark.kind === 'xiehouyu') && mark.phrase
          ? mark.kind + '|' + mark.phrase.text
          : null
      if (!key || this.findingKeys.has(key)) continue
      this.findingKeys.add(key)

      if (mark.kind === 'idiom' && mark.idiom) {
        this.allFindings.push({ kind: 'idiom', idiom: mark.idiom })
      } else if (mark.phrase) {
        this.allFindings.push({
          kind: mark.kind,
          phrase: { text: mark.phrase.text, type: mark.kind, answer: mark.phrase.answer, from: mark.phrase.from },
        })
      }
    }
  }

  /**
   * 广场提交仍需激活（广场是社区行为，未激活不参与）。
   * 激活成功时 content 会把 isActivated 写回 storage，下一轮即生效。
   * 注意：发现记录（recordDiscoveries）不再受此限制——未激活也记录，只是不给积分。
   */
  private async isActivatedUser(): Promise<boolean> {
    try {
      const stored = await new Promise<{ isActivated?: boolean }>((resolve) =>
        chrome.storage.local.get(['isActivated'], (r) => resolve(r as { isActivated?: boolean })),
      )
      return stored.isActivated === true
    } catch {
      return false
    }
  }

  /**
   * 记录发现并显示通知
   */
  private async recordDiscoveries() {
    const items = this.allFindings
      .filter(f => f.kind === 'idiom' || f.kind === 'quote' || f.kind === 'xiehouyu')
      .map(f => ({
        type: f.kind as 'idiom' | 'quote' | 'xiehouyu',
        text: f.kind === 'idiom' ? f.idiom?.idiom || '' : f.phrase?.text || '',
      }))
      .filter(i => i.text)

    if (items.length === 0) return

    try {
      const result = await discoveryService.recordDiscoveries(items)
      // 只有已激活用户才会拿到积分 / 弹出奖励通知；未激活用户静默记录
      if (result.newDiscoveries.length > 0 && (await this.isActivatedUser())) {
        this.showDiscoveryNotification(result.newDiscoveries)
      }
    } catch (e) {
      // 发现记录失败不影响主流程
      console.log('[发现记录] 失败:', e)
    }
  }

  /**
   * 提交成语到广场（去重：同一页面同一成语只提交一次）
   */
  private async submitToSquare() {
    const idiomFindings = this.allFindings.filter(f => f.kind === 'idiom' && f.idiom?.idiom)
    if (idiomFindings.length === 0) return
    if (!(await this.isActivatedUser())) return

    const url = location.href
    const submittedKey = 'miaob_square_submitted_' + this.hashUrl(url)
    let submitted: Set<string> = new Set()
    try {
      const stored = await new Promise<any>(r => chrome.storage.local.get([submittedKey], r))
      if (stored[submittedKey]) submitted = new Set(stored[submittedKey])
    } catch (_) {}

    for (const f of idiomFindings) {
      const idiom = f.idiom!.idiom
      if (submitted.has(idiom)) continue
      try {
        // 找所在句子：取成语前后各 30 字符
        const passage = this.findPassageForIdiom(idiom)
        await squareService.submitIdiom({ idiom, passage, url })
        submitted.add(idiom)
      } catch (_) {
        // 提交失败不影响主流程（可能已提交过）
      }
    }

    // 持久化已提交记录（保留最近 200 条）
    try {
      const arr = [...submitted].slice(-200)
      await new Promise<void>(r => chrome.storage.local.set({ [submittedKey]: arr }, () => r()))
    } catch (_) {}
  }

  /** 简单 URL hash，用于 storage key */
  private hashUrl(url: string): string {
    let h = 0
    for (let i = 0; i < url.length; i++) { h = ((h << 5) - h + url.charCodeAt(i)) | 0 }
    return Math.abs(h).toString(36)
  }

  /** 在 allFindings 中找成语的上下文句子 */
  private findPassageForIdiom(idiom: string): string {
    // 简单策略：在所有已检查的块文本中找包含成语的句子
    const allText = this.lastCheckedText
    if (!allText) return idiom
    const idx = allText.indexOf(idiom)
    if (idx === -1) return idiom
    const start = Math.max(0, idx - 30)
    const end = Math.min(allText.length, idx + idiom.length + 30)
    return allText.slice(start, end).trim()
  }

  /**
   * 显示发现通知（带成语/词语）
   */
  private showDiscoveryNotification(discoveries: DiscoveryResult[]) {
    const container = document.getElementById('miaob-discovery-toast') || document.createElement('div')
    container.id = 'miaob-discovery-toast'
    container.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;'

    discoveries.forEach((d) => {
      const toast = document.createElement('div')
      const isFirst = d.order === 1
      const bgColor = isFirst ? 'linear-gradient(135deg, #fbbf24, #f59e0b)' : '#8C3D2B'
      const icon = isFirst ? '🏆' : '⭐'
      const label = isFirst ? t('ct_firstDiscovery') : t('ct_nthDiscovery', d.order)

      toast.style.cssText = `background:${bgColor};color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:500;box-shadow:0 4px 12px rgba(0,0,0,.2);animation:miaob-slide-down .3s ease;display:flex;align-items:center;gap:8px;pointer-events:auto;`
      toast.innerHTML = `<span>${icon}</span><span>${label}【${d.text}】 ${t('ct_points', d.points)}</span>`

      container.appendChild(toast)

      // 3 秒后自动消失
      setTimeout(() => {
        toast.style.opacity = '0'
        toast.style.transition = 'opacity .3s'
        setTimeout(() => toast.remove(), 300)
      }, 3000)
    })

    if (!document.getElementById('miaob-discovery-toast')) {
      document.body.appendChild(container)
    }

    // 添加动画样式（只加一次）
    if (!document.getElementById('miaob-toast-style')) {
      const style = document.createElement('style')
      style.id = 'miaob-toast-style'
      style.textContent = '@keyframes miaob-slide-down { from { opacity:0;transform:translateY(-20px); } to { opacity:1;transform:translateY(0); } }'
      document.head.appendChild(style)
    }
  }

  /**
   * 绑定标注交互（只绑一次）。
   * 标注没有真实元素可挂事件，统一走 mousemove + caretRangeFromPoint 命中测试。
   */
  private initAnnotationTooltips() {
    if (this.tooltipsBound) return
    this.tooltipsBound = true

    document.addEventListener('mousemove', this.handlePointerMove, { passive: true })
    document.addEventListener('keydown', this.handleIdiomKeydown)
    window.addEventListener('resize', this.handleIdiomViewportChange)
    window.addEventListener('scroll', this.handleIdiomViewportChange, true)
  }

  private handleIdiomKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.idiomCard) this.closeIdiomCard()
  }

  private handleIdiomViewportChange = () => {
    if (this.idiomCard && this.idiomTarget) this.positionIdiomCard(this.idiomCard, this.idiomTarget)
    if (this.legacyTooltip && this.hoverTarget) this.positionLegacyTooltip(this.legacyTooltip, this.hoverTarget)
  }

  /** rAF 节流：caretRangeFromPoint 不便宜，不能每个 mousemove 都算 */
  private handlePointerMove = (e: MouseEvent) => {
    this.pendingPointer = e
    if (this.moveRaf) return
    this.moveRaf = window.requestAnimationFrame(() => {
      this.moveRaf = 0
      const event = this.pendingPointer
      if (event) this.processPointer(event)
    })
  }

  private processPointer(e: MouseEvent) {
    // 指针在我们自己的浮层上时不动状态，否则一进卡片就被自己的 mousemove 收起
    const target = e.target as Node | null
    if (target && (this.idiomCard?.contains(target) || this.legacyTooltip?.contains(target))) return

    const rec = this.annotator.hitTest(e.clientX, e.clientY)
    if (rec === this.hoverTarget) return
    this.hoverTarget = rec
    this.clearIdiomTimer()

    if (!rec) {
      this.hideLegacyTooltip()
      this.scheduleIdiomHide()
      return
    }

    if (rec.kind === 'idiom') {
      this.hideLegacyTooltip()
      if (this.idiomTarget === rec && this.idiomCard) return
      this.idiomTarget = rec
      this.idiomShowTimer = window.setTimeout(() => {
        if (this.hoverTarget === rec && !this.idiomPinned) this.showIdiomCard(rec).catch(() => {})
      }, 200)
      return
    }

    if (rec.kind === 'quote' || rec.kind === 'xiehouyu') {
      this.idiomTarget = null
      this.scheduleIdiomHide()
      this.showLegacyAnnotationTooltip(rec)
      return
    }

    this.hideLegacyTooltip()
    this.scheduleIdiomHide()
  }

  private hideLegacyTooltip() {
    this.legacyTooltip?.remove()
    this.legacyTooltip = null
  }

  private positionLegacyTooltip(tooltip: HTMLElement, rec: RegisteredMark) {
    const rect = rec.range.getBoundingClientRect()
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - tooltip.offsetWidth - 8))
    const below = rect.bottom + 4
    tooltip.style.left = `${left}px`
    tooltip.style.top = `${below + tooltip.offsetHeight <= window.innerHeight - 8 ? below : Math.max(8, rect.top - tooltip.offsetHeight - 4)}px`
  }

  private showLegacyAnnotationTooltip(rec: RegisteredMark) {
    this.hideLegacyTooltip()
    const phrase = rec.mark.phrase
    if (!phrase) return

    let url: string
    let label: string
    let body: string
    if (rec.kind === 'quote') {
      url = `https://so.gushiwen.cn/search.aspx?value=${encodeURIComponent(phrase.text)}&type=title`
      label = t('ct_tooltipQuote')
      body = phrase.from ? t('ct_titleSource', phrase.from) : t('ct_tooltipQuote')
    } else {
      url = `https://www.xiehouyu.cn/search.php?keyword=${encodeURIComponent(phrase.text)}`
      label = t('ct_tooltipXiehouyu')
      body = phrase.answer ? `${phrase.text}——${phrase.answer}` : t('ct_tooltipXiehouyu')
    }

    let parsed: URL
    try {
      parsed = new URL(url)
      if (!['https:', 'http:'].includes(parsed.protocol)) return
    } catch {
      return
    }

    const tooltip = document.createElement('div')
    tooltip.className = 'miaob-tooltip'
    const header = document.createElement('div')
    header.className = 'miaob-tooltip-header'
    header.textContent = `${label}：${rec.text}`
    const bodyEl = document.createElement('div')
    bodyEl.className = 'miaob-tooltip-body'
    bodyEl.textContent = body
    const link = document.createElement('a')
    link.className = 'miaob-tooltip-link'
    link.textContent = t('ct_tooltipLink', parsed.hostname.replace(/^www\./, ''))
    link.href = parsed.href
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    tooltip.append(header, bodyEl, link)
    document.body.appendChild(tooltip)

    this.legacyTooltip = tooltip
    this.positionLegacyTooltip(tooltip, rec)
    tooltip.addEventListener('mouseleave', () => this.hideLegacyTooltip())
  }

  private clearIdiomTimer() {
    if (this.idiomShowTimer !== null) window.clearTimeout(this.idiomShowTimer)
    if (this.idiomHideTimer !== null) window.clearTimeout(this.idiomHideTimer)
    this.idiomShowTimer = this.idiomHideTimer = null
  }

  private scheduleIdiomHide() {
    if (this.idiomPinned) return
    if (this.idiomHideTimer !== null) window.clearTimeout(this.idiomHideTimer)
    this.idiomHideTimer = window.setTimeout(() => this.closeIdiomCard(), 300)
  }

  private closeIdiomCard() {
    this.clearIdiomTimer()
    this.idiomRequestId++
    this.idiomCard?.remove()
    this.idiomCard = null
    this.idiomTarget = null
    this.idiomPinned = false
  }

  private positionIdiomCard(card: HTMLElement, target: RegisteredMark) {
    const rect = target.range.getBoundingClientRect()
    const width = Math.min(400, window.innerWidth - 16)
    card.style.width = `${width}px`
    card.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`
    card.style.top = `${rect.bottom + 6 <= window.innerHeight - 8 ? rect.bottom + 6 : Math.max(8, rect.top - card.offsetHeight - 6)}px`
  }

  private async showIdiomCard(target: RegisteredMark) {
    this.closeIdiomCard()
    this.idiomTarget = target
    const card = document.createElement('div')
    card.className = 'miaob-idiom-card'
    const loading = document.createElement('div')
    loading.className = 'miaob-card-loading'
    loading.textContent = t('ct_cardLoading')
    card.appendChild(loading)
    document.body.appendChild(card)
    this.idiomCard = card
    this.positionIdiomCard(card, target)
    card.addEventListener('mouseenter', () => this.clearIdiomTimer())
    card.addEventListener('mouseleave', () => this.scheduleIdiomHide())
    const requestId = ++this.idiomRequestId
    try {
      const idiom = target.text
      const cached = this.idiomDetailCache.get(idiom)
      const local = this.findLocalIdiomDetail(idiom)
      const data = local || (cached && cached.expiresAt > Date.now() ? cached.data : await this.fetchIdiomDetail(idiom))
      if (!cached || cached.expiresAt <= Date.now()) this.idiomDetailCache.set(idiom, { data, expiresAt: Date.now() + 3600000 })
      if (requestId !== this.idiomRequestId || this.idiomCard !== card) return
      this.renderIdiomCard(card, data)
      this.positionIdiomCard(card, target)
    } catch {
      if (requestId === this.idiomRequestId && this.idiomCard === card) {
        loading.textContent = t('ct_cardLoadFail')
      }
    }
  }

  private findLocalIdiomDetail(idiom: string): { idiom: string; pinyin: string; explanation: string } | null {
    const match = (idiomDetails as Record<string, { pinyin?: string; explanation?: string }>)[idiom]
    if (!match) return null
    return { idiom, pinyin: match.pinyin || '', explanation: match.explanation || '' }
  }

  private renderIdiomCard(card: HTMLElement, data: any) {
    card.replaceChildren()
    const header = document.createElement('div'); header.className = 'miaob-card-header'
    const title = document.createElement('strong'); title.className = 'miaob-card-title'; title.textContent = data.idiom || ''
    const pinyin = document.createElement('span'); pinyin.className = 'miaob-card-pinyin'; pinyin.textContent = data.pinyin || ''
    const close = document.createElement('button'); close.className = 'miaob-card-close'; close.type = 'button'; close.textContent = '✕'; close.setAttribute('aria-label', t('ct_cardClose')); close.onclick = () => this.closeIdiomCard()
    header.append(title, pinyin, close); card.appendChild(header)
    const body = document.createElement('div'); body.className = 'miaob-card-body'
    const addSection = (label: string, value: unknown) => { if (!value) return; const section = document.createElement('section'); section.className = 'miaob-card-section'; const l = document.createElement('div'); l.className = 'miaob-card-label'; l.textContent = label; const v = document.createElement('div'); v.textContent = String(value); section.append(l, v); body.appendChild(section) }
    addSection(t('ct_cardMeaning'), data.explanation); addSection(t('ct_cardDerivation'), data.derivation)
    const relations = data.relations || { synonyms: data.synonym || [], antonyms: data.antonym || [] }
    const relationBox = document.createElement('div'); relationBox.className = 'miaob-card-relations'
    const addRelations = (label: string, values: unknown[], type: string) => { if (!Array.isArray(values) || !values.length) return; const group = document.createElement('div'); group.className = 'miaob-card-rel-group'; const l = document.createElement('div'); l.className = 'miaob-card-label'; l.textContent = label; const items = document.createElement('div'); items.className = 'miaob-card-rel-items'; values.slice(0, 8).forEach(value => { const b = document.createElement('button'); b.type = 'button'; b.className = 'miaob-card-rel-item'; b.textContent = String(value); b.onclick = () => { const found = this.findAnnotation(String(value), type); if (found) this.scrollToAnnotation(String(value), type); else this.openRelatedIdiom(String(value), card) }; items.appendChild(b) }); group.append(l, items); relationBox.appendChild(group) }
    addRelations(t('ct_cardSynonym'), relations.synonyms, 'idiom'); addRelations(t('ct_cardAntonym'), relations.antonyms, 'idiom'); if (relationBox.childElementCount) body.appendChild(relationBox); card.appendChild(body)
    const footer = document.createElement('div'); footer.className = 'miaob-card-footer'; const link = document.createElement('a'); link.className = 'miaob-card-link'; link.textContent = t('ct_cardZdic'); link.href = typeof data.zdicUrl === 'string' && data.zdicUrl ? data.zdicUrl : `https://www.zdic.net/hans/${encodeURIComponent(data.idiom || '')}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; footer.appendChild(link)
    const add = document.createElement('button'); add.type = 'button'; add.className = 'miaob-card-add'; add.textContent = t('ct_cardAdd'); add.onclick = () => { add.disabled = true; chrome.runtime.sendMessage({ type: 'ADD_MIAOBEN', idiom: data.idiom, sourceUrl: location.href }, (response) => { if (response?.needsActivation) { this.showActivationGuide(card, data.idiom, add); add.disabled = false; add.textContent = t('ct_cardAdd') } else { add.disabled = false; add.textContent = response?.success ? t('ct_cardAdded') : t('ct_cardAddFail') } }) }; footer.appendChild(add); card.appendChild(footer)
    card.onclick = (e) => { if (!(e.target as HTMLElement).closest('button,a')) { this.idiomPinned = true; card.classList.add('pinned') } }
  }

  private findAnnotation(text: string, type: string): HTMLElement | null {
    const className = type === 'idiom' ? 'miaob-idiom' : type === 'quote' ? 'miaob-quote' : 'miaob-xiehouyu'
    return Array.from(document.querySelectorAll(`.${className}`)).find(el => el.textContent === text || el.textContent?.includes(text)) as HTMLElement || null
  }

  private async openRelatedIdiom(idiom: string, card: HTMLElement) {
    try {
      const cached = this.idiomDetailCache.get(idiom)
      const data = cached && cached.expiresAt > Date.now() ? cached.data : await this.fetchIdiomDetail(idiom)
      this.idiomDetailCache.set(idiom, { data, expiresAt: Date.now() + 3600000 })
      if (this.idiomCard === card) this.renderIdiomCard(card, data)
    } catch {
      const message = document.createElement('div'); message.className = 'miaob-card-loading'; message.textContent = t('ct_cardLoadFail'); card.replaceChildren(message)
    }
  }

  private fetchIdiomDetail(idiom: string): Promise<any> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'FETCH_IDIOM_DETAIL', idiom }, (response) => {
        if (response?.success) resolve(response.data)
        else reject(new Error(response?.error || 'fetch failed'))
      })
    })
  }

  // 激活引导弹窗（在成语卡片内展示）
  private showActivationGuide(card: HTMLElement, idiom: string, addBtn: HTMLButtonElement) {
    // 移除已有的引导
    card.querySelector('.miaob-activation-guide')?.remove()

    const guide = document.createElement('div')
    guide.className = 'miaob-activation-guide'
    guide.innerHTML = `
      <div class="miaob-guide-inner">
        <div class="miaob-guide-title">${t('ct_guideTitle')}</div>
        <div class="miaob-guide-desc">${t('ct_guideDesc')}</div>
        <div class="miaob-guide-qr" id="miaob-guide-qr-${Date.now()}">
          <div class="miaob-guide-loading">${t('ct_guideLoadingQr')}</div>
        </div>
        <div class="miaob-guide-hint">${t('ct_guideHint')}</div>
        <button class="miaob-guide-close" type="button">✕</button>
      </div>
    `

    card.appendChild(guide)

    // 关闭按钮
    guide.querySelector('.miaob-guide-close')!.addEventListener('click', () => guide.remove())

    // 加载二维码
    const qrContainer = guide.querySelector('.miaob-guide-qr') as HTMLElement
    this.loadActivationQr(qrContainer, idiom, addBtn)
  }

  // 加载激活二维码并轮询状态
  private loadActivationQr(container: HTMLElement, idiom: string, addBtn: HTMLButtonElement) {
    // 创建激活会话
    chrome.runtime.sendMessage({ type: 'ACTIVATION_START' }, (startResp) => {
      if (!startResp?.success) {
        container.innerHTML = '<div class="miaob-guide-error">' + t('ct_guideLoadFail') + '</div>'
        return
      }
      const sessionId = startResp.data.sessionId

      // 获取二维码
      chrome.runtime.sendMessage({ type: 'WECHAT_QRCODE', sessionId }, (qrResp) => {
        if (!qrResp?.success) {
          container.innerHTML = '<div class="miaob-guide-error">' + t('ct_guideQrFail') + '</div>'
          return
        }
        container.innerHTML = `<img src="${qrResp.data.qrcodeUrl}" alt="${t('ct_guideQrAlt')}" class="miaob-guide-qrimg" />`

        // 轮询扫码状态
        const poll = setInterval(() => {
          chrome.runtime.sendMessage({ type: 'WECHAT_STATUS', sessionId }, (statusResp) => {
            if (statusResp?.success && statusResp.data.scanned) {
              clearInterval(poll)
              container.innerHTML = '<div class="miaob-guide-success">' + t('ct_guideScanned') + '</div>'
              this.completeActivation(sessionId, idiom, addBtn, container)
            }
          })
        }, 1500)

        // 30 秒超时
        setTimeout(() => { clearInterval(poll) }, 30000)
      })
    })
  }

  // 完成激活并自动加入妙笔本
  private completeActivation(sessionId: string, idiom: string, addBtn: HTMLButtonElement, container: HTMLElement) {
    chrome.runtime.sendMessage({ type: 'ACTIVATION_COMPLETE', sessionId }, (resp) => {
      if (resp?.success) {
        container.innerHTML = '<div class="miaob-guide-success">' + t('ct_guideSuccess') + '</div>'
        // 更新本地激活状态
        chrome.storage.local.set({ isActivated: true, credits: resp.data?.credits || 0 })
        // 自动重试加入妙笔本
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: 'ADD_MIAOBEN', idiom, sourceUrl: location.href }, (addResp) => {
            if (addResp?.success) {
              addBtn.textContent = t('ct_cardAdded')
            } else {
              addBtn.textContent = t('ct_cardAdd')
            }
          })
        }, 800)
        setTimeout(() => { container.closest('_miaob-activation-guide')?.remove() }, 2000)
      } else {
        container.innerHTML = '<div class="miaob-guide-error">' + t('ct_guideFail') + '</div>'
      }
    })
  }


  /**
   * 显示服务端不可用提示
   */
  private showServerUnavailable() {
    let el = document.getElementById('miaob-server-error')
    if (!el) {
      el = document.createElement('div')
      el.id = 'miaob-server-error'
      el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#92400e;color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.2);'
      document.body.appendChild(el)
    }
    el.textContent = t('ct_serverUnavailable')
    el.style.display = 'block'
  }

  /** 收起服务端不可用提示（某轮检查成功后调用） */
  private hideServerUnavailable() {
    const el = document.getElementById('miaob-server-error')
    if (el) el.style.display = 'none'
  }

  watchPageContent() {
    const observer = new MutationObserver((mutations) => {
      let touched = false
      for (const mutation of mutations) {
        // 新增/删除节点会改父块文本，改的是 target（父元素）而不是 addedNodes 本身
        resetBlockState(mutation.target, this.staticCheckedElements)
        if (mutation.target.nodeType === Node.TEXT_NODE || mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
          touched = true
        }
      }
      if (!touched) return
      this.schedulePageCheck(800)
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    // 滚动监听：小说/资讯站滚动加载内容，滚动停稳后再跑一轮
    let scrollTimer: number | null = null
    window.addEventListener('scroll', () => {
      if (scrollTimer) clearTimeout(scrollTimer)
      scrollTimer = window.setTimeout(() => this.schedulePageCheck(1500), 300)
    }, { passive: true })
  }

  /**
   * 防抖后重跑整页检查。上一轮还在跑就顺延，绝不并发。
   * 清零 lastPageCheckAt 绕开 checkPageContent 的 3s 限流——那道限流是给
   * 手动触发的，MutationObserver 驱动的重扫本就不该被它拦掉。
   */
  private schedulePageCheck(delay: number) {
    if (this.pageCheckTimer) clearTimeout(this.pageCheckTimer)
    this.pageCheckTimer = window.setTimeout(() => {
      this.pageCheckTimer = null
      if (this.pageCheckInFlight || !this.checker) {
        this.schedulePageCheck(500)
        return
      }
      this.lastPageCheckAt = 0
      this.checkPageContent().catch((error) => console.error('[miaob] 页面检查失败:', error))
    }, delay)
  }

  /**
   * 收集页面当前可见的全部文本，供本地统计使用。
   * 这里不复用正文筛选，因为导航、链接、菜单和管理列表也属于用户看到的页面内容。
   */
  private getPageTextForStats(): string {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const texts: string[] = []
    let current: Node | null = walker.nextNode()

    while (current) {
      const textNode = current as Text
      const parent = textNode.parentElement
      const tagName = parent?.tagName
      const isPluginNode = Boolean(parent?.closest(
        '#miaob-panel-root, .miaob-tooltip, .miaob-card, .miaob-error-panel, .miaob-service-error'
      ))
      const isVisible = Boolean(parent && parent.getClientRects().length > 0)

      if (parent && isVisible && !isPluginNode && tagName !== 'SCRIPT' && tagName !== 'STYLE' && tagName !== 'NOSCRIPT') {
        const value = textNode.textContent || ''
        if (value.trim()) texts.push(value)
      }

      current = walker.nextNode()
    }

    return texts.join('')
  }
}



// 初始化（防重复注入：activeTab 模式下可能多次注入）
declare global {
  interface Window { __MIAOB_INJECTED__?: boolean }
}

if (!window.__MIAOB_INJECTED__) {
  window.__MIAOB_INJECTED__ = true
  new MiaobContent()
}
