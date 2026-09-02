import { getFingerprint } from '../lib/fingerprint'

const WECHAT_BASE = 'https://wx.3198.net'
const MI_APP_KEY = 'MfVbFyEfzRqKXRnP_UnL24eQZTibBFwC'

async function getApiUrl(): Promise<string> {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage?.sync) {
      resolve('https://api.miaob.net')
      return
    }
    chrome.storage.sync.get(['config'], (result) => {
      const cfg = (result as { config?: { apiUrl?: string } }).config
      resolve(cfg?.apiUrl || 'https://api.miaob.net')
    })
  })
}

export class UserService {
  async createAnonymousUser(): Promise<{ userId: string; credits: number; inviteCode: string }> {
    const fingerprint = await getFingerprint()
    const apiUrl = await getApiUrl()

    const response = await fetch(`${apiUrl}/api/user/create-anonymous`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprint }),
    })

    if (!response.ok) throw new Error('Failed to create user')
    return response.json()
  }

  async getUserProfile(userId: string) {
    const apiUrl = await getApiUrl()
    const response = await fetch(`${apiUrl}/api/user/profile/${userId}`)
    if (!response.ok) throw new Error('Failed to get profile')
    return response.json()
  }

  // ===== 微信扫码激活 =====
  /** 1. 创建激活会话 */
  async startActivation(userId: string): Promise<{ ok: boolean; sessionId: string; expiresAt: string }> {
    const apiUrl = await getApiUrl()
    const response = await fetch(`${apiUrl}/api/user/activation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    })
    if (!response.ok) throw new Error('Failed to start activation')
    return response.json()
  }

  /** 2. 查询激活状态 */
  async getActivationStatus(sessionId: string): Promise<{ ok: boolean; status: string; openid?: string }> {
    const apiUrl = await getApiUrl()
    const response = await fetch(`${apiUrl}/api/user/activation/status?sessionId=${sessionId}`)
    if (!response.ok) throw new Error('Failed to get activation status')
    return response.json()
  }

  /** 3. 完成激活（绑定 openid） */
  async completeActivation(userId: string, openid: string): Promise<{ ok: boolean; userId: string; credits: number; isActivated: boolean }> {
    const apiUrl = await getApiUrl()
    const response = await fetch(`${apiUrl}/api/user/activation/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, openid }),
    })
    if (!response.ok) throw new Error('Failed to complete activation')
    return response.json()
  }

  /** 4. 获取微信登录二维码 */
  async getWechatQrcode(): Promise<{ ok: boolean; sessionId: string; qrcodeUrl: string; expiresAt: number }> {
    const response = await fetch(`${WECHAT_BASE}/auth/wechat/qrcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_key: MI_APP_KEY }),
    })
    if (!response.ok) throw new Error('Failed to get qrcode')
    return response.json()
  }

  /** 5. 轮询微信扫码状态 */
  async getWechatStatus(sessionId: string): Promise<{ ok: boolean; status: string; scanned?: boolean; openid?: string }> {
    const response = await fetch(`${WECHAT_BASE}/auth/wechat/status?sessionId=${sessionId}`)
    if (!response.ok) throw new Error('Failed to get wechat status')
    return response.json()
  }

  /** 6. 扫码免验证码登录 */
  async wechatScanLogin(sessionId: string): Promise<{ ok: boolean; openid: string }> {
    const response = await fetch(`${WECHAT_BASE}/auth/wechat/scan-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    if (!response.ok) throw new Error('Failed to scan login')
    return response.json()
  }
}

export const userService = new UserService()