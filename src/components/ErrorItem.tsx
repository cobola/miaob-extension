import { TextError } from '../shared/types'
import { FeedbackButtons } from './FeedbackButtons'

interface ErrorItemProps {
  error: TextError
  onFeedback: (error: TextError, isCorrect: boolean) => void
  onClick: () => void
}

const ERROR_TYPE_LABELS: Record<string, string> = {
  typo: '错别字',
  grammar: '语法错误',
  punctuation: '标点错误',
  sensitive: '规范用词',
  redundant: '冗余表达',
  collocation: '搭配不当',
}

export function ErrorItem({ error, onFeedback, onClick }: ErrorItemProps) {
  const typeLabel = ERROR_TYPE_LABELS[error.type] || error.type

  return (
    <div className="error-item" onClick={onClick}>
      <div className="error-content">
        <div className="error-header">
          <span className={`error-type type-${error.type}`}>{typeLabel}</span>
        </div>

        <div className="error-text">
          <span className="original">{error.original}</span>
          {error.suggestion && (
            <>
              <span className="arrow">→</span>
              <span className="suggestion">{error.suggestion}</span>
            </>
          )}
        </div>

        {error.message && (
          <div className="error-message">{error.message}</div>
        )}
      </div>

      <FeedbackButtons
        error={error}
        onFeedback={onFeedback}
      />
    </div>
  )
}
