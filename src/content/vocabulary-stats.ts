import vocabulary from '../data-vocabulary.json'

export interface VocabularyStats {
  totalChineseChars: number
  uniqueChineseChars: number
  uniqueWords: number
  easyChars: number
  difficultChars: number
  easyPercent: number
  readability: string
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
  const chars = Array.from(text).filter(char => chineseCharPattern.test(char))
  const uniqueChars = new Set(chars)
  const words = findWords(text)
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
    readability: easyPercent >= 90 ? '基础阅读较顺畅' : easyPercent >= 80 ? '一般读者基本可顺畅阅读' : easyPercent >= 65 ? '需要一定词汇基础' : '生字较多，建议边读边查',
  }
}
