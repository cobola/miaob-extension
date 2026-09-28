import type { TextError } from '../../shared/types'

/** 一个文本节点在所属块内的偏移区间（UTF-16） */
export interface TextSegment {
  node: Text
  start: number
  end: number
}

/** 一个"块"= 一个块根元素下的全部可见文本，带送检用的 id + hash */
export interface TextBlock {
  id: string
  hash: string
  root: HTMLElement
  text: string
  segments: TextSegment[]
}

export type MarkKind = 'error' | 'idiom' | 'quote' | 'xiehouyu' | 'expression'

export interface IdiomPayload {
  idiom: string
  derivation?: string
  explanation?: string
}

export interface PhrasePayload {
  text: string
  answer?: string
  from?: string
}

export interface ExpressionPayload {
  text: string
  type: string
  score?: number
}

/** 块内偏移的标注（送检结果 + 本地匹配统一后的形态） */
export interface Mark {
  start: number
  end: number
  kind: MarkKind
  /** 服务端回传的原文切片，客户端据此校验偏移 */
  matchedText?: string
  error?: TextError
  idiom?: IdiomPayload
  phrase?: PhrasePayload
  expression?: ExpressionPayload
}

/** 已注册到标注层的标记，含可 hit-test 的文本节点定位 */
export interface RegisteredMark {
  blockId: string
  kind: MarkKind
  /** 标注原文 */
  text: string
  mark: Mark
  hits: Array<{ node: Text; start: number; end: number }>
  range: Range
  /** 所属的 Highlight 对象，removeBlock / clear 时需要 */
  highlight?: Highlight
}

/** 服务端 /api/check 的 blocks 响应 */
export interface RemoteMatch {
  kind: MarkKind
  start: number
  end: number
  matchedText: string
  error?: TextError
  idiom?: IdiomPayload & Record<string, unknown>
  phrase?: PhrasePayload & Record<string, unknown>
  expression?: ExpressionPayload
}

export interface RemoteBlock {
  id: string
  hash?: string
  matches: RemoteMatch[]
}

export interface RemoteCheckResponse {
  blocks?: RemoteBlock[]
  quota?: { remaining: number; isPaid: boolean; used: number; limit: number }
}
