import { useState } from 'react'
import { TextError } from './shared/types'

interface FeedbackButtonsProps {
  error: TextError
  onFeedback: (error: TextError, isCorrect: boolean) => void
}

export function FeedbackButtons({ error, onFeedback }: FeedbackButtonsProps) {
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleFeedback = async (isCorrect: boolean, e: React.MouseEvent) => {
    e.stopPropagation()

    if (feedback !== null || isSubmitting) return

    setIsSubmitting(true)
    try {
      await onFeedback(error, isCorrect)
      setFeedback(isCorrect ? 'up' : 'down')
    } catch (err) {
      console.error('Failed to submit feedback:', err)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="feedback-buttons">
      <button
        className={`feedback-btn up ${feedback === 'up' ? 'active' : ''}`}
        onClick={(e) => handleFeedback(true, e)}
        disabled={feedback !== null || isSubmitting}
        title="检测正确 +2 积分"
      >
        👍
      </button>
      <button
        className={`feedback-btn down ${feedback === 'down' ? 'active' : ''}`}
        onClick={(e) => handleFeedback(false, e)}
        disabled={feedback !== null || isSubmitting}
        title="检测错误 +5 积分"
      >
        👎
      </button>
    </div>
  )
}
