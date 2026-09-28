import { collectTextNodes, RenderCache } from './traverse'
import type { TextBlock, TextSegment } from './types'

const BLOCK_TAGS = new Set([
  'p', 'li', 'td', 'th', 'blockquote', 'article', 'section', 'main',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'a', 'strong', 'em', 'b', 'i',
])
/** 文本变更时需要清除"已检查"标记的块标签（比 BLOCK_TAGS 少了内联强调，这里补上） */
const RESET_TAGS = new Set([
  'p', 'li', 'td', 'th', 'blockquote', 'article', 'section', 'main',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'a', 'strong', 'em', 'b', 'i',
])
const STRUCTURE_TAGS = new Set(['nav', 'footer', 'header', 'aside'])
const CONTROL_TAGS = new Set(['button', 'form', 'input', 'select', 'textarea', 'label', 'option'])

/** FNV-1a 32bit，块内容指纹，用于校验服务端回传的块没有串位 */
export function hashText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * 找到文本节点所属的"块根"。
 *
 * 与旧实现的差异：
 *  - tagName 直接用 Set 比较，不再每次 `matches()` 拼选择器
 *  - 只有当文本节点自身不足 4 字时才去算祖先的 textContent（textContent 是 O(子树)，
 *    这是旧实现在大页面上的主要热点）
 *  - 用 ownerDocument.body 作为上界，iframe 内也能正确停在自己的 body
 */
export function getBlockRoot(
  textNode: Text,
  textLenCache?: WeakMap<HTMLElement, boolean>,
): HTMLElement | null {
  const ownLen = textNode.data.trim().length
  let current = textNode.parentElement
  let candidate: HTMLElement | null = null

  while (current) {
    const doc = current.ownerDocument
    if (current === doc?.body) break

    const tag = current.tagName.toLowerCase()
    if (STRUCTURE_TAGS.has(tag) || CONTROL_TAGS.has(tag)) return null

    if (BLOCK_TAGS.has(tag)) {
      if (tag === 'div' || tag === 'span') {
        // 候选块：继续向上看是否落在控件里（如 button 内的 span）
        if (!candidate) {
          let ok = ownLen >= 4
          if (!ok) {
            let cached = textLenCache?.get(current)
            if (cached === undefined) {
              cached = (current.textContent || '').trim().length >= 4
              textLenCache?.set(current, cached)
            }
            ok = cached
          }
          if (ok) candidate = current
        }
      } else {
        return current
      }
    }

    const parent = current.parentElement
    if (!parent) {
      // 走到 shadow root 顶部：shadow 内容不与宿主的 light DOM 混块
      const rootNode = current.getRootNode()
      if (rootNode instanceof ShadowRoot) break
      break
    }
    current = parent
  }

  if (candidate) return candidate
  return textNode.parentElement
}

export interface CollectOptions {
  /** 已检查过的块根，命中的节点直接跳过 */
  checked?: WeakSet<HTMLElement>
  /** 一轮遍历内复用的渲染状态缓存 */
  render?: RenderCache
  /** 默认过滤不可见块；显式传 false 可关闭 */
  includeHidden?: boolean
}

/**
 * 块根 → 稳定块 id。
 * 每轮只重新送检"未检查"的块，序号若每轮重置，id 会在两轮之间指向不同块，
 * 导致高光/命中测试张冠李戴，所以 id 必须挂在元素身份上。
 */
const ROOT_IDS = new WeakMap<HTMLElement, string>()
let rootSeq = 0

function blockIdFor(root: HTMLElement): string {
  let id = ROOT_IDS.get(root)
  if (!id) {
    id = 'b' + rootSeq++
    ROOT_IDS.set(root, id)
  }
  return id
}

/**
 * 收集 root 子树内的文本块。块 = 一个块根元素下的全部文本节点，
 * 偏移为块内 UTF-16 连续偏移，segments 记录每段对应的节点。
 */
export function collectBlocks(root: Node, opts: CollectOptions = {}): TextBlock[] {
  const textNodes = collectTextNodes(root)
  if (textNodes.length === 0) return []

  const textLenCache = new WeakMap<HTMLElement, boolean>()
  const groups = new Map<HTMLElement, TextBlock>()

  for (const node of textNodes) {
    const blockRoot = getBlockRoot(node, textLenCache)
    if (!blockRoot) continue
    if (opts.checked && opts.checked.has(blockRoot)) continue

    const text = node.data
    if (!text) continue

    let block = groups.get(blockRoot)
    if (!block) {
      block = { id: '', hash: '', root: blockRoot, text: '', segments: [] }
      groups.set(blockRoot, block)
    }
    const start = block.text.length
    block.text += text
    const segment: TextSegment = { node, start, end: start + text.length }
    block.segments.push(segment)
  }

  const render = opts.render ?? new RenderCache()
  const blocks: TextBlock[] = []
  for (const block of groups.values()) {
    if (!block.text.trim()) continue
    if (!isLikelyMainText(block.text)) continue
    if (!opts.includeHidden && !render.check(block.root)) continue
    block.id = blockIdFor(block.root)
    block.hash = hashText(block.text)
    blocks.push(block)
  }
  return blocks
}

/**
 * 启发式判断一段文本是否像"正文"，而非导航/面包屑/页脚/边栏。
 * 不猜 DOM 结构（不同网站结构各异），只用内容信号。
 */
export function isLikelyMainText(text: string): boolean {
  const t = text.trim()
  if (t.length < 4) return false

  if (/版权所有|Copyright|ICP备|保留所有权利|建议使用.*浏览器|技术支持|友情链接/.test(t)) {
    return false
  }

  const noSentence = !/[。！？；]/.test(t)
  if (noSentence) {
    const navLike = /^[^\s，。！？；：""''（）()·\-—|]+([\s·｜|>›»/、]+[^\s，。！？；：""''（）()·\-—|]+)+$/.test(t)
    if (navLike) return false
  }

  if (/[。！？]/.test(t) && t.length >= 20) return true
  if (t.length >= 60) return true
  return /[，。]/.test(t) && t.length >= 10
}

/** 节点或其祖先变更后，清掉链路上块根的"已检查"标记 */
export function resetBlockState(node: Node, checked: WeakSet<HTMLElement>): void {
  const direct = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
  if (direct) checked.delete(direct)

  let current = direct
  while (current) {
    if (RESET_TAGS.has(current.tagName.toLowerCase())) checked.delete(current)
    if (current === current.ownerDocument?.body) break
    current = current.parentElement
  }
}
