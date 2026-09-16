import { t } from '../lib/i18n'

interface CreditsDisplayProps {
  credits: number
}

export function CreditsDisplay({ credits }: CreditsDisplayProps) {
  return (
    <div className="credits-display">
      <span className="credits-icon">⭐</span>
      <span className="credits-label">{t('credits_label')}</span>
      <span className="credits-value">{credits}</span>
    </div>
  )
}
