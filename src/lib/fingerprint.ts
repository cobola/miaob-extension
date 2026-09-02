import FingerprintJS from '@fingerprintjs/fingerprintjs'

function generateFallbackId(): string {
  return `fallback_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`
}

/**
 * 获取或生成浏览器指纹
 * 参考 cv100 实现
 */
export async function getFingerprint(): Promise<string> {
  try {
    // 检查 localStorage 缓存
    const stored = localStorage.getItem('miaob_fingerprint')
    if (stored) return stored

    // 使用 FingerprintJS 生成指纹
    const fp = await FingerprintJS.load()
    const result = await fp.get()
    const visitorId = result.visitorId

    localStorage.setItem('miaob_fingerprint', visitorId)
    return visitorId
  } catch (error) {
    console.warn('Failed to generate fingerprint, using fallback:', error)
    // 失败降级：生成随机 ID
    const fallbackId = generateFallbackId()
    localStorage.setItem('miaob_fingerprint', fallbackId)
    return fallbackId
  }
}
