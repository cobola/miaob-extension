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

export class UserService {
  // 所有 API 都走 background 代理（绕过 CORS）
  async createAnonymousUser(): Promise<{ userId: string; credits: number; inviteCode: string }> {
    const fingerprint = await getFingerprint()
    return sendMessage({ type: 'CREATE_ANONYMOUS', fingerprint })
  }

  async getUserProfile(userId: string) {
    return sendMessage({ type: 'GET_PROFILE', userId })
  }

  // ===== 微信扫码激活 =====
  async startActivation(userId: string): Promise<{ ok: boolean; sessionId: string; expiresAt: string }> {
    return sendMessage({ type: 'ACTIVATION_START', userId })
  }

  async getActivationStatus(sessionId: string): Promise<{ ok: boolean; status: string; openid?: string }> {
    return sendMessage({ type: 'ACTIVATION_STATUS', sessionId })
  }

  async completeActivation(userId: string, openid: string): Promise<{ ok: boolean; userId: string; credits: number; isActivated: boolean }> {
    return sendMessage({ type: 'ACTIVATION_COMPLETE', userId, openid })
  }

  async getWechatQrcode(): Promise<{ ok: boolean; sessionId: string; qrcodeUrl: string; expiresAt: number }> {
    return sendMessage({ type: 'WECHAT_QRCODE' })
  }

  async getWechatStatus(sessionId: string): Promise<{ ok: boolean; status: string; scanned?: boolean; openid?: string }> {
    return sendMessage({ type: 'WECHAT_STATUS', sessionId })
  }

  async wechatScanLogin(sessionId: string): Promise<{ ok: boolean; openid: string }> {
    return sendMessage({ type: 'WECHAT_SCAN_LOGIN', sessionId })
  }
}

export const userService = new UserService()
