import type { TextError } from '../shared/types'
import { findLocalCulture } from './local-culture-checker'
import { hashText } from './dom/block'
import type { Mark, RemoteCheckResponse, RemoteMatch, TextBlock } from './dom/types'

export type CheckField = 'errors' | 'idioms' | 'phrases' | 'expressions'

export interface CheckableBlock {
  id: string
  hash: string
  text: string
}

export interface Quota {
  remaining: number
  isPaid: boolean
  used: number
  limit: number
}

export interface CheckBatchResult {
  marks: Map<string, Mark[]>
  quota?: Quota
  failed: boolean
  /** 失败原因，直接打到页面 console，省得只剩一句"服务不可用" */
  reason?: string
}

const LOCAL_CACHE_LIMIT = 500
const REMOTE_CACHE_LIMIT = 500
const CACHE_SEP = '|'

/**
 * 消息通道。
 * 消息必须是可结构化克隆的纯数据——带 DOM 节点会变成 `{}` 传过去（Chrome 走 JSON 序列化），
 * 所以上行前一律拍平。失败原因不许吞掉，否则页面上只剩一句"服务不可用"。
 */
function sendMessage<T>(message: unknown, label = ''): Promise<{ data?: T; error?: string }> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          const error = chrome.runtime.lastError.message || 'runtime error'
          console.warn(`[miaob] ${label} 消息失败:`, error)
          resolve({ error })
        } else if (response?.success) {
          resolve({ data: (response.data ?? undefined) as T | undefined })
        } else {
          const error = typeof response?.error === 'string' && response.error ? response.error : '后台返回失败'
          console.warn(`[miaob] ${label} 后台返回失败:`, error)
          resolve({ error })
        }
      })
    } catch (error) {
      const message2 = error instanceof Error ? error.message : String(error)
      console.warn(`[miaob] ${label} 消息抛错:`, error)
      resolve({ error: message2 })
    }
  })
}

function toMark(block: CheckableBlock, match: RemoteMatch): Mark | null {
  const exact = block.text.slice(match.start, match.end) === match.matchedText

  if (match.kind === 'error') {
    if (!match.error) return null
    return { start: match.start, end: match.end, kind: 'error', matchedText: match.matchedText, error: match.error }
  }
  if (match.kind === 'idiom') {
    if (!match.idiom || !exact) return null
    return {
      start: match.start, end: match.end, kind: 'idiom', matchedText: match.matchedText,
      idiom: { idiom: match.idiom.idiom, derivation: match.idiom.derivation, explanation: match.idiom.explanation },
    }
  }
  if (match.kind === 'quote' || match.kind === 'xiehouyu') {
    if (!match.phrase || !exact) return null
    return {
      start: match.start, end: match.end, kind: match.kind, matchedText: match.matchedText,
      phrase: { text: match.phrase.text, answer: match.phrase.answer, from: match.phrase.from },
    }
  }
  if (match.kind === 'expression') {
    if (!exact) return null
    return {
      start: match.start, end: match.end, kind: 'expression', matchedText: match.matchedText,
      expression: {
        text: match.expression ? match.expression.text : match.matchedText,
        type: match.expression ? match.expression.type : '',
        score: match.expression ? match.expression.score : undefined,
      },
    }
  }
  return null
}

/**
 * 检查器。
 *
 * 与旧实现的差异：
 *  - 以块为单位送检（带 id + hash），服务端把偏移换算回块内并回传 matchedText，
 *    客户端只做 hash + slice 的精确校验，不再用 indexOf 三级兜底猜位置
 *  - 本地成语/名句按文本缓存；远端按需只请求指定字段
 *  - 缓存带上限，避免长会话无界增长
 */
export class TextChecker {
  private localCache = new Map<string, Mark[]>()
  private remoteCache = new Map<string, Mark[]>()

