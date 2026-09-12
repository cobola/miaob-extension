import { useState } from 'react'

export function ShareModal({ url, onClose }: { url: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => { try { await navigator.clipboard.writeText(url); setCopied(true) } catch {} }
  return <div className="share-overlay"><div className="share-modal"><button className="share-close" onClick={onClose}>✕</button><h3>📤 分享成功！</h3><input readOnly value={url} onFocus={e => e.currentTarget.select()} /><div className="share-actions"><button onClick={copy}>📋 {copied ? '已复制' : '复制链接'}</button><button onClick={() => window.open(url, '_blank')}>打开分享页</button></div><div className="share-hint">分享到微信、微博或 Twitter</div></div></div>
}
