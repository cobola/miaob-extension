import { useState } from 'react'
import { userService } from '../services/user.service'

interface ActivationPromptProps {
  onActivated: () => void
}

export function ActivationPrompt({ onActivated }: ActivationPromptProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [qrcodeUrl, setQrcodeUrl] = useState('')
  const [status, setStatus] = useState<'idle' | 'pending' | 'scanned' | 'activating' | 'success'>('idle')
  const [error, setError] = useState('')
  const [pollTimer, setPollTimer] = useState<ReturnType<typeof setInterval> | null>(null)

  const startActivation = async () => {
    setIsExpanded(true)
    setError('')
    setStatus('pending')
    try {
      // 创建激活会话；服务端从扩展 Bearer token 识别用户
      const activation = await userService.startActivation()

      // 2. 获取微信二维码
      const qr = await userService.getWechatQrcode(activation.sessionId)
      setQrcodeUrl(qr.qrcodeUrl)

      // 3. 轮询扫码状态（容错：网络波动不中断轮询，仅连续失败才报错）
      let failCount = 0
      const MAX_FAIL = 10
      const timer = setInterval(async () => {
        try {
          const st = await userService.getWechatStatus(qr.sessionId)
          failCount = 0 // 成功则重置计数
          if (st.ok && st.scanned) {
            setStatus('scanned')
            clearInterval(timer)
            setPollTimer(null)
            setStatus('activating')
            const result = await userService.completeActivation(qr.sessionId)
              if (result.ok) {
                if (result.extensionToken) await chrome.storage.local.set({ extensionToken: result.extensionToken, userId: result.userId })
                setStatus('success')
                // 保存新积分到本地存储
                await chrome.storage.local.set({ credits: result.credits, isActivated: true })
                onActivated()
                setTimeout(() => setIsExpanded(false), 2000)
              }
            }
        } catch (err) {
          failCount++
          if (failCount >= MAX_FAIL) {
            clearInterval(timer)
            setPollTimer(null)
            setError(err instanceof Error ? err.message : '激活失败')
          }
        }
      }, 1500)
      setPollTimer(timer)
    } catch (err) {
      setError(err instanceof Error ? err.message : '激活失败')
      setStatus('idle')
    }
  }

  const handleClose = () => {
    if (pollTimer) clearInterval(pollTimer)
    setPollTimer(null)
    setIsExpanded(false)
  }

  if (!isExpanded) {
    return (
      <div className="activation-prompt collapsed">
        <button className="activation-btn" onClick={startActivation}>
          📱 微信扫码激活 送 100 积分
        </button>
      </div>
    )
  }

  return (
    <div className="activation-prompt expanded">
      <div className="activation-header">
        <h4>微信扫码激活</h4>
        <button className="close-btn" onClick={handleClose}>✕</button>
      </div>

      <div className="activation-form wechat-qr">
        {qrcodeUrl ? (
          <>
            <img src={qrcodeUrl} alt="微信扫码激活" className="qrcode-img" />
            <p className="hint">
              {status === 'pending' && '请使用微信扫码'}
              {status === 'scanned' && '扫码成功，正在激活...'}
              {status === 'activating' && '正在绑定账号...'}
              {status === 'success' && '🎉 激活成功，获得 100 积分！'}
            </p>
          </>
        ) : (
          <p className="hint">正在加载二维码...</p>
        )}
      </div>

      {error && <div className="error-message">{error}</div>}
    </div>
  )
}
