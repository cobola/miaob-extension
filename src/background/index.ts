import { Strictness, type UserConfig } from './shared/types'

// Background Service Worker - activeTab 模式
console.log('妙笔 Background Service Worker 已启动')

// 注册右键菜单
const CHECK_SELECTION_ID = 'miaob-check-selection'
const OPTIONS_ID = 'miaob-options'
chrome.runtime.onInstalled.addListener(() => {
  // 页面右键菜单：检查选中文字
  chrome.contextMenus.create({
    id: CHECK_SELECTION_ID,
    title: '妙笔检查这段文字',
    contexts: ['selection'],
  })
  // 扩展图标右键菜单：打开设置
  chrome.contextMenus.create({
    id: OPTIONS_ID,
    title: '设置',
    contexts: ['action'],
  })
})

// 点击扩展图标：直接检查当前页（无 popup）
chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return
  // content.js 是 IIFE 格式，用 files 注入
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js'],
  }).catch((err) => {
    console.error('注入 content script 失败:', err)
  })
  // 同时注入 content.css（esbuild 提取的样式文件）
  chrome.scripting.insertCSS({
    target: { tabId: tab.id },
    files: ['content.css'],
  }).catch(() => {})
})

// 右键菜单点击
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === OPTIONS_ID) {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/index.html') })
    return
  }

  if (info.menuItemId !== CHECK_SELECTION_ID || !tab?.id) return
  const text = (info.selectionText || '').trim()
  if (!text) return

  handleTextCheck({ text })
    .then((result) => {
      const data = {
        text,
        errors: result?.errors || [],
        idioms: result?.idioms || [],
        phrases: result?.phrases || [],
      }
      chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        func: showSelectionCard,
        args: [data],
      }).catch(() => {})
    })
    .catch((error) => {
      chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        func: showSelectionCard,
        args: [{ text, errors: [], idioms: [], phrases: [], error: error.message }],
      }).catch(() => {})
    })
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log('收到消息:', message)

  if (message.type === 'CHECK_TEXT') {
    handleTextCheck(message.data)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }

  if (message.type === 'GET_CONFIG') {
    chrome.storage.sync.get(['config'], (result) => {
      const config = (result.config as UserConfig | undefined) ?? getDefaultConfig()
      if (config.apiUrl?.includes('localhost')) {
        config.apiUrl = 'https://api.miaob.net'
      }
      sendResponse({ success: true, data: config })
    })
    return true
  }

  if (message.type === 'CHECK_PAGE') {
    checkCurrentPage()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }
})

/**
 * 在页面中创建浮动结果卡片（注入执行的函数）
 */
function showSelectionCard(data: {
  text: string
  errors: Array<{ type: string; original: string; suggestion?: string; message?: string }>
  idioms: Array<{ idiom: string; derivation?: string; explanation?: string }>
  phrases: Array<{ text: string; type: string; answer?: string; from?: string }>
  error?: string
}) {
  document.querySelectorAll('#miaob-selection-card').forEach(el => el.remove())

  const card = document.createElement('div')
  card.id = 'miaob-selection-card'
  card.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;max-width:380px;max-height:70vh;overflow:auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 10px 25px rgba(0,0,0,.15);padding:16px;font-size:14px;line-height:1.6;font-family:-apple-system,sans-serif;'

  const title = document.createElement('div')
  title.textContent = '妙笔检查'
  title.style.cssText = 'font-weight:600;margin-bottom:8px;color:#111'
  card.appendChild(title)

  const close = document.createElement('button')
  close.textContent = '×'
  close.style.cssText = 'position:absolute;top:6px;right:10px;border:none;background:none;font-size:18px;cursor:pointer;color:#666'
  close.onclick = () => card.remove()
  card.appendChild(close)

  const esc = (s: string) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

  if (data.error) {
    const err = document.createElement('div')
    err.textContent = '检查失败：' + data.error
    err.style.cssText = 'color:#dc2626'
    card.appendChild(err)
  } else {
    const idioms = data.idioms || []
    const phrases = data.phrases || []
    const errors = data.errors || []
    const total = idioms.length + phrases.length + errors.length

    if (total === 0) {
      const ok = document.createElement('div')
      ok.textContent = '未发现错误，也无成语/名句标注'
      ok.style.cssText = 'color:#16a34a'
      card.appendChild(ok)
    } else {
      const count = document.createElement('div')
      count.textContent = `发现 ${idioms.length} 个成语 · ${phrases.length} 个名句/歇后语 · ${errors.length} 处错误`
      count.style.cssText = 'color:#4b5563;margin-bottom:10px;font-size:13px'
      card.appendChild(count)

      const addItem = (tag: string, tagColor: string, content: string) => {
        const item = document.createElement('div')
        item.style.cssText = 'padding:8px 10px;margin-bottom:6px;border-left:3px solid ' + tagColor + ';background:#f9fafb;border-radius:4px;font-size:13px'
        item.innerHTML = `<span style="font-weight:600;color:${tagColor}">${tag}</span> ${content}`
        card.appendChild(item)
      }

      idioms.forEach(i => {
        addItem('成语', '#8b5cf6', `${esc(i.idiom)}${i.derivation ? ' — ' + esc(i.derivation.slice(0, 40)) : ''}`)
      })
      phrases.forEach(p => {
        const tag = p.type === 'quote' ? '名句' : '歇后语'
        const color = p.type === 'quote' ? '#10b981' : '#f59e0b'
        const extra = p.type === 'quote' ? (p.from || '') : (p.answer || '')
        addItem(tag, color, `${esc(p.text)}${extra ? ' — ' + esc(extra) : ''}`)
      })
      errors.forEach(e => {
        addItem('错误', '#ef4444', `${esc(e.original)}${e.suggestion ? ' → ' + esc(e.suggestion) : ''}`)
      })
    }
  }

  document.body.appendChild(card)
}

async function handleTextCheck(data: { text: string }) {
  const config = await getConfig()
  const apiUrl = config.apiUrl || 'https://api.miaob.net'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120000)

  try {
    const response = await fetch(`${apiUrl}/api/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: data.text,
        lang: 'zh',
        strictness: config.strictness,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      let detail = ''
      try {
        const errBody = await response.json()
        detail = errBody?.message || JSON.stringify(errBody)
      } catch { /* ignore */ }
      throw new Error(`检查失败 (HTTP ${response.status})${detail ? ': ' + detail : ''}`)
    }

    return await response.json()
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('检查超时（LLM 校验超过 120 秒）')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function checkCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) {
    throw new Error('未找到当前标签页')
  }
  await chrome.tabs.sendMessage(tab.id, { type: 'RUN_CHECK' })
}

// 获取配置
async function getConfig() {
  return new Promise<UserConfig>((resolve) => {
    chrome.storage.sync.get(['config'], (result) => {
      const config = (result.config as UserConfig | undefined) ?? getDefaultConfig()
      if (config.apiUrl?.includes('localhost')) {
        config.apiUrl = 'https://api.miaob.net'
      }
      resolve(config)
    })
  })
}

// 默认配置
function getDefaultConfig(): UserConfig {
  return {
    apiUrl: 'https://api.miaob.net',
    enabled: true,
    strictness: Strictness.STANDARD,
    autoCheck: true,
    debounceMs: 800,
    minLength: 4,
    checkOnBlur: true,
  }
}
