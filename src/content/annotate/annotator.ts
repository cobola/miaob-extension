import type { Mark, MarkKind, RegisteredMark, TextBlock } from '../dom/types'

/**
 * 标注层。
 *
 * 主路径用 CSS Custom Highlight API：只往 CSS.highlights 里塞 Range，
 * **完全不改页面 DOM 结构**——不拆文本节点、不插 span，因此：
 *  - React/Vue 的 reconciler 不会拿到被替换掉的节点引用
 *  - clear 之后页面结构 100% 还原（本来就没动过）
 *  - 一个标注可以横跨多个文本节点而不会被切碎
 *
 * 代价是没有真实元素可挂事件，所以悬浮卡片 / tooltip 改为
 * mousemove + caretRangeFromPoint 做 hit-test（见 hitTest）。
 */

const HIGHLIGHT_NAME: Record<MarkKind, string> = {
  error: 'miaob-error',
  idiom: 'miaob-idiom',
  quote: 'miaob-quote',
  xiehouyu: 'miaob-xiehouyu',
  expression: 'miaob-expression',
}

/** 同位置多标注时的优先级（数字越小越优先） */
const PRIORITY: Record<MarkKind, number> = { error: 0, idiom: 1, quote: 2, xiehouyu: 3, expression: 4 }

export function isHighlightSupported(): boolean {
  try {
    return typeof CSS !== 'undefined' && !!(CSS as { highlights?: unknown }).highlights && typeof Highlight !== 'undefined'
  } catch {
    return false
  }
}

interface SegmentHit {
  node: Text
  start: number
  end: number
}

/**
 * 块偏移 → 命中的文本节点片段。
 * 先整体校验 segments 仍然有效：只要有一个节点被页面改写或摘掉，
 * 整块放弃（MutationObserver 会重新送检），避免画出错位的高光。
 */
function hitsFor(block: TextBlock, start: number, end: number): SegmentHit[] {
  for (const seg of block.segments) {
    if (!seg.node.isConnected) return []
    if (seg.node.data.length !== seg.end - seg.start) return []
  }

  const hits: SegmentHit[] = []
  for (const seg of block.segments) {
    if (seg.end <= start || seg.start >= end) continue
    const s = Math.max(0, start - seg.start)
    const e = Math.min(seg.end - seg.start, end - seg.start)
    if (e > s) hits.push({ node: seg.node, start: s, end: e })
  }
  return hits
}

function dedupe(marks: Mark[]): Mark[] {
  const byPos = new Map<string, Mark>()
  for (const m of marks) {
    if (m.end <= m.start) continue
    const key = `${m.start}-${m.end}`
    const existing = byPos.get(key)
    if (!existing || PRIORITY[m.kind] < PRIORITY[existing.kind]) byPos.set(key, m)
  }
  return Array.from(byPos.values()).sort((a, b) => a.start - b.start)
}

export class Annotator {
  readonly supported = isHighlightSupported()

  private byBlock = new Map<string, RegisteredMark[]>()
  private all: RegisteredMark[] = []
  /** (registry, kind) → Highlight；用 Set 累积以便 clear 时一次清空 */
  private highlights = new Set<Highlight>()