  isContextValid(): boolean {
    try {
      return chrome.runtime?.id !== undefined
    } catch {
      return false
    }
  }

  /** 本地文化匹配：块内 UTF-16 偏移，零网络开销 */
  localMarks(text: string): Mark[] {
    const hit = this.localCache.get(text)
    if (hit) return hit

    const culture = findLocalCulture(text)
    const marks: Mark[] = []
    for (const idiom of culture.idioms) {
      marks.push({
        start: idiom.start,
        end: idiom.end,
        kind: 'idiom',
        matchedText: idiom.idiom,
        idiom: { idiom: idiom.idiom, derivation: idiom.derivation, explanation: idiom.explanation },
      })
    }
    for (const phrase of culture.phrases) {
      marks.push({
        start: phrase.start,
        end: phrase.end,
        kind: phrase.type === 'quote' ? 'quote' : 'xiehouyu',
        matchedText: phrase.text,
        phrase: { text: phrase.text, answer: phrase.answer, from: phrase.from },
      })
    }

    if (this.localCache.size >= LOCAL_CACHE_LIMIT) this.localCache.clear()
    this.localCache.set(text, marks)
    return marks
  }

  /**
   * 批量请求远端标注。单批失败不抛错，由 failed 标记。
   * 命中缓存的块不上行。
   */
  async checkRemote(
    blocks: Array<CheckableBlock | TextBlock>,
    only: CheckField[] = ['expressions'],
  ): Promise<CheckBatchResult> {
    const marks = new Map<string, Mark[]>()
    const pending: CheckableBlock[] = []
    const prefix = only.join(',') + CACHE_SEP

    for (const block of blocks) {
      const cached = this.remoteCache.get(prefix + block.text)
      if (cached) marks.set(block.id, cached)
      else pending.push(block)
    }
    if (pending.length === 0) return { marks, failed: false }
    if (!this.isContextValid()) return { marks, failed: true, reason: '扩展上下文已失效，请刷新页面' }

    // 上行只留纯数据：TextBlock 里的 root / segments.node 是 DOM 节点，
    // 序列化后会变成一堆 `{}`，纯属白传。
    const payload = pending.map((b) => ({ id: b.id, hash: b.hash, text: b.text }))
    const { data: resp, error } = await sendMessage<RemoteCheckResponse>(
      { type: 'CHECK_BLOCKS', data: { blocks: payload, only, lang: 'zh' } },
      'CHECK_BLOCKS',
    )
    if (!resp || !Array.isArray(resp.blocks)) {
      return { marks, failed: true, reason: error || '后台未返回 blocks' }
    }

    const byId = new Map(resp.blocks.map((b) => [b.id, b]))
    for (const block of pending) {
      const remote = byId.get(block.id)
      if (!remote) continue
      if (remote.hash !== undefined && remote.hash !== block.hash) continue

      const blockMarks: Mark[] = []
      for (const match of remote.matches || []) {
        const mark = toMark(block, match)
        if (mark) blockMarks.push(mark)
      }
      if (this.remoteCache.size >= REMOTE_CACHE_LIMIT) this.remoteCache.clear()
      this.remoteCache.set(prefix + block.text, blockMarks)
      marks.set(block.id, blockMarks)
    }

    return { marks, quota: resp.quota, failed: false }
  }

  /** 可编辑元素：只请求规则纠错结果（服务端本地规则引擎，不走 LLM） */
  async checkEditable(text: string): Promise<{ errors: TextError[]; failed: boolean; reason?: string }> {
    const result = await this.checkRemote([{ id: 'e0', hash: hashText(text), text }], ['errors'])
    const errors: TextError[] = []
    for (const mark of result.marks.get('e0') || []) {
      if (mark.kind === 'error' && mark.error) errors.push(mark.error)
    }
    return { errors, failed: result.failed, reason: result.reason }
  }

  clearCache() {
    this.localCache.clear()
    this.remoteCache.clear()
  }
}
