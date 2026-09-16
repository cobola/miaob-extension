import { TextError } from '../shared/types'
import { FeedbackButtons } from './FeedbackButtons'
import { t } from '../lib/i18n'

interface ErrorItemProps {
  error: TextError
  onFeedback: (error: TextError, isCorrect: boolean) => void
  onClick: () => void
}

const ERROR_TYPE_LABELS: Record<string, string> = {
  typo: t('err_typo'),
  grammar: t('err_grammar'),
  punctuation: t('err_punctuation'),
  sensitive: t('err_sensitive'),
  redundant: t('err_redundant'),
  collocation: t('err_collocation'),
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
