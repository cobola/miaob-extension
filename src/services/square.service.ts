// 广场服务 — 提交成语/错误到广场，投票，投诉
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

export interface SquareIdiomData {
  idiom: string
  passage: string
  url: string
}

export interface SquareErrorData {
  originalText: string
  suggestion: string
  url: string
}

export interface SquareItem {
  id: string
  url: string
  status: string
  yesVotes: number
  noVotes: number
  discoveredBy: string
  createdAt: string
  voted: boolean
  isOwner: boolean
  complaintCount: number
}

export interface SquareListResponse {
  items: SquareItem[]
  total: number
  page: number
  limit: number
}

export const squareService = {
  // 提交成语发现
  submitIdiom: (data: SquareIdiomData): Promise<{ id: string; status: string }> =>
    sendMessage({ type: 'SQUARE_SUBMIT_IDIOM', data }),

  // 提交错误发现
  submitError: (data: SquareErrorData): Promise<{ id: string; status: string }> =>
    sendMessage({ type: 'SQUARE_SUBMIT_ERROR', data }),

  // 获取成语广场列表
  getIdioms: (params?: { range?: string; search?: string; page?: number; limit?: number }): Promise<SquareListResponse> =>
    sendMessage({ type: 'SQUARE_GET_IDIOMS', ...params }),

  // 获取错误广场列表
  getErrors: (params?: { range?: string; search?: string; page?: number; limit?: number }): Promise<SquareListResponse> =>
    sendMessage({ type: 'SQUARE_GET_ERRORS', ...params }),

  // 投票（成语）
  voteIdiom: (itemId: string, isCorrect: boolean): Promise<{ status: string; yesVotes: number; noVotes: number }> =>
    sendMessage({ type: 'SQUARE_VOTE_IDIOM', itemId, isCorrect }),

  // 投票（错误）
  voteError: (itemId: string, isCorrect: boolean): Promise<{ status: string; yesVotes: number; noVotes: number }> =>
    sendMessage({ type: 'SQUARE_VOTE_ERROR', itemId, isCorrect }),

  // 投诉
  complain: (type: 'idiom' | 'error', itemId: string): Promise<{ complaintCount: number; status: string }> =>
    sendMessage({ type: 'SQUARE_COMPLAINT', targetType: type, itemId }),

  // 删除（仅提交人）
  remove: (type: 'idiom' | 'error', itemId: string): Promise<{ ok: boolean }> =>
    sendMessage({ type: 'SQUARE_REMOVE', targetType: type, itemId }),

  // 兼容旧版 API
  getIdiomSquare: (page = 1, limit = 20) => squareService.getIdioms({ page, limit }),
  getErrorSquare: (page = 1, limit = 20) => squareService.getErrors({ page, limit }),
}
