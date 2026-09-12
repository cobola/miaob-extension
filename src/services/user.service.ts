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
  async createAnonymousUser(fingerprint: string): Promise<{ userId: string; credits: number; inviteCode: string; isActivated: boolean }> {
    return sendMessage({ type: 'CREATE_ANONYMOUS', fingerprint })
  }

  async getUserProfile(userId: string): Promise<{ userId: string; credits: number; isActivated: boolean; consecutiveDays: number; inviteCode: string }> {
    return sendMessage({ type: 'GET_PROFILE', userId })
  }

  async dailyCheckin(userId: string): Promise<{ ok: boolean; credits: number; consecutiveDays: number; alreadyCheckedIn: boolean; streakBonus: number }> {
    return sendMessage({ type: 'DAILY_CHECKIN', userId })
  }

  // ===== 微信扫码激活 =====
  async startActivation(): Promise<{ ok: boolean; sessionId: string; expiresAt: string }> {
    return sendMessage({ type: 'ACTIVATION_START' })
  }

  async getActivationStatus(sessionId: string): Promise<{ ok: boolean; status: string }> {
    return sendMessage({ type: 'ACTIVATION_STATUS', sessionId })
  }

  async completeActivation(sessionId: string): Promise<{ ok: boolean; userId: string; credits: number; isActivated: boolean; extensionToken?: string }> {
    return sendMessage({ type: 'ACTIVATION_COMPLETE', sessionId })
  }

  async getWechatQrcode(sessionId: string): Promise<{ ok: boolean; sessionId: string; qrcodeUrl: string; expiresAt: number }> {
    return sendMessage({ type: 'WECHAT_QRCODE', sessionId })
  }

  async getWechatStatus(sessionId: string): Promise<{ ok: boolean; status: string; scanned?: boolean }> {
    return sendMessage({ type: 'WECHAT_STATUS', sessionId })
  }

}

export const userService = new UserService()
