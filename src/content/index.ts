// Content Script - 注入到页面
import type { TextError, UserConfig } from './shared/types'
import { TextExtractor } from './extractor'
import { TextChecker } from './checker'
import { ErrorMarker } from './marker'
import { getFingerprint } from '../lib/fingerprint'
import { userService } from '../services/user.service'
import { feedbackService } from '../services/feedback.service'
import './styles.css'
import { createRoot } from 'react-dom/client'
import { ErrorReportPanel } from '../components/ErrorReportPanel'
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
  } = { errors: [], idioms: [], quotes: [], xiehouyu: [] }
  private panelRoot: ReturnType<typeof createRoot> | null = null
  private userId: string = ''

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

  // Deduplicate errors by original text and type
  private deduplicateErrors(errors: TextError[]): TextError[] {
    const seen = new Map<string, TextError>()

    for (const error of errors) {
      const key = `${error.type}:${error.original}`
      if (!seen.has(key)) {
        seen.set(key, error)
      }
    }

    return Array.from(seen.values())
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
      setTimeout(() => {
        this.checkPageContent()
      }, 2000)
    }

    this.watchPageContent()

    this.setupKeyboardShortcuts()
  }

  async initializeUser() {
    try {
      const fingerprint = await getFingerprint()

      // Check if user exists in storage
      const stored = await chrome.storage.local.get(['userId', 'fingerprint'])

      if (stored.userId && stored.fingerprint === fingerprint) {
        this.userId = stored.userId as string
        console.log('已有用户:', this.userId)
        return
      }

      // Create anonymous user
      const result = await userService.createAnonymousUser()
      this.userId = result.userId

      await chrome.storage.local.set({
        userId: result.userId,
        fingerprint,
        credits: result.credits,
        inviteCode: result.inviteCode,
        isActivated: false
      })

      console.log('创建匿名用户:', result)
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

    const allErrors = this.deduplicateErrors(this.allErrors)
    const idiomSet = new Map<string, { idiom: string; derivation?: string; explanation?: string }>()
    const quoteSet = new Map<string, { text: string; from?: string }>()
    const xiehouyuSet = new Map<string, { text: string; answer?: string }>()
    for (const f of this.allFindings) {
      if (f.kind === 'idiom' && f.idiom) idiomSet.set(f.idiom.idiom, f.idiom)
      else if (f.kind === 'quote' && f.phrase) quoteSet.set(f.phrase.text, f.phrase)
      else if (f.kind === 'xiehouyu' && f.phrase) xiehouyuSet.set(f.phrase.text, f.phrase)
    }
    this.reportData = {
      errors: allErrors,
      idioms: [...idiomSet.values()],
      quotes: [...quoteSet.values()],
      xiehouyu: [...xiehouyuSet.values()],
    }

    this.panelRoot.render(
      createElement(ErrorReportPanel, {
        errors: this.reportData.errors,
        idioms: this.reportData.idioms,
        quotes: this.reportData.quotes,
        xiehouyu: this.reportData.xiehouyu,
        onFeedback: this.handleFeedback.bind(this),
        onErrorClick: this.handleErrorClick.bind(this),
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
      strictness: 'standard' as UserConfig['strictness'],
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

        // 把结果映射回各个原始块（文本匹配定位，不依赖跨块偏移）
        for (const item of group.items) {
          const block = item.block
          const blockText = block.text
          const marks: Array<{ start: number; end: number; kind: 'error' | 'idiom' | 'quote' | 'xiehouyu'; error?: TextError; idiom?: { idiom: string; derivation?: string; explanation?: string }; phrase?: { text: string; answer?: string; from?: string } }> = []

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

          if (marks.length > 0) {
            this.markBlock(block, marks)
          }
          this.staticCheckedElements.add(block.root)
        }
      }

      if (serverUnavailable) {
        this.showServerUnavailable()
      }

      // 展示阅读报告（成语/名句/错误汇总）

      this.renderPanel()
      // 初始化标注悬浮卡片（含查看更多链接）
      this.initAnnotationTooltips()
    } catch (error) {
      console.error('页面内容检查失败:', error)
    }

    console.log('页面内容检查完成')
  }

  /**
   * 初始化标注悬浮卡片（含查看更多链接）
   */
  private initAnnotationTooltips() {
    // 移除旧的监听（防重复）
    document.removeEventListener('mouseover', this.handleAnnotationHover)
    document.addEventListener('mouseover', this.handleAnnotationHover)
  }

  private handleAnnotationHover = (e: Event) => {
    const target = e.target as HTMLElement
    if (!target.matches('.miaob-idiom, .miaob-quote, .miaob-xiehouyu')) return

    // 移除旧 tooltip
    document.querySelectorAll('.miaob-tooltip').forEach(el => el.remove())

    const url = target.dataset.url
    if (!url) return

    const typeLabel = target.dataset.type === 'idiom' ? '成语' : target.dataset.type === 'quote' ? '名句' : '歇后语'
    const siteUrl = new URL(url)
    const siteName = siteUrl.hostname.replace('www.', '')

    const tooltip = document.createElement('div')
    tooltip.className = 'miaob-tooltip'
    tooltip.innerHTML = `
      <div class="miaob-tooltip-header">${typeLabel}：${target.textContent}</div>
      <div class="miaob-tooltip-body">${target.title || '点击查看更多'}</div>
      <a href="${url}" target="_blank" class="miaob-tooltip-link">查看更多 → ${siteName}</a>
    `
    document.body.appendChild(tooltip)

    const rect = target.getBoundingClientRect()
    tooltip.style.left = `${rect.left + window.scrollX}px`
    tooltip.style.top = `${rect.bottom + window.scrollY + 4}px`

    // 鼠标移出时移除
    const removeTooltip = () => {
      tooltip.remove()
      target.removeEventListener('mouseout', removeTooltip)
    }
    target.addEventListener('mouseout', removeTooltip)
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
    return results
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
      if (result.errors.length === 0 && result.idioms.length === 0 && result.phrases.length === 0) continue

      for (const item of group.items) {
        const block = item.block
        if (this.staticCheckedElements.has(block.root)) continue
        const blockText = block.text
        const marks: Array<{ start: number; end: number; kind: 'error' | 'idiom' | 'quote' | 'xiehouyu'; error?: TextError; idiom?: { idiom: string; derivation?: string; explanation?: string }; phrase?: { text: string; answer?: string; from?: string } }> = []

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
  private markBlock(block: StaticTextBlock, marks: Array<{ start: number; end: number; kind: 'error' | 'idiom' | 'quote' | 'xiehouyu'; error?: TextError; idiom?: { idiom: string; derivation?: string; explanation?: string }; phrase?: { text: string; answer?: string; from?: string } }>) {
    this.isMarking = true

    // 同位置去重：同一位置多个标注（如"愚公移山"既是成语又是歇后语），
    // 优先级：error > idiom > quote > xiehouyu，只保留最高优先级
    const priority = { error: 0, idiom: 1, quote: 2, xiehouyu: 3 } as Record<string, number>
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
    mark: { kind: string; error?: TextError; idiom?: { idiom: string; derivation?: string; explanation?: string }; phrase?: { text: string; answer?: string; from?: string } },
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
