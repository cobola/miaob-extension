import type { TextError } from './shared/types'

// 错误标注器
export class ErrorMarker {
  private markers: Map<HTMLElement, HTMLElement[]>

  constructor() {
    this.markers = new Map()
  }

  // 标注输入区域错误
  markErrors(element: HTMLElement, errors: TextError[]) {
    const wrapper = this.getOrCreateWrapper(element)
    const marker = document.createElement('div')
    marker.className = 'miaob-error-panel'

    const summary = document.createElement('div')
    summary.className = 'miaob-error-summary'
    summary.textContent = `发现 ${errors.length} 处问题`
    marker.appendChild(summary)

    const list = document.createElement('div')
    list.className = 'miaob-error-list'

    errors.slice(0, 5).forEach((error) => {
      const item = document.createElement('div')
      item.className = `miaob-error-item miaob-error-item-${error.type}`

      const suggestion = error.suggestion ? ` -> ${error.suggestion}` : ''
      item.textContent = `${error.original}: ${error.message}${suggestion}`
      item.addEventListener('mouseenter', () => this.showTooltip(item, error))
      item.addEventListener('mouseleave', () => this.hideTooltip())
      list.appendChild(item)
    })

    if (errors.length > 5) {
      const more = document.createElement('div')
      more.className = 'miaob-error-more'
      more.textContent = `还有 ${errors.length - 5} 处问题未展开`
      list.appendChild(more)
    }

    marker.appendChild(list)
    wrapper.appendChild(marker)

    element.classList.add('miaob-has-errors')

    this.markers.set(element, [marker])
  }

  showServiceError(element: HTMLElement, message: string) {
    this.clearMarkers(element)

    const wrapper = this.getOrCreateWrapper(element)
    const marker = document.createElement('div')
    marker.className = 'miaob-service-error'
    marker.textContent = `妙笔未连接到检查服务: ${message}`
    wrapper.appendChild(marker)

    element.classList.add('miaob-service-unavailable')
    this.markers.set(element, [marker])
  }

  // 获取或创建包装容器
  getOrCreateWrapper(element: HTMLElement): HTMLElement {
    let wrapper = element.parentElement?.classList.contains('miaob-wrapper')
      ? element.parentElement
      : null

    if (!wrapper) {
      wrapper = document.createElement('div')
      wrapper.className = 'miaob-wrapper'
      element.parentElement?.insertBefore(wrapper, element)
      wrapper.appendChild(element)
    }

    return wrapper
  }

  // 添加悬浮提示
  attachTooltip(marker: HTMLElement, error: TextError) {
    marker.addEventListener('mouseenter', () => {
      this.showTooltip(marker, error)
    })

    marker.addEventListener('mouseleave', () => {
      this.hideTooltip()
    })
  }

  // 显示提示
  showTooltip(marker: HTMLElement, error: TextError) {
    // 移除旧提示
    this.hideTooltip()

    const tooltip = document.createElement('div')
    tooltip.className = 'miaob-tooltip'
    tooltip.innerHTML = `
      <div class="miaob-tooltip-message">${error.message}</div>
      ${error.suggestion ? `
        <div class="miaob-tooltip-suggestion">
          建议：${error.suggestion}
        </div>
        <button class="miaob-tooltip-fix">修复</button>
      ` : ''}
    `

    // 定位
    const rect = marker.getBoundingClientRect()
    tooltip.style.position = 'fixed'
    tooltip.style.left = `${rect.left}px`
    tooltip.style.top = `${rect.bottom + 5}px`

    document.body.appendChild(tooltip)

    // 修复按钮
    const fixBtn = tooltip.querySelector('.miaob-tooltip-fix')
    if (fixBtn) {
      fixBtn.addEventListener('click', () => {
        this.applyFix(marker, error)
        this.hideTooltip()
      })
    }
  }

  // 隐藏提示
  hideTooltip() {
    const tooltip = document.querySelector('.miaob-tooltip')
    if (tooltip) {
      tooltip.remove()
    }
  }

  // 应用修复
  applyFix(_marker: HTMLElement, error: TextError) {
    // TODO: 实现文本替换逻辑
    console.log('应用修复:', error)
  }

  // 清除所有标注
  clearAll() {
    for (const [element] of this.markers) {
      this.clearMarkers(element)
    }
  }

  // 清除标注
  clearMarkers(element: HTMLElement) {
    const markers = this.markers.get(element)
    if (markers) {
      markers.forEach((marker) => marker.remove())
      this.markers.delete(element)
    }

    element.classList.remove('miaob-has-errors', 'miaob-service-unavailable')
  }
}
