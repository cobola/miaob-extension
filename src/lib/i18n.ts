/**
 * 双语文案工具：读取 _locales/<browser-language>/messages.json，
 * 随浏览器语言自动切换（中文用户显示中文，其他语言显示英文）。
 *
 * 用法：
 *   t('panel_welcome', userName)   // 支持 $1 $2 占位符
 *
 * 注意：Chrome 的 message key 只允许 [A-Za-z0-9_@]，禁止使用点号。
 */
export function t(key: string, ...subs: Array<string | number>): string {
  try {
    const message = chrome.i18n.getMessage(key, subs.map(String))
    return message || key
  } catch {
    // 极端情况下 chrome.i18n 不可用（如异常注入上下文）时返回 key，不抛错
    return key
  }
}
