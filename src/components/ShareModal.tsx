import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { t } from '../lib/i18n'

export function ShareModal({ url, onClose }: { url: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  useEffect(() => {
    QRCode.toDataURL(url, { width: 180, margin: 1, color: { dark: '#1e293b', light: '#ffffff' } })
      .then(setQrDataUrl)
      .catch(() => {})
  }, [url])

  const copy = async () => { try { await navigator.clipboard.writeText(url); setCopied(true) } catch {} }

  return (
    <div className="share-overlay">
      <div className="share-modal">
        <button className="share-close" onClick={onClose}>✕</button>
        <h3>{t('share_success')}</h3>

        {qrDataUrl && (
          <div className="share-qr">
            <img src={qrDataUrl} alt={t('share_qrAlt')} width={180} height={180} />
          </div>
        )}

        <div className="share-hint">{t('share_hint')}</div>

        <input readOnly value={url} onFocus={e => e.currentTarget.select()} />
        <div className="share-actions">
          <button onClick={copy}>📋 {copied ? t('share_copied') : t('share_copyLink')}</button>
          <button onClick={() => window.open(url, '_blank')}>{t('share_open')}</button>
        </div>
      </div>
    </div>
  )
}
