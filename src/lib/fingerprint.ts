/**
 * 轻量浏览器指纹（不依赖 FingerprintJS）
 * 基于稳定的浏览器特征生成，同一浏览器跨域名一致
 */
export async function getFingerprint(): Promise<string> {
  try {
    // 从 chrome.storage 读取缓存（跨域名共享）
    const stored = await chrome.storage.local.get(['fingerprint'])
    if (stored.fingerprint) return stored.fingerprint as string

    // 生成指纹
    const fp = await generateFingerprint()

    // 缓存
    await chrome.storage.local.set({ fingerprint: fp })
    return fp
  } catch (error) {
    console.warn('Fingerprint error:', error)
    const fallback = 'fp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10)
    await chrome.storage.local.set({ fingerprint: fallback })
    return fallback
  }
}

async function generateFingerprint(): Promise<string> {
  const components = [
    navigator.userAgent,
    navigator.language,
    screen.colorDepth,
    screen.width + 'x' + screen.height,
    new Date().getTimezoneOffset(),
    !!window.localStorage,
    !!window.sessionStorage,
    navigator.hardwareConcurrency || 0,
    // Canvas 指纹（轻量版）
    await getCanvasFingerprint(),
  ]

  // 简单 hash
  const str = components.join('###')
  return sha256(str)
}

async function getCanvasFingerprint(): Promise<string> {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 200
    canvas.height = 50
    const ctx = canvas.getContext('2d')
    if (!ctx) return 'no-canvas'

    ctx.fillStyle = '#f60'
    ctx.fillRect(0, 0, 200, 50)
    ctx.fillStyle = '#069'
    ctx.font = '14px Arial'
    ctx.fillText('miaob-fp', 10, 30)
    ctx.fillStyle = 'rgba(102,204,0,0.7)'
    ctx.fillText('miaob-fp', 12, 32)

    return canvas.toDataURL().slice(-50) // 取末尾部分
  } catch {
    return 'canvas-error'
  }
}

// 简单 SHA-256（使用 SubtleCrypto）
async function sha256(str: string): Promise<string> {
  const buf = new TextEncoder().encode(str)
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32) // 取前 32 位足够
}
