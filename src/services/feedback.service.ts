import { TextError } from '../shared/types'
import { getFingerprint } from '../lib/fingerprint'

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

export class FeedbackService {
  async submitFeedback(
    userId: string,
    error: TextError,
    isCorrect: boolean,
    context: string,
  ): Promise<{ success: boolean; credits: number }> {
    const fingerprint = await getFingerprint()
    const apiUrl = await getApiUrl()

    const response = await fetch(`${apiUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        fingerprint,
        errorType: error.type,
        originalText: error.original,
        suggestion: error.suggestion,
        context,
        isCorrect,
      }),
    })

    if (!response.ok) {
      const err = await response.json()
      throw new Error(err.message || 'Failed to submit feedback')
    }

    return response.json()
  }

  async getStats() {
    const apiUrl = await getApiUrl()
    const response = await fetch(`${apiUrl}/api/feedback/stats`)
    if (!response.ok) throw new Error('Failed to get stats')
    return response.json()
  }
}

export const feedbackService = new FeedbackService()