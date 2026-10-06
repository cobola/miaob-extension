import vocabulary from '../data-vocabulary.json'
import { toSimplified } from '../lib/script-conversion'

export type ReadabilityLevel = 'smooth' | 'comfortable' | 'someVocab' | 'manyNew'

export interface VocabularyStats {
  totalChineseChars: number
  uniqueChineseChars: number
  uniqueWords: number
  easyChars: number
  difficultChars: number
  easyPercent: number
  readabilityLevel: ReadabilityLevel
}

const chineseCharPattern = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const groups: Array<{ key: string; label: string; words: string[] }> = [
  { key: 'hsk-1-2', label: 'HSK 1–2', words: vocabulary.hsk['1-2'] },
  { key: 'hsk-3-4', label: 'HSK 3–4', words: vocabulary.hsk['3-4'] },
  { key: 'hsk-5-6', label: 'HSK 5–6', words: vocabulary.hsk['5-6'] },
  { key: 'primary', label: '小学常用', words: vocabulary.school['小学'] },
  { key: 'middle', label: '初中常用', words: vocabulary.school['初中'] },
]

const allWords = [...new Set(groups.flatMap(group => group.words))]
const maxWordLength = Math.max(...allWords.map(word => Array.from(word).length))
const easyWords = [
  ...vocabulary.hsk['1-2'],
  ...vocabulary.hsk['3-4'],
  ...vocabulary.school['小学'],
  ...vocabulary.school['初中'],
]
const easyChars = new Set(easyWords.flatMap(word => Array.from(word)))

function findWords(text: string): string[] {
  const chars = Array.from(text)
  const found: string[] = []
  const occupied = new Set<number>()
  const wordSet = new Set(allWords)
  for (let start = 0; start < chars.length; start++) {
    for (let length = Math.min(maxWordLength, chars.length - start); length >= 2; length--) {
      const word = chars.slice(start, start + length).join('')
      if (!wordSet.has(word)) continue
      if ([...Array(length)].some((_, offset) => occupied.has(start + offset))) break
      for (let offset = 0; offset < length; offset++) occupied.add(start + offset)
      found.push(word)
      break
    }
  }
  return found
}

export function calculateVocabularyStats(text: string): VocabularyStats {
  // 词汇表是简体，繁体页先等长归一化再统计
  const normalized = toSimplified(text)
  const chars = Array.from(normalized).filter(char => chineseCharPattern.test(char))
  const uniqueChars = new Set(chars)
  const words = findWords(normalized)
  const uniqueWords = [...new Set(words)]
  const easyCount = [...uniqueChars].filter(char => easyChars.has(char)).length
  const easyPercent = uniqueChars.size ? Math.round(easyCount / uniqueChars.size * 100) : 0
  return {
    totalChineseChars: chars.length,
    uniqueChineseChars: uniqueChars.size,
    uniqueWords: uniqueWords.length,
    easyChars: easyCount,
    difficultChars: uniqueChars.size - easyCount,
    easyPercent,
    readabilityLevel: easyPercent >= 90 ? 'smooth' : easyPercent >= 80 ? 'comfortable' : easyPercent >= 65 ? 'someVocab' : 'manyNew',
  }
}
