// 发现服务 — 记录成语/名句/歇后语的发现，查询排行榜
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

export interface DiscoveryItem {
  type: 'idiom' | 'quote' | 'xiehouyu'
  text: string
}

export interface DiscoveryResult {
  text: string
  order: number
  points: number
}

export interface DiscoveryResponse {
  newDiscoveries: DiscoveryResult[]
  totalPoints: number
}

export class DiscoveryService {
  // 记录发现
  async recordDiscoveries(items: DiscoveryItem[], sourceUrl?: string): Promise<DiscoveryResponse> {
    const userId = await this.getUserId()
    if (!userId || items.length === 0) {
      return { newDiscoveries: [], totalPoints: 0 }
    }
    return sendMessage({
      type: 'RECORD_DISCOVERIES',
      userId,
      items,
      sourceUrl: sourceUrl || location.href,
    })
  }

  // 获取用户统计
  async getUserStats(): Promise<{ totalDiscoveries: number; firstDiscoveries: number; rank: number }> {
    const userId = await this.getUserId()
    if (!userId) return { totalDiscoveries: 0, firstDiscoveries: 0, rank: 0 }
    return sendMessage({ type: 'GET_DISCOVERY_STATS', userId })
  }

  private getUserId(): Promise<string> {
    return new Promise((resolve) => {
      chrome.storage.local.get(['userId'], (result) => {
        resolve((result.userId as string) || '')
      })
    })
  }
}

export const discoveryService = new DiscoveryService()
