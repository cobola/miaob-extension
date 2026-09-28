/**
 * DOM 文本节点收集。
 *
 * 相比旧的递归实现：
 *  - 用显式栈做 DFS，不再依赖调用栈深度，也不会 `push(...array)` 摊开大数组
 *  - 支持同源 iframe 与 open shadow root（旧实现直接跳过）
 *  - 元素级跳过自己的 UI（id/class 以 miaob- 开头），避免把插件内容当正文
 *  - 表单控件 / contenteditable 仍在文本节点层用 closest 排除
 */

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'OBJECT', 'TEMPLATE', 'SVG', 'MATH'])

const SKIP_SELECTOR =
  '.miaob-inline-wrapper, .miaob-wrapper, .miaob-tooltip, #miaob-panel-root, input, textarea, [contenteditable="true"]'

/** 自家 UI：id/class 前缀统一是 miaob-，字符串判断比 closest 便宜一个数量级 */
function isPluginElement(el: Element): boolean {
  const id = el.id
  if (id && id.indexOf('miaob-') === 0) return true
  const cls = el.getAttribute('class')
  return cls !== null && cls.indexOf('miaob-') !== -1
}

/** 同源 iframe 的正文；跨域时 contentDocument 为 null 或抛错，交由调用方 catch */
function iframeBody(el: HTMLIFrameElement): HTMLElement | null {
  try {
    const doc = el.contentDocument
    return doc?.body ?? null
  } catch {
    return null
  }
}

export function collectTextNodes(root: Node): Text[] {
  const out: Text[] = []
  const stack: Node[] = [root]

  while (stack.length > 0) {
    const node = stack.pop() as Node

    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text
      if (!text.data || !text.data.trim()) continue
      const parent = text.parentElement
      if (parent && parent.closest(SKIP_SELECTOR)) continue
      out.push(text)
      continue
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element
      const tag = el.tagName

      if (tag === 'IFRAME') {
        const body = iframeBody(el as HTMLIFrameElement)
        if (body) stack.push(body)
        continue
      }
      if (SKIP_TAGS.has(tag) || isPluginElement(el)) continue
    } else if (
      node.nodeType !== Node.DOCUMENT_NODE &&
      node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
    ) {
      continue
    }

    // 先压 shadowRoot 再压子节点 → 子节点先弹出，保持文档序
    if (node.nodeType === Node.ELEMENT_NODE) {
      const shadow = (node as Element).shadowRoot
      if (shadow) stack.push(shadow)
    }

    const children = node.childNodes
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i])
    }
  }

  return out
}

/**
 * 是否参与渲染。
 * getClientRects 覆盖 display:none / 祖先隐藏；visibility 继承但不产生空 rect，
 * 所以要额外读一次 computed style。
 */
export function isRendered(el: Element): boolean {
  if (el.getClientRects().length === 0) return false
  const view = el.ownerDocument?.defaultView
  if (!view) return true
  const cs = view.getComputedStyle(el)
  return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse'
}

/** 一次遍历内的渲染状态缓存（按块根判一次即可，不要每个文本节点都算） */
export class RenderCache {
  private cache = new WeakMap<Element, boolean>()

  check(el: Element): boolean {
    let hit = this.cache.get(el)
    if (hit === undefined) {
      hit = isRendered(el)
      this.cache.set(el, hit)
    }
    return hit
  }
}
