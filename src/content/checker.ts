import type { TextError } from '../shared/types'
import { findLocalCulture } from './local-culture-checker'

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
  quota?: { remaining: number; isPaid: boolean; used: number; limit: number }
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

  /** 本地完成确定性匹配；表达高光继续由服务端分析，失败时保留本地结果。 */
  async check(text: string): Promise<CheckResult | null> {
    if (!text || text.trim().length === 0) return null
    if (this.cache.has(text)) return this.cache.get(text)!
    const culture = findLocalCulture(text)
    const result: CheckResult = { errors: [], ...culture, expressions: [] }
    if (this.isContextValid()) {
      try {
        const remote = await new Promise<any>((resolve, reject) => {
          chrome.runtime.sendMessage({ type: 'CHECK_TEXT', data: { text } }, response => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
            else if (response?.success) resolve(response.data || {})
            else reject(new Error(response?.error || 'expression analysis failed'))
          })
        })
        result.expressions = remote.expressions || []
        result.quota = remote.quota || undefined
      } catch {
        // 本地文化匹配不依赖服务端；表达高光在服务不可用时暂不显示。
      }
    }
    this.cache.set(text, result)
    return result
  }

  clearCache() {
    this.cache.clear()
  }
}
