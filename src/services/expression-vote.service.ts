// 表达高光投票服务 — 通过 background 代理 API 请求 + chrome.storage.local 持久缓存

const STORAGE_KEY = 'expression_voted_hashes'

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

export interface VoteParams {
  expressionHash: string
  text: string
  type: string
  sourceUrl?: string
  vote: boolean
}

export interface VoteResult {
  ok: boolean
  voted: boolean
  totalVotes: number
  approved: boolean
}

export interface VoteStatusMap {
  [hash: string]: { hasVoted: boolean; totalVotes: number; approved: boolean }
}

export class ExpressionVoteService {
  private votedCache = new Set<string>()
  private loaded = false

  /** 从 chrome.storage.local 加载已投票 hash */
  async loadCache(): Promise<void> {
    if (this.loaded) return
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY)
      const hashes = (data[STORAGE_KEY] as string[]) || []
      this.votedCache = new Set(hashes)
    } catch {
      // storage 不可用时降级为内存缓存
    }
    this.loaded = true
  }

  private async saveCache(): Promise<void> {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: Array.from(this.votedCache) })
    } catch {
      // ignore
    }
  }

  async vote(params: VoteParams): Promise<VoteResult> {
    console.log('[Miaob] vote 发送', params.expressionHash)
    try {
      const result = await sendMessage<VoteResult>({ type: 'EXPRESSION_VOTE', data: params })
      console.log('[Miaob] vote 返回', result)
      if (result.voted) {
        this.votedCache.add(params.expressionHash)
        await this.saveCache()
      }
      return result
    } catch (e) {
      console.error('[Miaob] vote 异常', e)
      throw e
    }
  }

  async getStatus(hashes: string[]): Promise<VoteStatusMap> {
    if (hashes.length === 0) return {}
    const result = await sendMessage<{ ok: boolean; status: VoteStatusMap }>({
      type: 'EXPRESSION_VOTE_STATUS',
      data: { hashes },
    })
    for (const hash of hashes) {
      if (result?.status?.[hash]?.hasVoted) {
        this.votedCache.add(hash)
      }
    }
    await this.saveCache()
    return result?.status || {}
  }

  /** 从本地缓存快速判断是否已投票（用于初始渲染） */
  hasVotedLocal(hash: string): boolean {
    return this.votedCache.has(hash)
  }
}

export const expressionVoteService = new ExpressionVoteService()
