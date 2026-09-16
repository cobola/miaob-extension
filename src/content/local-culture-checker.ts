import cultureData from '../data-culture.json'
import idiomDetails from '../data-idiom-details.json'

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
  const chars = Array.from(text)
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
        results.push({ ...match, start, end: start + length })
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
