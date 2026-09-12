import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

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
        <h3>📤 分享成功！</h3>

        {qrDataUrl && (
          <div className="share-qr">
            <img src={qrDataUrl} alt="扫码分享" width={180} height={180} />
          </div>
        )}

        <div className="share-hint">扫描二维码分享</div>

        <input readOnly value={url} onFocus={e => e.currentTarget.select()} />
        <div className="share-actions">
          <button onClick={copy}>📋 {copied ? '已复制' : '复制链接'}</button>
          <button onClick={() => window.open(url, '_blank')}>打开分享页</button>
        </div>
      </div>
    </div>
  )
}
