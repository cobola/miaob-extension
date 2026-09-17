import { useState } from 'react'
import { userService } from '../services/user.service'
import { t } from '../lib/i18n'

interface ActivationPromptProps {
  onActivated: () => void
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function ActivationPrompt({ onActivated }: ActivationPromptProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [mode, setMode] = useState<'wechat' | 'email'>('wechat')
  const [qrcodeUrl, setQrcodeUrl] = useState('')
  const [status, setStatus] = useState<'idle' | 'pending' | 'scanned' | 'activating' | 'success'>('idle')
  const [error, setError] = useState('')
  const [pollTimer, setPollTimer] = useState<ReturnType<typeof setInterval> | null>(null)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [emailSent, setEmailSent] = useState(false)

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
            setError(err instanceof Error ? err.message : t('activation_failed'))
          }
        }
      }, 1500)
      setPollTimer(timer)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('activation_failed'))
      setStatus('idle')
    }
  }

  const handleClose = () => {
    if (pollTimer) clearInterval(pollTimer)
    setPollTimer(null)
    setIsExpanded(false)
  }

  // ===== 邮箱激活 =====
  const sendCode = async () => {
    setError('')
    try {
      await userService.sendEmailCode(email.trim())
      setEmailSent(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('popupAct_sendFailed'))
    }
  }

  const verifyCode = async () => {
    setError('')
    try {
      const result = await userService.verifyEmail(email.trim(), code.trim())
      if (result.ok) {
        await chrome.storage.local.set({ credits: result.credits, isActivated: true })
        setStatus('success')
        onActivated()
        setTimeout(() => setIsExpanded(false), 2000)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('popupAct_verifyFailed'))
    }
  }

  if (!isExpanded) {
    return (
      <div className="activation-prompt collapsed">
        <button className="activation-btn" onClick={startActivation}>
          {t('activation_cta')}
        </button>
      </div>
    )
  }

  return (
    <div className="activation-prompt expanded">
      <div className="activation-header">
        <h4>{t('activation_title')}</h4>
        <button className="close-btn" onClick={handleClose}>✕</button>
      </div>

      <div className="activation-modes">
        <button type="button" className={mode === 'wechat' ? 'active' : ''} onClick={() => setMode('wechat')}>{t('popupAct_wechat')}</button>
        <button type="button" className={mode === 'email' ? 'active' : ''} onClick={() => setMode('email')}>{t('popupAct_email')}</button>
      </div>

      {mode === 'wechat' && (
        <div className="activation-form wechat-qr">
          {qrcodeUrl ? (
            <>
              <img src={qrcodeUrl} alt={t('activation_qrAlt')} className="qrcode-img" />
              <p className="hint">
                {status === 'pending' && t('activation_waitScan')}
                {status === 'scanned' && t('activation_scanned')}
                {status === 'activating' && t('activation_binding')}
                {status === 'success' && t('activation_success')}
              </p>
            </>
          ) : (
            <p className="hint">{t('activation_loadingQr')}</p>
          )}
        </div>
      )}

      {mode === 'email' && (
        <div className="activation-form email-form">
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder={t('popupAct_emailPlaceholder')}
            autoComplete="email"
          />
          <div className="email-code-row">
            <input
              value={code}
              onChange={e => setCode(e.target.value)}
              placeholder={t('popupAct_codePlaceholder')}
              maxLength={6}
              inputMode="numeric"
            />
            {emailSent
              ? <button type="button" className="submit-btn" onClick={verifyCode} disabled={!code.trim()}>{t('popupAct_verify')}</button>
              : <button type="button" className="submit-btn" onClick={sendCode} disabled={!EMAIL_RE.test(email.trim())}>{t('popupAct_sendCode')}</button>}
          </div>
          <p className="hint">{t('popupAct_emailHint')}</p>
          {status === 'success' && <p className="hint" style={{ color: '#16a34a', fontWeight: 600 }}>{t('activation_success')}</p>}
        </div>
      )}

      {error && <div className="error-message">{error}</div>}
    </div>
  )
}
