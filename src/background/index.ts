import { type UserConfig } from '../shared/types'
import { getFingerprint } from '../lib/fingerprint'

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

// 注入内容脚本到指定标签页（如已注入则发送消息触发检查）
async function injectContentScript(tabId: number) {
  try {
    // 尝试注入，如果已存在会报错，忽略即可
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    })
  } catch (_) {
    // 已注入，发送消息触发检查
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'RUN_CHECK' })
    } catch (_) {}
  }
  // 注入 CSS（幂等，重复注入无影响）
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content.css'],
    })
  } catch (_) {}
}

// 点击扩展图标：直接检查当前页
chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return
  injectContentScript(tab.id)
})

// 标签页切换激活时自动检查
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId)
    if (tab.url?.startsWith('http')) {
      injectContentScript(activeInfo.tabId)
    }
  } catch (_) {}
})

// 标签页更新（导航/刷新）时自动检查
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.startsWith('http')) {
    injectContentScript(tabId)
  }
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

  // LLM 直检（深度检查）
  if (message.type === 'CHECK_TEXT_LLM') {
    handleTextCheckLLM(message.data)
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

  // 激活相关 API（background 代理，绕过 CORS）
  if (message.type === 'WECHAT_QRCODE') {
    handleWechatQrcode(message.sessionId)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }

  if (message.type === 'ACTIVATION_START') {
    handleActivationStart()
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }

  if (message.type === 'ACTIVATION_STATUS') {
    handleActivationStatus(message.sessionId)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }

  if (message.type === 'ACTIVATION_COMPLETE') {
    handleActivationComplete(message.sessionId)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }

  if (message.type === 'WECHAT_STATUS') {
    handleWechatStatus(message.sessionId)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }

  if (message.type === 'FETCH_IDIOM_DETAIL') {
    handleFetchIdiomDetail(message.idiom)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }
  if (message.type === 'ADD_MIAOBEN') {
    handleAddMiaoben(message.idiom, message.sourceUrl)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }


  // 反馈相关（也走 background 避免 CORS）
  if (message.type === 'SUBMIT_FEEDBACK') {
    handleSubmitFeedback(message.data)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }

  if (message.type === 'GET_FEEDBACK_STATS') {
    handleGetFeedbackStats()
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }

  if (message.type.startsWith('SQUARE_')) {
    handleSquareMessage(message).then(data => sendResponse({ success: true, data })).catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }

  // 每日签到
  if (message.type === 'DAILY_CHECKIN') {
    handleDailyCheckin()
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }

  // 发现相关
  if (message.type === 'RECORD_DISCOVERIES') {
    handleRecordDiscoveries(message.items, message.sourceUrl)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }

  if (message.type === 'GET_DISCOVERY_STATS') {
    handleGetDiscoveryStats()
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }

  if (message.type === 'CREATE_SHARE') {
    handleCreateShare(message.data)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }

  // 用户相关（也走 background 避免 CORS）
  if (message.type === 'CREATE_ANONYMOUS') {
    handleCreateAnonymous(message.fingerprint as string)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }

  if (message.type === 'GET_PROFILE') {
    handleGetProfile(message.userId as string)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }

  // 表达高光投票
  if (message.type === 'EXPRESSION_VOTE') {
    handleExpressionVote(message.data)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }))
    return true
  }

  if (message.type === 'EXPRESSION_VOTE_STATUS') {
    handleExpressionVoteStatus(message.data)
      .then(data => sendResponse({ success: true, data }))
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
  const total = idioms.length + phrases.length

    if (total === 0) {
      const ok = document.createElement('div')
    ok.textContent = '未发现成语、名句或歇后语'
      ok.style.cssText = 'color:#16a34a'
      card.appendChild(ok)
    } else {
      const count = document.createElement('div')
    count.textContent = `发现 ${idioms.length} 个成语 · ${phrases.length} 个名句/歇后语`
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
    }
  }

  document.body.appendChild(card)
}

// ===== 激活 API 处理器（background 代理绕过 CORS） =====
const API_TIMEOUT_MS = 30000 // 激活接口 30 秒超时

/** 通用 fetch 代理：自动注入超时、解析 JSON、统一错误 */
async function fetchProxy(url: string, options?: RequestInit): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    const headers = new Headers(options?.headers || {})
    if (!headers.has('Authorization') && !url.endsWith('/api/extension/bootstrap')) {
      const token = await ensureExtensionToken()
      if (token) headers.set('Authorization', `Bearer ${token}`)
    }
    const response = await fetch(url, { ...options, headers, signal: controller.signal })
    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}${errBody ? ': ' + errBody.slice(0, 200) : ''}`)
    }
    return await response.json()
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Request timeout (${API_TIMEOUT_MS / 1000}s)`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

