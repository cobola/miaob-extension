interface CreditsDisplayProps {
  credits: number
}

export function CreditsDisplay({ credits }: CreditsDisplayProps) {
  return (
    <div className="credits-display">
      <span className="credits-icon">⭐</span>
      <span className="credits-label">积分</span>
      <span className="credits-value">{credits}</span>
    </div>
  )
}
