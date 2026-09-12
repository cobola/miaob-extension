// Content Script - 注入到页面
import type { TextError, UserConfig } from '../shared/types'
import { TextExtractor } from './extractor'
import { TextChecker } from './checker'
import { ErrorMarker } from './marker'
import { getFingerprint } from '../lib/fingerprint'
import { userService } from '../services/user.service'
import { feedbackService } from '../services/feedback.service'
import { discoveryService, DiscoveryResult } from '../services/discovery.service'
import { squareService } from '../services/square.service'
import './styles.css'
import { createRoot } from 'react-dom/client'
import { ReportPanel } from '../components/ReportPanel'
import { createElement } from 'react'

console.log('妙笔 Content Script 已加载')

interface StaticTextSegment {
  node: Text
  start: number
  end: number
}

interface StaticTextBlock {
  root: HTMLElement
  text: string
  segments: StaticTextSegment[]
}

class MiaobContent {
  private extractor!: TextExtractor
  private checker!: TextChecker
  private marker!: ErrorMarker
  private config!: UserConfig
  private debounceTimers: Map<HTMLElement, number> = new Map()
  private pageCheckTimer: number | null = null
  private pageCheckInFlight = false
  private lastPageCheckAt = 0
  private attachedElements: WeakSet<HTMLElement> = new WeakSet()
  private staticCheckedElements: WeakSet<HTMLElement> = new WeakSet()
  private isMarking = false
  private allErrors: TextError[] = []
  /** 所有发现（错误+成语+名句+歇后语） */
  private allFindings: Array<{ kind: string; error?: TextError; idiom?: { idiom: string; derivation?: string; explanation?: string }; phrase?: { text: string; type: string; answer?: string; from?: string } }> = []
  /** 阅读报告数据（供面板渲染） */
  private reportData: {
    errors: TextError[]
    idioms: Array<{ idiom: string; derivation?: string; explanation?: string }>
    quotes: Array<{ text: string; from?: string }>
    xiehouyu: Array<{ text: string; answer?: string }>
    expressions: Array<{ type: string; text: string; score?: number }>
    quota?: { remaining: number; isPaid: boolean; used: number; limit: number }
  } = { errors: [], idioms: [], quotes: [], xiehouyu: [], expressions: [] }
  private expressionFindings: Array<{ type: string; text: string; score?: number }> = []
  private panelRoot: ReturnType<typeof createRoot> | null = null
  private idiomCard: HTMLElement | null = null
  private idiomTarget: HTMLElement | null = null
  private idiomHideTimer: number | null = null
  private idiomShowTimer: number | null = null
  private idiomRequest: AbortController | null = null
  private idiomRequestId = 0
  private idiomPinned = false
  private idiomDetailCache = new Map<string, { data: any; expiresAt: number }>()

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