let extensionTokenPromise: Promise<string> | null = null
async function ensureExtensionToken(): Promise<string | null> {
  const stored = await chrome.storage.local.get(['extensionToken'])
  if (typeof stored.extensionToken === 'string' && stored.extensionToken) return stored.extensionToken
  if (!extensionTokenPromise) {
    extensionTokenPromise = (async () => {
      const apiUrl = await getApiUrlCached()
      const fp = await getFingerprint()
      const data = await fetchProxy(`${apiUrl}/api/extension/bootstrap`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fingerprint: fp }),
      })
      await chrome.storage.local.set({ extensionToken: data.extensionToken, isActivated: data.isActivated })
      return data.extensionToken as string
    })().finally(() => { extensionTokenPromise = null })
  }
  return extensionTokenPromise
}

/** 获取 API 地址（带缓存，避免重复读取 storage） */
let cachedApiUrl: string | null = null
function getApiUrlCached(): Promise<string> {
  if (cachedApiUrl) return Promise.resolve(cachedApiUrl)
  return getConfig().then(cfg => {
    cachedApiUrl = cfg.apiUrl || 'https://api.miaob.net'
    return cachedApiUrl
  })
}

async function handleWechatQrcode(sessionId: string) {
  const apiUrl = await getApiUrlCached()
  return fetchProxy(`${apiUrl}/api/user/activation/qrcode?sessionId=${encodeURIComponent(sessionId)}`)
}

async function handleActivationStart() {
  const apiUrl = await getApiUrlCached()
  return fetchProxy(`${apiUrl}/api/user/activation/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handleActivationStatus(sessionId: string) {
  const apiUrl = await getApiUrlCached()
  return fetchProxy(`${apiUrl}/api/user/activation/status?sessionId=${sessionId}`)
}

async function handleActivationComplete(sessionId: string) {
  const apiUrl = await getApiUrlCached()
  return fetchProxy(`${apiUrl}/api/user/activation/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
}

async function handleWechatStatus(sessionId: string) {
  const apiUrl = await getApiUrlCached()
  return fetchProxy(`${apiUrl}/api/user/activation/wechat-status?sessionId=${encodeURIComponent(sessionId)}`)
}

async function handleFetchIdiomDetail(idiom: unknown) {
  if (typeof idiom !== 'string' || Array.from(idiom).length === 0 || Array.from(idiom).length > 15) {
    throw new Error('invalid idiom')
  }
  const apiUrl = await getApiUrlCached()
  const key = idiom
  const cached = idiomDetailCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.data
  const data = await fetchProxy(`${apiUrl}/api/idiom/detail?idiom=${encodeURIComponent(idiom)}`)
  idiomDetailCache.set(key, { data, expiresAt: Date.now() + 3600000 })
  return data
}

async function handleCreateShare(data: any) {
  if (!data || typeof data.title !== 'string' || typeof data.url !== 'string' || !Array.isArray(data.items)) throw new Error('invalid share data')
  const apiUrl = await getApiUrlCached()
  return fetchProxy(`${apiUrl}/api/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
}

const idiomDetailCache = new Map<string, { data: any; expiresAt: number }>()

async function handleAddMiaoben(idiom: unknown, sourceUrl?: unknown) {
  if (typeof idiom !== 'string' || !idiom) throw new Error('invalid idiom')
  const apiUrl = await getApiUrlCached()
  try {
    return await fetchProxy(`${apiUrl}/api/miaoben/items`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemType: 'idiom', itemText: idiom, sourceUrl: typeof sourceUrl === 'string' ? sourceUrl : undefined }),
    })
  } catch (error: any) {
    // 未激活用户返回特殊标记，让前端展示引导
    if (error.message?.includes('403')) {
      return { needsActivation: true }
    }
    throw error
  }
}


// 反馈相关
async function handleSubmitFeedback(data: Record<string, unknown>) {
  const apiUrl = await getApiUrlCached()
  return fetchProxy(`${apiUrl}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

async function handleGetFeedbackStats() {
  const apiUrl = await getApiUrlCached()
  return fetchProxy(`${apiUrl}/api/feedback/stats`)
}

async function handleSquareMessage(message: any) {
  const apiUrl = await getApiUrlCached()
  const base = `${apiUrl}/api/square`

  // 构建查询参数
  function buildListParams(p: any) {
    const sp = new URLSearchParams()
    if (p?.page) sp.set('page', p.page)
    if (p?.limit) sp.set('limit', p.limit)
    if (p?.range && p.range !== 'all') sp.set('range', p.range)
    if (p?.search) sp.set('search', p.search)
    return sp.toString()
  }

  if (message.type === 'SQUARE_GET_ERRORS') {
    const qs = buildListParams(message)
    return fetchProxy(`${base}/errors?${qs}`)
  }
  if (message.type === 'SQUARE_GET_IDIOMS') {
    const qs = buildListParams(message)
    return fetchProxy(`${base}/idioms?${qs}`)
  }
  if (message.type === 'SQUARE_SUBMIT_ERROR') {
    return fetchProxy(`${base}/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.data),
    })
  }
  if (message.type === 'SQUARE_SUBMIT_IDIOM') {
    return fetchProxy(`${base}/idioms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.data),
    })
  }
  // 投票
  if (message.type === 'SQUARE_VOTE_IDIOM' || message.type === 'SQUARE_VOTE_ERROR') {
    const isIdiom = message.type === 'SQUARE_VOTE_IDIOM'
    const isCorrect = message.isCorrect !== undefined ? !!message.isCorrect : (isIdiom ? !!message.isIdiom : !!message.isError)
    return fetchProxy(`${base}/${isIdiom ? 'idioms' : 'errors'}/${message.itemId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isCorrect }),
    })
  }
  // 投诉
  if (message.type === 'SQUARE_COMPLAINT') {
    const targetType = message.targetType || 'idiom'
    return fetchProxy(`${base}/${targetType === 'error' ? 'errors' : 'idioms'}/${message.itemId}/complaint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  }
  // 删除
  if (message.type === 'SQUARE_REMOVE') {
    const targetType = message.targetType || 'idiom'
    return fetchProxy(`${base}/${targetType === 'error' ? 'errors' : 'idioms'}/${message.itemId}`, {
      method: 'DELETE',
    })
  }
  throw new Error(`Unknown SQUARE_ message type: ${message.type}`)
}

// 每日签到
async function handleDailyCheckin() {
  const apiUrl = await getApiUrlCached()
  return fetchProxy(`${apiUrl}/api/user/checkin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
}

// 发现相关
async function handleRecordDiscoveries(items: any[], sourceUrl?: string) {
  const apiUrl = await getApiUrlCached()
  return fetchProxy(`${apiUrl}/api/game/discoveries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, sourceUrl }),
  })
}

