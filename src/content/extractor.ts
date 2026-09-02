// 文本提取器
export class TextExtractor {
  extractText(element: HTMLElement): string {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value
    }

    if (element.isContentEditable) {
      return element.textContent || ''
    }

    return ''
  }

  // 提取页面所有可编辑文本
  extractAllEditableText(): Array<{ element: HTMLElement; text: string }> {
    const selector = 'input[type="text"], textarea, [contenteditable="true"]'
    const elements = document.querySelectorAll(selector)

    return Array.from(elements).map((el) => ({
      element: el as HTMLElement,
      text: this.extractText(el as HTMLElement),
    }))
  }
}