    // 监听面板发来的 LLM 深度检查结果，标注到页面
    window.addEventListener('miaob-llm-errors', ((e: CustomEvent) => {
      const errors = e.detail?.errors as TextError[] | undefined
      if (errors && errors.length > 0) {
        this.markLLMErrors(errors)
      }
    }) as EventListener)
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
    }

    this.panelRoot.render(
      createElement(ReportPanel, {
        idioms: this.reportData.idioms,
        quotes: this.reportData.quotes,
        xiehouyu: this.reportData.xiehouyu,
      expressions: this.reportData.expressions,
      quota: this.reportData.quota,
        onItemClick: this.scrollToAnnotation.bind(this),
      })
    )
  }

  /**
   * 滚动到页面中标注的位置（支持成语/名句/歇后语/错误）
   */
  private scrollToAnnotation(text: string, type: string) {
    const classMap: Record<string, string> = {
      idiom: 'miaob-idiom',
      quote: 'miaob-quote',
      xiehouyu: 'miaob-xiehouyu',
      error: 'miaob-error',
    }
    const selector = classMap[type] || 'miaob-error'
    const spans = document.querySelectorAll(`.${selector}`)

    for (const span of Array.from(spans)) {
      if (span.textContent === text || span.textContent?.includes(text)) {
        span.scrollIntoView({ behavior: 'smooth', block: 'center' })
        const originalBg = (span as HTMLElement).style.backgroundColor
        ;(span as HTMLElement).style.backgroundColor = '#fef08a'
        ;(span as HTMLElement).style.transition = 'background-color 0.3s'
        setTimeout(() => {
          ;(span as HTMLElement).style.backgroundColor = originalBg
        }, 2000)
        break
      }
    }
  }

  async handleFeedback(error: TextError, isCorrect: boolean) {
    try {
      const stored = await chrome.storage.local.get(['userId', 'fingerprint'])

      if (!stored.userId || !stored.fingerprint) {
        console.warn('用户信息缺失，跳过反馈（初始化未完成）')
        // 不抛错：反馈按钮显示"已反馈"状态，但提示用户
        return
      }

      const context = this.getErrorContext(error)

      const result = await feedbackService.submitFeedback(
        stored.userId as string,
        error,
        isCorrect,
        context
      )

      console.log('反馈提交成功，当前积分:', result.credits)

      // Update credits in storage
      await chrome.storage.local.set({ credits: result.credits })
    } catch (error) {
      console.error('提交反馈失败:', error)
      // 不 rethrow：让按钮仍显示"已反馈"状态，避免用户以为没点中
    }
  }

  handleErrorClick(error: TextError) {
    this.scrollToAnnotation(error.original, 'error')
  }

  getErrorContext(error: TextError): string {
    // 注意：error.start/end 是块内偏移，无法直接映射回全文。
    // 用错误词本身 + 消息作为上下文（足够后端学习误报模式）
    return `${error.message || ''} (原文: ${error.original})`
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
      const result = await this.checker.check(text)

      this.marker.clearMarkers(element)

      if (result && result.errors.length > 0) {
        this.marker.markErrors(element, result.errors)
        this.allErrors.push(...result.errors)
        this.renderPanel()
      }
    } catch (error) {
      this.marker.showServiceError(
        element,
        error instanceof Error ? error.message : '无法连接检查服务'
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
    this.isMarking = true
    // 还原静态文本标注（inline wrapper）
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

    // 清除 tooltip
    document.querySelectorAll('.miaob-tooltip').forEach(el => el.remove())

    // 重置检查状态，允许重新检查
    this.staticCheckedElements = new WeakSet()
    this.checker.clearCache()
    this.marker.clearAll()
    this.isMarking = false

    // Clear errors list and update panel
    this.allErrors = []
    this.renderPanel()

    console.log('[miaob] 已清除所有标注')
  }

  // 检查所有可编辑元素
  async checkAllElements(force = false) {
    const selector = 'input[type="text"], textarea, [contenteditable="true"]'
    const elements = document.querySelectorAll(selector)

    for (const el of Array.from(elements)) {
      await this.checkElement(el as HTMLElement, force)
    }
  }

  // 检查页面静态文本（聚合小块 → 服务端 API）
  async checkPageContent(force = false) {
    if (!force && !this.config.enabled) return
    if (this.pageCheckInFlight) return
    if (!force && Date.now() - this.lastPageCheckAt < 3000) return
    this.pageCheckInFlight = true
    this.lastPageCheckAt = Date.now()
    console.log('开始检查页面内容...')

    try {
      const blocks = this.collectStaticTextBlocks(document.body)
      console.log(`[miaob] 收集到 ${blocks.length} 个文本块`)

      // 过滤已检查过的块（防重复标注）
      const unChecked = blocks.filter(b => !this.staticCheckedElements.has(b.root))
      console.log(`[miaob] 未检查的块: ${unChecked.length}`)

      let serverUnavailable = false

      // 每个块独立检查（消除跨块偏移错位）
      // 相邻短块合并成一组以减少 API 调用，精确记录每个子块偏移
      const groups = this.groupBlocks(unChecked)

      for (const group of groups) {
        const result = await this.checker.check(group.text)

        if (result === null) {
          serverUnavailable = true
          break
        }

        console.log(`[miaob] 检查结果: ${result.errors.length} 个错误, ${result.idioms.length} 个成语, ${result.phrases.length} 个短语`)
        for (const expression of result.expressions || []) {
          if (expression?.text && !this.expressionFindings.some(e => e.type === expression.type && e.text === expression.text)) this.expressionFindings.push({ type: expression.type, text: expression.text, score: expression.score })
        }
        this.reportData.quota = result.quota

        // 保存检查过的文本（供 submitToSquare 取上下文）
        ;(this as any).__lastCheckedText__ = (this as any).__lastCheckedText__ ? (this as any).__lastCheckedText__ + group.text : group.text

      // 把结果映射回各个原始块（文本匹配定位，不依赖跨块偏移）
        for (const item of group.items) {
          const block = item.block
          const blockText = block.text
          const marks: Array<{ start: number; end: number; kind: 'error' | 'idiom' | 'quote' | 'xiehouyu' | 'expression'; error?: TextError; idiom?: { idiom: string; derivation?: string; explanation?: string }; phrase?: { text: string; answer?: string; from?: string }; expression?: { text: string; type: string } }> = []

          // 错误
          for (const e of result.errors) {
            const orig = e.original || ''
            if (!orig) continue
            for (const pos of this.locateText(blockText, orig, e.start - item.offset)) {
              marks.push({ start: pos.start, end: pos.end, kind: 'error', error: e })
              this.allFindings.push({ kind: 'error', error: e })
            }
          }

          // 成语
          for (const i of result.idioms) {
            const orig = i.idiom || ''
            if (!orig) continue
            for (const pos of this.locateText(blockText, orig, i.start - item.offset)) {
              marks.push({ start: pos.start, end: pos.end, kind: 'idiom', idiom: { idiom: i.idiom, derivation: i.derivation, explanation: i.explanation } })
              this.allFindings.push({ kind: 'idiom', idiom: { idiom: i.idiom, derivation: i.derivation, explanation: i.explanation } })
            }
          }

          // 名句/歇后语
          for (const p of result.phrases) {
            const orig = p.text || ''
            if (!orig) continue
            for (const pos of this.locateText(blockText, orig, p.start - item.offset)) {
              marks.push({ start: pos.start, end: pos.end, kind: p.type === 'quote' ? 'quote' : 'xiehouyu', phrase: { text: p.text, answer: p.answer, from: p.from } })
              this.allFindings.push({ kind: p.type === 'quote' ? 'quote' : 'xiehouyu', phrase: { text: p.text, type: p.type, answer: p.answer, from: p.from } })
            }
          }

          for (const expression of result.expressions || []) {
            const orig = expression.text || ''
            if (!orig || expression.score < 0.8) continue
            for (const pos of this.locateText(blockText, orig, expression.start - item.offset)) {
              marks.push({ start: pos.start, end: pos.end, kind: 'expression', expression: { text: orig, type: expression.type } })
            }
          }

          if (marks.length > 0) {
            this.markBlock(block, marks)
          }
          this.staticCheckedElements.add(block.root)
        }
      }

      if (serverUnavailable) {
        this.showServerUnavailable()
      }

      // 记录发现（成语/名句/歇后语）并通知
      this.recordDiscoveries()

      // 提交成语到广场
      this.submitToSquare()

      // 展示阅读报告（成语/名句/错误汇总）
      this.renderPanel()
      // 初始化标注悬浮卡片（含查看更多链接）
      this.initAnnotationTooltips()
    } catch (error) {
      console.error('页面内容检查失败:', error)
    }

    console.log('页面内容检查完成')
    this.pageCheckInFlight = false
  }

  /**
   * 标注 LLM 深度检查发现的错误到页面
   */
  private markLLMErrors(errors: TextError[]) {
    const blocks = this.collectStaticTextBlocks(document.body)
    for (const block of blocks) {
      const marks: Array<{ start: number; end: number; kind: 'error' | 'idiom' | 'quote' | 'xiehouyu'; error?: TextError; idiom?: { idiom: string; derivation?: string; explanation?: string }; phrase?: { text: string; answer?: string; from?: string } }> = []

      for (const err of errors) {
        const orig = err.original || ''
        if (!orig) continue
        // LLM 返回的位置是相对于送检文本的，块内偏移不可靠，用全文本匹配
        for (const pos of this.locateText(block.text, orig, -9999)) {
          marks.push({ start: pos.start, end: pos.end, kind: 'error', error: err })
          this.allFindings.push({ kind: 'error', error: err })
        }
      }

      if (marks.length > 0) {
        this.markBlock(block, marks)
      }
    }
    this.renderPanel()
    this.initAnnotationTooltips()
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
      if (result.newDiscoveries.length > 0) {
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
    const allText = (this as any).__lastCheckedText__ || ''
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
      const bgColor = isFirst ? 'linear-gradient(135deg, #fbbf24, #f59e0b)' : '#4f46e5'
      const icon = isFirst ? '🏆' : '⭐'
      const label = isFirst ? '首位发现' : `第${d.order}个发现`

      toast.style.cssText = `background:${bgColor};color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:500;box-shadow:0 4px 12px rgba(0,0,0,.2);animation:miaob-slide-down .3s ease;display:flex;align-items:center;gap:8px;pointer-events:auto;`
      toast.innerHTML = `<span>${icon}</span><span>${label}【${d.text}】 +${d.points}积分</span>`

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
   * 初始化标注悬浮卡片（含查看更多链接）
   */
  private initAnnotationTooltips() {
    // 移除旧的监听（防重复）
    document.removeEventListener('mouseover', this.handleAnnotationHover)
    document.removeEventListener('mouseout', this.handleAnnotationLeave)
    document.addEventListener('mouseover', this.handleAnnotationHover)
    document.addEventListener('mouseout', this.handleAnnotationLeave)
    document.addEventListener('keydown', this.handleIdiomKeydown)
    window.addEventListener('resize', this.handleIdiomViewportChange)
    window.addEventListener('scroll', this.handleIdiomViewportChange, true)
  }

  private handleIdiomKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.idiomCard) this.closeIdiomCard()
  }

  private handleIdiomViewportChange = () => {
    if (this.idiomCard && this.idiomTarget) this.positionIdiomCard(this.idiomCard, this.idiomTarget)
  }

  private handleAnnotationLeave = (e: Event) => {
    const target = e.target as HTMLElement
    if (!target.matches('.miaob-idiom')) return
    const related = (e as MouseEvent).relatedTarget as Node | null
    if (related && (this.idiomCard?.contains(related) || target.contains(related))) return
    if (target === this.idiomTarget) this.scheduleIdiomHide()
  }

  private handleAnnotationHover = (e: Event) => {
    const target = e.target as HTMLElement
    if (!target.matches('.miaob-idiom, .miaob-quote, .miaob-xiehouyu')) return
    if (!target.matches('.miaob-idiom')) {
      this.showLegacyAnnotationTooltip(target)
      return
    }
    const related = (e as MouseEvent).relatedTarget as Node | null
    if (related && target.contains(related)) return
    if (target === this.idiomTarget && this.idiomCard) return
    this.clearIdiomTimer()
    this.idiomTarget = target
    this.idiomShowTimer = window.setTimeout(() => {
      if (this.idiomTarget === target && !this.idiomPinned) this.showIdiomCard(target).catch(() => {})
    }, 200)
  }

  private showLegacyAnnotationTooltip(target: HTMLElement) {
    document.querySelectorAll('.miaob-tooltip').forEach(el => el.remove())
    const url = target.dataset.url
    if (!url) return
    let parsed: URL
    try { parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol)) return } catch { return }
    const tooltip = document.createElement('div'); tooltip.className = 'miaob-tooltip'
    const header = document.createElement('div'); header.className = 'miaob-tooltip-header'; header.textContent = `${target.dataset.type === 'quote' ? '名句' : '歇后语'}：${target.textContent || ''}`
    const body = document.createElement('div'); body.className = 'miaob-tooltip-body'; body.textContent = target.title || '点击查看更多'
    const link = document.createElement('a'); link.className = 'miaob-tooltip-link'; link.textContent = `查看更多 → ${parsed.hostname.replace(/^www\./, '')}`; link.href = parsed.href; link.target = '_blank'; link.rel = 'noopener noreferrer'
    tooltip.append(header, body, link); document.body.appendChild(tooltip)
    const rect = target.getBoundingClientRect(); tooltip.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - tooltip.offsetWidth - 8))}px`; tooltip.style.top = `${rect.bottom + 4}px`
    const close = () => tooltip.remove(); target.addEventListener('mouseleave', close, { once: true }); tooltip.addEventListener('mouseleave', close, { once: true })
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
    this.idiomRequest?.abort()
    this.idiomRequest = null
    this.idiomRequestId++
    this.idiomCard?.remove()
    this.idiomCard = null
    this.idiomTarget = null
    this.idiomPinned = false
  }

  private positionIdiomCard(card: HTMLElement, target: HTMLElement) {
    const rect = target.getBoundingClientRect()
    const width = Math.min(400, window.innerWidth - 16)
    card.style.width = `${width}px`
    card.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`
    card.style.top = `${rect.bottom + 6 <= window.innerHeight - 8 ? rect.bottom + 6 : Math.max(8, rect.top - card.offsetHeight - 6)}px`
  }

  private async showIdiomCard(target: HTMLElement) {
    this.closeIdiomCard()
    this.idiomTarget = target
    const card = document.createElement('div')
    card.className = 'miaob-idiom-card'
    const loading = document.createElement('div')
    loading.className = 'miaob-card-loading'
    loading.textContent = '加载中…'
    card.appendChild(loading)
    document.body.appendChild(card)
    this.idiomCard = card
    this.positionIdiomCard(card, target)
    card.addEventListener('mouseenter', () => this.clearIdiomTimer())
    card.addEventListener('mouseleave', () => this.scheduleIdiomHide())
    const requestId = ++this.idiomRequestId
    try {
      const idiom = target.textContent || ''
      const cached = this.idiomDetailCache.get(idiom)
      const data = cached && cached.expiresAt > Date.now() ? cached.data : await this.fetchIdiomDetail(idiom)
      if (!cached || cached.expiresAt <= Date.now()) this.idiomDetailCache.set(idiom, { data, expiresAt: Date.now() + 3600000 })
      if (requestId !== this.idiomRequestId || this.idiomCard !== card) return
      this.renderIdiomCard(card, data)
      this.positionIdiomCard(card, target)
    } catch {
      if (requestId === this.idiomRequestId && this.idiomCard === card) {
        loading.textContent = '加载失败，请稍后重试'
      }
    }
  }

  private renderIdiomCard(card: HTMLElement, data: any) {
    card.replaceChildren()
    const header = document.createElement('div'); header.className = 'miaob-card-header'
    const title = document.createElement('strong'); title.className = 'miaob-card-title'; title.textContent = data.idiom || ''
    const pinyin = document.createElement('span'); pinyin.className = 'miaob-card-pinyin'; pinyin.textContent = data.pinyin || ''
    const close = document.createElement('button'); close.className = 'miaob-card-close'; close.type = 'button'; close.textContent = '✕'; close.setAttribute('aria-label', '关闭'); close.onclick = () => this.closeIdiomCard()
    header.append(title, pinyin, close); card.appendChild(header)
    const body = document.createElement('div'); body.className = 'miaob-card-body'
    const addSection = (label: string, value: unknown) => { if (!value) return; const section = document.createElement('section'); section.className = 'miaob-card-section'; const l = document.createElement('div'); l.className = 'miaob-card-label'; l.textContent = label; const v = document.createElement('div'); v.textContent = String(value); section.append(l, v); body.appendChild(section) }
    addSection('释义', data.explanation); addSection('出处', data.derivation)
    const relations = data.relations || { synonyms: data.synonym || [], antonyms: data.antonym || [] }
    const relationBox = document.createElement('div'); relationBox.className = 'miaob-card-relations'
    const addRelations = (label: string, values: unknown[], type: string) => { if (!Array.isArray(values) || !values.length) return; const group = document.createElement('div'); group.className = 'miaob-card-rel-group'; const l = document.createElement('div'); l.className = 'miaob-card-label'; l.textContent = label; const items = document.createElement('div'); items.className = 'miaob-card-rel-items'; values.slice(0, 8).forEach(value => { const b = document.createElement('button'); b.type = 'button'; b.className = 'miaob-card-rel-item'; b.textContent = String(value); b.onclick = () => { const found = this.findAnnotation(String(value), type); if (found) this.scrollToAnnotation(String(value), type); else this.openRelatedIdiom(String(value), card) }; items.appendChild(b) }); group.append(l, items); relationBox.appendChild(group) }
    addRelations('同义', relations.synonyms, 'idiom'); addRelations('反义', relations.antonyms, 'idiom'); if (relationBox.childElementCount) body.appendChild(relationBox); card.appendChild(body)
    const footer = document.createElement('div'); footer.className = 'miaob-card-footer'; const link = document.createElement('a'); link.className = 'miaob-card-link'; link.textContent = '🔗 汉典详解'; link.href = typeof data.zdicUrl === 'string' ? data.zdicUrl : '#'; link.target = '_blank'; link.rel = 'noopener noreferrer'; footer.appendChild(link)
    const add = document.createElement('button'); add.type = 'button'; add.className = 'miaob-card-add'; add.textContent = '📋 加入妙笔本'; add.onclick = () => { add.disabled = true; chrome.runtime.sendMessage({ type: 'ADD_MIAOBEN', idiom: data.idiom, sourceUrl: location.href }, (response) => { if (response?.needsActivation) { this.showActivationGuide(card, data.idiom, add); add.disabled = false; add.textContent = '📋 加入妙笔本' } else { add.disabled = false; add.textContent = response?.success ? '✓ 已加入妙笔本' : '加入失败，请重试' } }) }; footer.appendChild(add); card.appendChild(footer)
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
      const message = document.createElement('div'); message.className = 'miaob-card-loading'; message.textContent = '加载失败，请稍后重试'; card.replaceChildren(message)
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
        <div class="miaob-guide-title">📖 妙笔本</div>
        <div class="miaob-guide-desc">自动收藏你阅读中遇到的成语、名句，随时温习</div>
        <div class="miaob-guide-qr" id="miaob-guide-qr-${Date.now()}">
          <div class="miaob-guide-loading">加载二维码中...</div>
        </div>
        <div class="miaob-guide-hint">微信扫码激活，送 100 积分，可无限收藏</div>
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
        container.innerHTML = '<div class="miaob-guide-error">加载失败，请刷新重试</div>'
        return
      }
      const sessionId = startResp.data.sessionId

      // 获取二维码
      chrome.runtime.sendMessage({ type: 'WECHAT_QRCODE', sessionId }, (qrResp) => {
        if (!qrResp?.success) {
          container.innerHTML = '<div class="miaob-guide-error">二维码获取失败</div>'
          return
        }
        container.innerHTML = `<img src="${qrResp.data.qrcodeUrl}" alt="微信扫码" class="miaob-guide-qrimg" />`

        // 轮询扫码状态
        const poll = setInterval(() => {
          chrome.runtime.sendMessage({ type: 'WECHAT_STATUS', sessionId }, (statusResp) => {
            if (statusResp?.success && statusResp.data.scanned) {
              clearInterval(poll)
              container.innerHTML = '<div class="miaob-guide-success">✓ 扫码成功，激活中...</div>'
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
        container.innerHTML = '<div class="miaob-guide-success">🎉 激活成功！+100 积分</div>'
        // 更新本地激活状态
        chrome.storage.local.set({ isActivated: true, credits: resp.data?.credits || 0 })
        // 自动重试加入妙笔本
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: 'ADD_MIAOBEN', idiom, sourceUrl: location.href }, (addResp) => {
            if (addResp?.success) {
              addBtn.textContent = '✓ 已加入妙笔本'
            } else {
              addBtn.textContent = '📋 加入妙笔本'
            }
          })
        }, 800)
        setTimeout(() => { container.closest('.miaob-activation-guide')?.remove() }, 2000)
      } else {
        container.innerHTML = '<div class="miaob-guide-error">激活失败，请重试</div>'
      }
    })
  }

  /**
   * 把文本块分组：长块独立一组，相邻短块合并成一组（减少 API 调用）
   * 每组记录每个子块在组文本中的精确偏移
   */
  private groupBlocks(blocks: StaticTextBlock[]): Array<{ text: string; items: Array<{ block: StaticTextBlock; offset: number }> }> {
    const groups: Array<{ text: string; items: Array<{ block: StaticTextBlock; offset: number }> }> = []
    let current: { text: string; items: Array<{ block: StaticTextBlock; offset: number }> } | null = null
    const MAX_GROUP = 2000

    for (const block of blocks) {
      if (block.text.length >= 300 || !current || current.text.length + block.text.length > MAX_GROUP) {
        if (current && current.items.length > 0) groups.push(current)
        current = { text: '', items: [] }
      }
      current.items.push({ block, offset: current.text.length })
      current.text += block.text
    }
    if (current && current.items.length > 0) groups.push(current)

    return groups
  }

  /**
   * 在块文本中定位 original 的位置（替代偏移映射）
   * 优先找偏移附近（±10字符）的匹配；找不到则找所有出现位置。
   * 解决聚合文本+偏移在重复文本时错位的问题。
   */
  private locateText(blockText: string, original: string, approxLocal: number): Array<{ start: number; end: number }> {
    if (!original) return []
    const len = original.length
    if (len === 0) return []

    // 1. 偏移附近（±10字符窗口）查找
    const winStart = Math.max(0, approxLocal - 10)
    const winEnd = Math.min(blockText.length, approxLocal + 10 + len)
    const window = blockText.substring(winStart, winEnd)
    const winIdx = window.indexOf(original)
    if (winIdx >= 0) {
      return [{ start: winStart + winIdx, end: winStart + winIdx + len }]
    }

    // 2. 全文本查找所有出现
    const results: Array<{ start: number; end: number }> = []
    let idx = blockText.indexOf(original)
    while (idx !== -1) {
      results.push({ start: idx, end: idx + len })
      idx = blockText.indexOf(original, idx + len)
    }
    if (results.length > 0) return results

    // 3. 归一化匹配兜底（处理全半角、空格等差异）
    const normOriginal = this.normalizeText(original)
    const normBlock = this.normalizeText(blockText)
    let normIdx = normBlock.indexOf(normOriginal)
    if (normIdx >= 0) {
      // 将归一化位置映射回原始文本位置
      const origStart = this.mapNormalizedToOriginal(blockText, normIdx)
      const origEnd = this.mapNormalizedToOriginal(blockText, normIdx + normOriginal.length)
      if (origStart !== -1 && origEnd !== -1 && origEnd > origStart) {
        return [{ start: origStart, end: origEnd }]
      }
    }

    return []
  }

  /**
   * 文本归一化：统一全半角、去除多余空格，用于模糊匹配
   */
  private normalizeText(text: string): string {
    return text
      .replace(/\s+/g, '')           // 去除所有空白
      .replace(/[！-～]/g, c =>  // 全角转半角
        String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[　]/g, ' ')      // 全角空格转半角
      .toLowerCase()
  }

  /**
   * 将归一化文本位置映射回原始文本位置
   */
  private mapNormalizedToOriginal(original: string, normPos: number): number {
    let normIdx = 0
    for (let i = 0; i < original.length; i++) {
      const ch = original[i]
      if (/\s/.test(ch)) continue  // 跳过空白（归一化时去除）
      if (normIdx === normPos) return i
      normIdx++
    }
    return -1
  }

  /**
   * 显示服务端不可用提示
   */
  private showServerUnavailable() {
    let el = document.getElementById('miaob-server-error')
    if (!el) {
      el = document.createElement('div')
      el.id = 'miaob-server-error'
      el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#dc2626;color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.3);'
      document.body.appendChild(el)
    }
    el.textContent = '⚠️ 检查服务暂时不可用，请稍后刷新页面重试'
    el.style.display = 'block'
  }

  watchPageContent() {
    const observer = new MutationObserver((mutations) => {
      if (this.isMarking) return

      const changedNodes: Node[] = []

      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          this.resetStaticCheckState(node)
          changedNodes.push(node)
        })

        if (mutation.type === 'characterData' && mutation.target.nodeType === Node.TEXT_NODE) {
          this.resetStaticCheckState(mutation.target)
          changedNodes.push(mutation.target)
        }
      })

      if (changedNodes.length === 0) {
        return
      }

      if (this.pageCheckTimer) {
        clearTimeout(this.pageCheckTimer)
      }

      this.pageCheckTimer = window.setTimeout(() => {
        changedNodes.forEach((node) => {
          this.checkNodeTree(node).catch((error) => {
            console.error('节点树检查失败:', error)
          })
        })
      }, 800)
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    // 滚动监听：小说/资讯站滚动加载内容，滚动停止后检查新 DOM
    let scrollTimer: number | null = null
    window.addEventListener('scroll', () => {
      if (this.isMarking) return
      if (scrollTimer) clearTimeout(scrollTimer)
      scrollTimer = window.setTimeout(() => {
        // 检查整个文档中尚未检查的块
        this.checkPageContent().catch(() => {})
      }, 1500)
    }, { passive: true })
  }

  // 获取所有文本节点
  private getTextNodes(element: Node): Text[] {
    const textNodes: Text[] = []

    if (this.shouldSkipNode(element)) {
      return textNodes
    }

    // 跳过脚本、样式、表单控件等非正文内容
    const skipTags = [
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT',
    ]
    if (element.nodeType === Node.ELEMENT_NODE) {
      const tagName = (element as Element).tagName
      if (skipTags.includes(tagName)) {
        return textNodes
      }
    }

    // 如果是文本节点
    if (element.nodeType === Node.TEXT_NODE) {
      const text = element.textContent?.trim()
      if (text && text.length > 0) {
        textNodes.push(element as Text)
      }
    } else {
      // 递归子节点
      for (const child of Array.from(element.childNodes)) {
        textNodes.push(...this.getTextNodes(child))
      }
    }

    return textNodes
  }

  private shouldSkipNode(node: Node): boolean {
    const element = node.nodeType === Node.ELEMENT_NODE
      ? node as Element
      : node.parentElement

    if (!element) {
      return false
    }

    return Boolean(
      element.closest(
        '.miaob-inline-wrapper, .miaob-wrapper, .miaob-tooltip, #miaob-panel-root, input, textarea, [contenteditable="true"]'
      )
    )
  }

  private async checkNodeTree(node: Node) {
    if (this.shouldSkipNode(node)) {
      return
    }

    const blocks = this.collectStaticTextBlocks(node)
    if (blocks.length === 0) return

    // 动态加载的内容：分组检查（与整页检查一致，文本匹配定位）
    const groups = this.groupBlocks(blocks)
    for (const group of groups) {
      const result = await this.checker.check(group.text)
      if (result === null) {
        this.showServerUnavailable()
        break
      }
      if (result.errors.length === 0 && result.idioms.length === 0 && result.phrases.length === 0 && (result.expressions || []).length === 0) continue

      for (const item of group.items) {
        const block = item.block
        if (this.staticCheckedElements.has(block.root)) continue
        const blockText = block.text
        const marks: Array<{ start: number; end: number; kind: 'error' | 'idiom' | 'quote' | 'xiehouyu' | 'expression'; error?: TextError; idiom?: { idiom: string; derivation?: string; explanation?: string }; phrase?: { text: string; answer?: string; from?: string }; expression?: { text: string; type: string } }> = []

        // 错误
        for (const e of result.errors) {
          const orig = e.original || ''
          if (!orig) continue
          for (const pos of this.locateText(blockText, orig, e.start - item.offset)) {
            marks.push({ start: pos.start, end: pos.end, kind: 'error', error: e })
          }
        }

        // 成语
        for (const i of result.idioms) {
          const orig = i.idiom || ''
          if (!orig) continue
          for (const pos of this.locateText(blockText, orig, i.start - item.offset)) {
            marks.push({ start: pos.start, end: pos.end, kind: 'idiom', idiom: { idiom: i.idiom, derivation: i.derivation, explanation: i.explanation } })
          }
        }

        // 名句/歇后语
        for (const p of result.phrases) {
          const orig = p.text || ''
          if (!orig) continue
          for (const pos of this.locateText(blockText, orig, p.start - item.offset)) {
            marks.push({ start: pos.start, end: pos.end, kind: p.type === 'quote' ? 'quote' : 'xiehouyu', phrase: { text: p.text, answer: p.answer, from: p.from } })
          }
        }

        for (const expression of result.expressions || []) {
          if (!expression?.text || expression.score < 0.8) continue
          for (const pos of this.locateText(blockText, expression.text, expression.start - item.offset)) {
            marks.push({ start: pos.start, end: pos.end, kind: 'expression', expression: { text: expression.text, type: expression.type } })
          }
        }

        if (marks.length > 0) {
          this.markBlock(block, marks)
        }
      }
    }
    this.renderPanel()
  }

  private collectStaticTextBlocks(root: Node): StaticTextBlock[] {
    const blocks = new Map<HTMLElement, StaticTextBlock>()
    const textNodes = this.getTextNodes(root)
    console.log(`[miaob] 找到 ${textNodes.length} 个文本节点`)

    for (const textNode of textNodes) {
      const blockRoot = this.getStaticBlockRoot(textNode)
      if (!blockRoot) {
        console.log(`[miaob] 文本节点无块根, 跳过: "${(textNode.textContent || '').substring(0, 20)}"`)
        continue
      }

      const text = textNode.textContent || ''
      if (text.length === 0) {
        continue
      }

      let block = blocks.get(blockRoot)
      if (!block) {
        block = {
          root: blockRoot,
          text: '',
          segments: [],
        }
        blocks.set(blockRoot, block)
      }

      const start = block.text.length
      block.text += text
      block.segments.push({
        node: textNode,
        start,
        end: start + text.length,
      })
    }

    return Array.from(blocks.values()).filter(block => block.text.trim().length > 0 && this.isLikelyMainText(block.text))
  }

  /**
   * 启发式判断一段文本是否像"正文"，而非导航/面包屑/页脚/边栏。
   * 不猜 DOM 结构（不同网站结构各异），只用内容信号：
   *  - 中文正文含多个句号/逗号，句子较完整
   *  - 导航/面包屑/链接列表通常短、无句号、由顿号/箭头/竖线分隔
   *  - 页脚版权、ICP 备案、"版权所有"等
   *  - 单词重复拼接（如"下一页下一页"）等边栏装饰
   */
  private isLikelyMainText(text: string): boolean {
    const t = text.trim()
    if (t.length < 4) return false

    // 版权 / 备案 / 常见页脚信号
    if (/版权所有|Copyright|ICP备|保留所有权利|建议使用.*浏览器|技术支持|友情链接/.test(t)) {
      return false
    }

    // 导航/面包屑：以顿号、竖线、箭头、冒号分隔，且整体无句号
    const noSentence = !/[。！？；]/.test(t)
    if (noSentence) {
      // 纯链接/菜单：多段短词拼接（顿号或空格分隔的长串）
      const navLike = /^[^\s，。！？；：""''（）()·\-—|]+([\s·｜|>›»/、]+[^\s，。！？；：""''（）()·\-—|]+)+$/.test(t)
      if (navLike) return false
    }

    // 正文标志：有句号且长度足够，或含较多汉字标点
    if (/[。！？]/.test(t) && t.length >= 20) {
      return true
    }

    // 长段落（≥60 字）默认当作可检查正文
    if (t.length >= 60) {
      return true
    }

    // 短文本需要至少一句完整语（含逗号或句号）才保留
    return /[，。]/.test(t) && t.length >= 10
  }

  private getStaticBlockRoot(textNode: Text): HTMLElement | null {
    let current = textNode.parentElement

    const blockTags = [
      'p', 'li', 'td', 'th', 'blockquote', 'article', 'section', 
      'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div',
      'span', 'a', 'strong', 'em', 'b', 'i'
    ]

    // 结构标签——底部导航、页脚、侧栏、头部通常不是正文
    const structureTags = ['NAV', 'FOOTER', 'HEADER', 'ASIDE']
    // 控件标签——按钮、表单等 UI 元素内的文字不是正文
    const controlTags = ['BUTTON', 'FORM', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'OPTION']

    let candidateBlock: HTMLElement | null = null

    while (current && current !== document.body) {
      // 一进入导航/页脚/侧栏/头部，整个块就不作为正文
      if (structureTags.includes(current.tagName)) {
        return null
      }
      // 控件内文字不作为正文（如按钮/下拉里的文字）
      if (controlTags.includes(current.tagName)) {
        return null
      }

      if (current.matches(blockTags.join(', '))) {
        if (current.tagName === 'DIV' || current.tagName === 'SPAN') {
          const textLen = (current.textContent || '').trim().length
          if (textLen >= 4) {
            // 记下候选块，但继续向上检查是否在控件内（如 span 在 button 里）
            if (!candidateBlock) candidateBlock = current
          }
        } else {
          // 非 div/span 块标签（p、li 等），直接作为块根
          // 但先确认没有控件祖先（在 while 里已检查）
          return current
        }
      }
      current = current.parentElement
    }

    // 有候选块（div/span）且未落入控件/结构标签内
    if (candidateBlock) {
      return candidateBlock
    }

    // 落在结构标签内则无正文块
    if (current && current.tagName && structureTags.includes(current.tagName)) {
      return null
    }

    return textNode.parentElement
  }

  private resetStaticCheckState(node: Node) {
    let current = node.nodeType === Node.ELEMENT_NODE
      ? node as HTMLElement
      : node.parentElement

    while (current && current !== document.body) {
      if (current.matches('p, li, td, th, blockquote, article, section, main, h1, h2, h3, h4, h5, h6, div')) {
        this.staticCheckedElements.delete(current)
      }
      current = current.parentElement
    }
  }

  /**
   * 统一标注一个块的所有内容（错误/成语/名句/歇后语）
   * 一次遍历 segments，一次性替换 DOM——避免多次替换导致后续节点失效
   */
  private markBlock(block: StaticTextBlock, marks: Array<{ start: number; end: number; kind: 'error' | 'idiom' | 'quote' | 'xiehouyu' | 'expression'; error?: TextError; idiom?: { idiom: string; derivation?: string; explanation?: string }; phrase?: { text: string; answer?: string; from?: string }; expression?: { text: string; type: string } }>) {
    this.isMarking = true

    // 同位置去重：同一位置多个标注（如"愚公移山"既是成语又是歇后语），
    // 优先级：error > idiom > quote > xiehouyu，只保留最高优先级
    const priority = { error: 0, idiom: 1, quote: 2, xiehouyu: 3, expression: 4 } as Record<string, number>
    const dedup = new Map<string, typeof marks[number]>()
    for (const m of marks) {
      const key = `${m.start}-${m.end}`
      const existing = dedup.get(key)
      if (!existing || priority[m.kind] < priority[existing.kind]) {
        dedup.set(key, m)
      }
    }
    const sorted = Array.from(dedup.values()).sort((a, b) => a.start - b.start)

    // 记录错误到全局列表（用于右侧面板）
    const errorMarks = sorted.filter(m => m.kind === 'error' && m.error)
    if (errorMarks.length > 0) {
      this.allErrors.push(...errorMarks.map(m => m.error!))
    }

    for (const segment of block.segments) {
      const parent = segment.node.parentElement
      if (!parent || !document.contains(segment.node)) continue

      const text = segment.node.textContent || ''
      const overlapping = sorted
        .filter(m => m.end > segment.start && m.start < segment.end)
        .map(m => ({
          ...m,
          localStart: Math.max(0, m.start - segment.start),
          localEnd: Math.min(text.length, m.end - segment.start),
        }))
        .filter(m => m.localEnd > m.localStart)

      if (overlapping.length === 0) continue

      const wrapper = document.createElement('span')
      wrapper.className = 'miaob-inline-wrapper'
      wrapper.style.position = 'relative'
      wrapper.style.display = 'inline'

      let lastIndex = 0
      const fragments: Node[] = []

      for (const m of overlapping) {
        if (m.localStart > lastIndex) {
          fragments.push(document.createTextNode(text.substring(lastIndex, m.localStart)))
        }
        fragments.push(this.createMarkSpan(m, text.substring(m.localStart, m.localEnd)))
        lastIndex = m.localEnd
      }

      if (lastIndex < text.length) {
        fragments.push(document.createTextNode(text.substring(lastIndex)))
      }

      try {
        fragments.forEach(frag => wrapper.appendChild(frag))
        if (segment.node.parentNode) {
          segment.node.parentNode.replaceChild(wrapper, segment.node)
        }
      } catch (e) {
        console.error('[miaob] markBlock replaceChild 异常:', e)
      }
    }
    this.isMarking = false
  }

  /**
   * 根据标注类型创建对应的 span 元素
   */
  private createMarkSpan(
    mark: { kind: string; error?: TextError; idiom?: { idiom: string; derivation?: string; explanation?: string }; phrase?: { text: string; answer?: string; from?: string }; expression?: { text: string; type: string } },
    text: string,
  ): HTMLSpanElement {
    const span = document.createElement('span')

    if (mark.kind === 'error' && mark.error) {
      const e = mark.error
      span.className = `miaob-error miaob-error-${e.type}`
      span.title = e.message || ''
      span.dataset.message = e.message || ''
      span.dataset.suggestion = e.suggestion || ''
    } else if (mark.kind === 'idiom' && mark.idiom) {
      const i = mark.idiom
      span.className = 'miaob-idiom'
      span.title = [
        i.derivation ? `出处：${i.derivation}` : '',
        i.explanation ? `解释：${i.explanation}` : '',
      ].filter(Boolean).join('\n') || i.idiom
      span.dataset.type = 'idiom'
      span.dataset.url = `https://www.zdic.net/hans/${encodeURIComponent(i.idiom)}`
    } else if (mark.kind === 'quote' && mark.phrase) {
      const p = mark.phrase
      span.className = 'miaob-quote'
      span.title = p.from ? `出处：${p.from}` : '名句'
      span.dataset.type = 'quote'
      span.dataset.url = `https://so.gushiwen.cn/search.aspx?value=${encodeURIComponent(p.text)}&type=title`
    } else if (mark.kind === 'xiehouyu' && mark.phrase) {
      const p = mark.phrase
      span.className = 'miaob-xiehouyu'
      span.title = p.answer ? `${p.text}——${p.answer}` : '歇后语'
      span.dataset.type = 'xiehouyu'
      span.dataset.url = `https://www.xiehouyu.cn/search.php?keyword=${encodeURIComponent(p.text)}`
    } else if (mark.kind === 'expression' && mark.expression) {
      span.className = 'miaob-expression'
      span.dataset.type = 'expression'
      span.title = ({ golden_sentence: '金句', parallelism: '排比', contrast: '对比', rhetorical_question: '设问', numeric_impact: '数字冲击' } as Record<string, string>)[mark.expression.type] || '表达高光'
    }

    span.textContent = text
    return span
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
