import { useState } from 'react'
import { userService } from '../services/user.service'

interface ActivationPromptProps {
  userId: string
  onActivated: () => void
}

export function ActivationPrompt({ userId, onActivated }: ActivationPromptProps) {
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
      // 1. 创建激活会话
      await userService.startActivation(userId)

      // 2. 获取微信二维码
      const qr = await userService.getWechatQrcode()
      setQrcodeUrl(qr.qrcodeUrl)

      // 3. 轮询扫码状态
      const timer = setInterval(async () => {
        try {
          const st = await userService.getWechatStatus(qr.sessionId)
          if (st.ok && st.scanned && st.openid) {
            setStatus('scanned')
            clearInterval(timer)
            setPollTimer(null)
            // 4. 扫码免验证码登录
            const login = await userService.wechatScanLogin(qr.sessionId)
            if (login.ok) {
              setStatus('activating')
              // 5. 完成激活
              const result = await userService.completeActivation(userId, login.openid)
              if (result.ok) {
                setStatus('success')
                onActivated()
                setTimeout(() => setIsExpanded(false), 2000)
              }
            }
          }
        } catch (err) {
          clearInterval(timer)
          setPollTimer(null)
          setError(err instanceof Error ? err.message : '激活失败')
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