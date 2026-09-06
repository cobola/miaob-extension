import { getFingerprint } from '../lib/fingerprint'

// 通过 background script 发消息（绕过 CORS）
function sendMessage<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      reject(new Error('chrome.runtime not available'))
      return
    }
    chrome.runtime.sendMessage(message, (response: { success: boolean; data?: T; error?: string }) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else if (response?.success) {
        resolve(response.data as T)
      } else {
        reject(new Error(response?.error || 'Unknown error'))
      }
    })
  })
}

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

  // ===== 微信扫码激活（通过 background 代理绕过 CORS） =====
  /** 1. 创建激活会话 */
  async startActivation(userId: string): Promise<{ ok: boolean; sessionId: string; expiresAt: string }> {
    return sendMessage({ type: 'ACTIVATION_START', userId })
  }

  /** 2. 查询激活状态 */
  async getActivationStatus(sessionId: string): Promise<{ ok: boolean; status: string; openid?: string }> {
    return sendMessage({ type: 'ACTIVATION_STATUS', sessionId })
  }

  /** 3. 完成激活（绑定 openid） */
  async completeActivation(userId: string, openid: string): Promise<{ ok: boolean; userId: string; credits: number; isActivated: boolean }> {
    return sendMessage({ type: 'ACTIVATION_COMPLETE', userId, openid })
  }

  /** 4. 获取微信登录二维码（通过服务端代理，返回 base64 data URL） */
  async getWechatQrcode(): Promise<{ ok: boolean; sessionId: string; qrcodeUrl: string; expiresAt: number }> {
    return sendMessage({ type: 'WECHAT_QRCODE' })
  }

  /** 5. 轮询微信扫码状态 */
  async getWechatStatus(sessionId: string): Promise<{ ok: boolean; status: string; scanned?: boolean; openid?: string }> {
    return sendMessage({ type: 'WECHAT_STATUS', sessionId })
  }

  /** 6. 扫码免验证码登录 */
  async wechatScanLogin(sessionId: string): Promise<{ ok: boolean; openid: string }> {
    return sendMessage({ type: 'WECHAT_SCAN_LOGIN', sessionId })
  }
}

export const userService = new UserService()
