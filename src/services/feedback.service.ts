import { TextError } from '../shared/types'
import { getFingerprint } from '../lib/fingerprint'

export interface FeedbackResponse {
  success: boolean
  credits: number
}

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

export class FeedbackService {
  async submitFeedback(
    userId: string,
    error: TextError,
    isCorrect: boolean,
    context: string,
  ): Promise<FeedbackResponse> {
    const fingerprint = await getFingerprint()
    return sendMessage<FeedbackResponse>({
      type: 'SUBMIT_FEEDBACK',
      data: {
        userId,
        fingerprint,
        errorType: error.type,
        originalText: error.original,
        suggestion: error.suggestion,
        context,
        isCorrect,
      },
    })
  }

  async getStats() {
    return sendMessage({ type: 'GET_FEEDBACK_STATS' })
  }
}

export const feedbackService = new FeedbackService()