  /** 注册一个块的标注；返回实际生效的标记（可能因节点失效被丢弃） */
  apply(block: TextBlock, marks: Mark[]): RegisteredMark[] {
    this.removeBlock(block.id)
    if (!this.supported || marks.length === 0) return []

    const doc = block.segments[0]?.node.ownerDocument
    const registry = doc?.defaultView && (doc.defaultView as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights
    if (!doc || !registry) return []

    const created: RegisteredMark[] = []
    for (const mark of dedupe(marks)) {
      const hits = hitsFor(block, mark.start, mark.end)
      if (hits.length === 0) continue

      const range = doc.createRange()
      try {
        range.setStart(hits[0].node, hits[0].start)
        const last = hits[hits.length - 1]
        range.setEnd(last.node, last.end)
      } catch {
        continue
      }

      const name = HIGHLIGHT_NAME[mark.kind]
      let hl = registry.get(name) as Highlight | undefined
      if (!hl) {
        hl = new Highlight()
        registry.set(name, hl)
      }
      hl.add(range)
      this.highlights.add(hl)

      created.push({
        blockId: block.id,
        kind: mark.kind,
        text: block.text.slice(mark.start, mark.end),
        mark,
        hits,
        range,
        highlight: hl,
      })
    }

    if (created.length > 0) this.byBlock.set(block.id, created)
    this.all.push(...created)
    return created
  }

  removeBlock(blockId: string): void {
    const recs = this.byBlock.get(blockId)
    if (!recs) return
    for (const rec of recs) rec.highlight?.delete(rec.range)
    this.byBlock.delete(blockId)
    if (this.all.length > 0) this.all = this.all.filter((r) => r.blockId !== blockId)
  }

  clear(): void {
    for (const hl of this.highlights) hl.clear()
    this.highlights.clear()
    this.byBlock.clear()
    this.all = []
  }

  getMarks(): readonly RegisteredMark[] {
    return this.all
  }

  find(kind: MarkKind, text: string): RegisteredMark | null {
    return this.all.find((r) => r.kind === kind && (r.text === text || r.text.includes(text))) ?? null
  }

  /** 滚动到标注位置并闪烁提示；成功返回 true */
  scrollTo(kind: MarkKind, text: string): boolean {
    const rec = this.find(kind, text)
    if (!rec) return false

    const doc = rec.range.startContainer.ownerDocument
    const view = doc?.defaultView
    if (!view) return false

    if (doc !== view.top?.document) {
      // iframe 内部：先把 iframe 自身滚进视野
      for (const frame of Array.from(view.top?.document.querySelectorAll('iframe') ?? [])) {
        if (frame.contentDocument === doc) {
          frame.scrollIntoView({ behavior: 'smooth', block: 'center' })
          break
        }
      }
    }

    const rect = rec.range.getBoundingClientRect()
    if (rect.width > 0 || rect.height > 0) {
      view.scrollTo({
        top: rect.top + view.scrollY - view.innerHeight / 2,
        left: rect.left + view.scrollX - view.innerWidth / 2,
        behavior: 'smooth',
      })
    } else {
      rec.hits[0]?.node.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }

    this.flash(rec)
    return true
  }

  /** 临时给标注加一层黄色高亮，durationMs 后恢复 */
  flash(rec: RegisteredMark, durationMs = 2000): void {
    const doc = rec.range.startContainer.ownerDocument
    const view = doc?.defaultView
    const registry = view && (view as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights
    if (!view || !registry) return

    let flash = registry.get('miaob-flash') as Highlight | undefined
    if (!flash) {
      flash = new Highlight()
      registry.set('miaob-flash', flash)
    }
    flash.add(rec.range)
    this.highlights.add(flash)
    view.setTimeout(() => flash!.delete(rec.range), durationMs)
  }

  /**
   * 命中测试：把视口坐标翻译回标注。
   * caretRangeFromPoint 返回"插入符会落在哪"，对 LTR 文本即字符左边界，
   * 因此用 start <= offset < end 判定，边界不会串到相邻标注上。
   */
  hitTest(x: number, y: number, doc: Document = document): RegisteredMark | null {
    if (this.all.length === 0) return null

    let caret: Range | null = null
    try {
      caret = doc.caretRangeFromPoint(x, y)
    } catch {
      return null
    }
    if (!caret) return null

    let node: Node = caret.startContainer
    let offset = caret.startOffset
    if (node.nodeType !== Node.TEXT_NODE) {
      if (node.nodeType !== Node.ELEMENT_NODE) return null
      const children = node.childNodes
      const child = children[offset] ?? children[offset - 1]
      if (!child || child.nodeType !== Node.TEXT_NODE) return null
      node = child
      offset = child === children[offset] ? 0 : ((child as Text).data?.length ?? 0)
    }

    for (const rec of this.all) {
      for (const hit of rec.hits) {
        if (hit.node === node && offset >= hit.start && offset < hit.end) return rec
      }
    }
    return null
  }
}
