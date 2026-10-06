import cultureData from '../data-culture.json'
import idiomDetails from '../data-idiom-details.json'
import { toSimplified } from '../lib/script-conversion'

export interface LocalIdiomMatch {
  idiom: string
  start: number
  end: number
  derivation: string
  explanation: string
  example: string
  pinyin: string
}

export interface LocalPhraseMatch {
  text: string
  start: number
  end: number
  type: 'quote' | 'xiehouyu'
  answer?: string
  from?: string
}

const idioms = new Set(cultureData.idioms)
const idiomDetailMap = idiomDetails as Record<string, { pinyin?: string; explanation?: string }>
const quotes = new Map(cultureData.quotes as Array<[string, string]>)
const xiehouyu = new Map(cultureData.xiehouyu as Array<[string, string]>)
const maxIdiomLength = Math.max(...cultureData.idioms.map(word => Array.from(word).length))
const maxPhraseLength = Math.max(...cultureData.quotes.map(([text]) => Array.from(text).length), ...cultureData.xiehouyu.map(([text]) => Array.from(text).length))

function findMatches(text: string, maxLength: number, matcher: (candidate: string) => LocalIdiomMatch | LocalPhraseMatch | null) {
  // 词典只有简体：把原文「繁 -> 简」等长归一化后再匹配，命中的下标可原样落回原文。
  const normalized = toSimplified(text)
  const chars = Array.from(normalized)
  // 码点下标 → UTF-16 下标。调用方拿 start/end 去 slice 块文本，
  // 混用两套下标会让含 emoji / 生僻字（代理对）的文本标注错位。
  const utf16: number[] = new Array(chars.length + 1)
  utf16[0] = 0
  for (let i = 0; i < chars.length; i++) utf16[i + 1] = utf16[i] + chars[i].length

  const found = new Set<number>()
  const results: Array<LocalIdiomMatch | LocalPhraseMatch> = []

  for (let start = 0; start < chars.length; start++) {
    for (let length = Math.min(maxLength, chars.length - start); length >= 3; length--) {
      const candidate = chars.slice(start, start + length).join('')
      const match = matcher(candidate)
      if (!match) continue
      let overlaps = false
      for (let offset = 0; offset < length; offset++) {
        if (found.has(start + offset)) overlaps = true
      }
      if (!overlaps) {
        for (let offset = 0; offset < length; offset++) found.add(start + offset)
        const startU16 = utf16[start]
        const endU16 = utf16[start + length]
        // 展示用原文切片（繁体页显示繁体），词典详情保持简体，由渲染层按字形转换
        const original = text.slice(startU16, endU16)
        const enriched = 'idiom' in match ? { ...match, idiom: original } : { ...match, text: original }
        results.push({ ...enriched, start: startU16, end: endU16 })
      }
      break
    }
  }

  return results
}

export function findLocalIdioms(text: string): LocalIdiomMatch[] {
  return findMatches(text, maxIdiomLength, candidate => {
    if (!idioms.has(candidate)) return null
    return {
      idiom: candidate,
      start: 0,
      end: 0,
      derivation: '',
      explanation: idiomDetailMap[candidate]?.explanation || '',
      example: '',
      pinyin: idiomDetailMap[candidate]?.pinyin || '',
    }
  }) as LocalIdiomMatch[]
}

export function findLocalPhrases(text: string): LocalPhraseMatch[] {
  return findMatches(text, maxPhraseLength, candidate => {
    const quote = quotes.get(candidate)
    if (quote !== undefined) return { text: candidate, start: 0, end: 0, type: 'quote', from: quote }
    const quoteWithoutPunctuation = candidate.replace(/[。，！？；：、]$/, '')
    if (quoteWithoutPunctuation !== candidate && quotes.has(quoteWithoutPunctuation)) {
      return { text: candidate, start: 0, end: 0, type: 'quote', from: quotes.get(quoteWithoutPunctuation) }
    }
    if (xiehouyu.has(candidate)) {
      return { text: candidate, start: 0, end: 0, type: 'xiehouyu', answer: xiehouyu.get(candidate) }
    }
    return null
  }) as LocalPhraseMatch[]
}

export function findLocalCulture(text: string): { idioms: LocalIdiomMatch[]; phrases: LocalPhraseMatch[] } {
  return { idioms: findLocalIdioms(text), phrases: findLocalPhrases(text) }
}
