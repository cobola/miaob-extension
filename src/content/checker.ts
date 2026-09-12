import type { TextError } from '../shared/types'

export interface IdiomMatch {
  idiom: string
  start: number
  end: number
  derivation: string
  explanation: string
  example: string
  pinyin: string
}

export interface PhraseMatch {
  text: string
  start: number
  end: number
  type: 'xiehouyu' | 'quote'
  answer?: string
  from?: string
}
export interface ExpressionFinding { type: string; text: string; start: number; end: number; score: number; tags?: string[] }

export interface CheckResult {
  errors: TextError[]
  idioms: IdiomMatch[]
  phrases: PhraseMatch[]
  expressions: ExpressionFinding[]
}

export class TextChecker {
  private cache: Map<string, CheckResult> = new Map()

  isContextValid(): boolean {
    try {
      return chrome.runtime?.id !== undefined
    } catch {
      return false
    }
  }

  /**
   * 检查文本，返回完整结果（错误 + 成语 + 名句/歇后语）
   * 全部走服务端 API（规则引擎 + LLM 裁判 + 文化库匹配）
   * 服务端不可用时返回 null（由调用方提示用户）
   */
  async check(text: string): Promise<CheckResult | null> {
    if (!this.isContextValid()) return null
    if (!text || text.trim().length === 0) return null  // 跳过空文本
    if (this.cache.has(text)) return this.cache.get(text)!

    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'CHECK_TEXT', data: { text } },
          (response) => {
            if (!this.isContextValid()) { resolve(null); return }
            if (chrome.runtime.lastError) {
              console.warn('[TextChecker] 服务端不可用:', chrome.runtime.lastError.message)
              resolve(null)
              return
            }
            if (response?.success) {
              const data = response.data || {}
              const result: CheckResult = {
                // 错误纠错功能已下线；阅读报告只保留正向发现。
                errors: [],
                idioms: data.idioms || [],
                phrases: data.phrases || [],
                expressions: data.expressions || [],
              }
              this.cache.set(text, result)
              resolve(result)
            } else {
              console.warn('[TextChecker] 检查失败:', response?.error)
              resolve(null)
            }
          }
        )
      } catch (error) {
        console.warn('[TextChecker] 请求异常:', error)
        resolve(null)
      }
    })
  }

  clearCache() {
    this.cache.clear()
  }
}
