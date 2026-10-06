/**
 * 繁简字形转换（识别与展示共用）。
 *
 * 词典数据只有简体一套：
 *  - 识别：把网页文字「繁 -> 简」归一化后再查词典；转换保证 UTF-16 长度不变，
 *    因此匹配到的下标可原样落回繁体原文。
 *  - 展示：把词典给出的解释 / 出处 / 答案「简 -> 繁」再渲染。
 *
 * 转换表由 OpenCC 词典生成（见 miaob-dictionary/scripts/gen-script-conversion.py），
 * 运行时用「前向 + 后向最大匹配，取分词更少者」近似 OpenCC 的 mmseg。
 */
import conversion from '../data-script-conversion.json'

interface Table {
  chars: Record<string, string>
  phrases: Record<string, string>
  maxPhraseLen: number
}
interface ConversionData {
  t2s: Table
  s2t: Table
  tw: Table
}

const data = conversion as unknown as ConversionData

/** 前向 / 后向最大匹配分词 */
function segment(text: string, table: Table, forward: boolean): string[] {
  const n = text.length
  const maxLen = table.maxPhraseLen || 1
  const tokens: string[] = []
  if (forward) {
    let i = 0
    while (i < n) {
      let len = 1
      for (let l = Math.min(maxLen, n - i); l >= 2; l--) {
        if (table.phrases[text.substr(i, l)] !== undefined) { len = l; break }
      }
      tokens.push(text.substr(i, len))
      i += len
    }
  } else {
    let i = n
    while (i > 0) {
      let len = 1
      for (let l = Math.min(maxLen, i); l >= 2; l--) {
        if (table.phrases[text.substr(i - l, l)] !== undefined) { len = l; break }
      }
      tokens.push(text.substr(i - len, len))
      i -= len
    }
    tokens.reverse()
  }
  return tokens
}

/** 两个字符串的 UTF-16 长度与码点数都相同（保证偏移可 1:1 复用） */
function sameShape(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  if (a.length === b.length && !/[\uD800-\uDFFF]/.test(a)) return true
  return Array.from(a).length === Array.from(b).length
}

function convertChars(token: string, table: Table, preserveLength: boolean): string {
  let out = ''
  for (const ch of token) {
    const mapped = table.chars[ch]
    if (mapped === undefined || (preserveLength && !sameShape(mapped, ch))) out += ch
    else out += mapped
  }
  return out
}

/**
 * @param preserveLength 为 true 时，放弃任何会改变 UTF-16 长度的映射，
 *   保证输出与输入等长（用于识别，确保下标可直接复用）。
 */
function applyTable(text: string, table: Table, preserveLength: boolean): string {
  if (!text) return text
  const forward = segment(text, table, true)
  const backward = segment(text, table, false)
  const tokens = forward.length <= backward.length ? forward : backward
  let out = ''
  for (const token of tokens) {
    if (token.length > 1 && table.phrases[token] !== undefined) {
      const mapped = table.phrases[token]
      out += preserveLength && !sameShape(mapped, token) ? convertChars(token, table, true) : mapped
    } else {
      out += convertChars(token, table, preserveLength)
    }
  }
  return out
}

/** 繁体 -> 简体（等长，用于匹配前归一化） */
export function toSimplified(text: string): string {
  return applyTable(text, data.t2s, true)
}

/** 简体 -> 繁体（可选套用台湾用词） */
export function toTraditional(text: string, tw = false): string {
  const traditional = applyTable(text, data.s2t, false)
  return tw ? applyTable(traditional, data.tw, false) : traditional
}

/** 浏览器界面语言是否为繁体（台/港/澳 或 Hant） */
export function isTraditionalLocale(): boolean {
  try {
    const lang = (chrome.i18n.getUILanguage?.() || navigator.language || '').toLowerCase()
    return /-(tw|hk|mo)(\b|-)/.test(lang) || /hant/.test(lang)
  } catch {
    return false
  }
}

/** 按用户字形本地化展示文本：繁体用户转繁（台繁），简体用户原样返回 */
export function localizeScript(text: string, tw = isTraditionalLocale()): string {
  if (!text) return text
  return tw ? toTraditional(text, true) : text
}