async function handleGetDiscoveryStats() {
  const apiUrl = await getApiUrlCached()
  return fetchProxy(`${apiUrl}/api/game/stats/current`)
}

// 用户相关（也走 background 避免 CORS）
async function handleCreateAnonymous(fingerprint: string) {
  // 指纹只参与 bootstrap；后续一律由扩展令牌决定账号，避免客户端 ID 覆盖已绑定账号。
  void fingerprint
  const token = await ensureExtensionToken()
  if (!token) throw new Error('extension authentication unavailable')
  const apiUrl = await getApiUrlCached()
  return fetchProxy(`${apiUrl}/api/user/me`)
}

async function handleGetProfile(userId: string) {
  void userId
  const apiUrl = await getApiUrlCached()
  return fetchProxy(`${apiUrl}/api/user/me`)
}

// LLM 直检（深度检查）
// 表达高光投票
async function handleExpressionVote(data: any) {
  if (!data || typeof data.expressionHash !== 'string' || typeof data.text !== 'string') {
    throw new Error('invalid vote data')
  }
  const apiUrl = await getApiUrlCached()
  return fetchProxy(`${apiUrl}/api/expression/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

async function handleExpressionVoteStatus(data: any) {
  if (!data || !Array.isArray(data.hashes)) {
    throw new Error('invalid vote status data')
  }
  const apiUrl = await getApiUrlCached()
  return fetchProxy(`${apiUrl}/api/expression/vote-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: data.hashes }),
  })
}

async function handleTextCheckLLM(data: { text: string; lang?: string }) {
  const config = await getConfig()
  const apiUrl = config.apiUrl || 'https://api.miaob.net'
  const lang = data.lang || 'zh'

  return fetchProxy(`${apiUrl}/api/check/llm-direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: data.text, lang }),
  })
}

async function handleTextCheck(data: { text: string }) {
  if (!data?.text || data.text.trim().length === 0) {
    throw new Error('text is required')
  }
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
    autoCheck: true,
    debounceMs: 800,
    minLength: 4,
    checkOnBlur: true,
  }
}
