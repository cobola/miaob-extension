import { useState, useEffect, useRef } from 'react'
import { userService } from '../services/user.service'
import { t } from '../lib/i18n'

interface PopupActivationProps {
  credits: number
  isActivated: boolean
  onActivated: (newCredits: number) => void
}

type Status = 'idle' | 'starting' | 'pending' | 'scanned' | 'activating' | 'success' | 'error'

export function PopupActivation({ credits, isActivated, onActivated }: PopupActivationProps) {
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const [qrUrl, setQrUrl] = useState('')
  const [msg, setMsg] = useState('')
  const [mode, setMode] = useState<'wechat' | 'email'>('wechat')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [emailSent, setEmailSent] = useState(false)
  const [sentEmail, setSentEmail] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const cleanup = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  const start = async () => {
    setExpanded(true)
    setMsg('')
    setStatus('starting')
    try {
      const activation = await userService.startActivation()
      const qr = await userService.getWechatQrcode(activation.sessionId)
      setQrUrl(qr.qrcodeUrl)
      setStatus('pending')
      pollRef.current = setInterval(async () => {
        try {
          const st = await userService.getWechatStatus(qr.sessionId)
          if (st.ok && st.scanned) {
            cleanup()
            setStatus('scanned')
            setStatus('activating')
            const result = await userService.completeActivation(qr.sessionId)
            if (result.ok) {
              if (result.extensionToken) await chrome.storage.local.set({ extensionToken: result.extensionToken, userId: result.userId })
              setStatus('success')
              setMsg(`+100 积分`)
              onActivated(result.credits)
            }
          }
        } catch (e) {
          cleanup()
          setStatus('error')
          setMsg(e instanceof Error ? e.message : t('popupAct_pollFailed'))
        }
      }, 1500)
    } catch (e) {
      setStatus('error')
      setMsg(e instanceof Error ? e.message : t('popupAct_qrGetFailed'))
    }
  }

  const close = () => {
    cleanup()
    setExpanded(false)
    setStatus('idle')
    setQrUrl('')
  }

  const sendCode = async () => { try { await userService.sendEmailCode(email.trim()); setEmailSent(true); setSentEmail(email.trim().toLowerCase()); setMsg(t('popupAct_codeSent')) } catch (e) { setMsg(e instanceof Error ? e.message : t('popupAct_sendFailed')) } }
  const verifyCode = async () => { try { const result = await userService.verifyEmail(email.trim(), code.trim()); if (result.ok) { await chrome.storage.local.set({ credits: result.credits, isActivated: true }); setStatus('success'); setMsg('+100'); onActivated(result.credits) } } catch (e) { setMsg(e instanceof Error ? e.message : t('popupAct_verifyFailed')) } }

  // 已激活：header 内绿色徽章
  if (isActivated) {
    return (
      <div className="header-activation activated" title={t('popupAct_activated')}>
        <span>✓</span>
        <span>{credits}</span>
      </div>
    )
  }

  // 未展开：header 内激活按钮
  if (!expanded) {
    return (
      <button onClick={start} className="header-activation not-activated">
        +100
      </button>
    )
  }

  // 展开显示二维码（弹窗覆盖层）
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={close}>
      <div className="bg-white rounded-2xl p-5 shadow-xl max-w-xs mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm font-semibold text-gray-800">{t('popupAct_title')}</span>
          <button onClick={close} className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">✕</button>
        </div>

        <div className="flex gap-2 mb-4"><button onClick={() => setMode('wechat')} className="text-xs px-2 py-1 rounded bg-gray-100">{t('popupAct_wechat')}</button><button onClick={() => setMode('email')} className="text-xs px-2 py-1 rounded bg-gray-100">{t('popupAct_email')}</button></div>
        {mode === 'wechat' && !qrUrl && status === 'starting' && (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 border-2 border-gray-200 border-t-blue-500 rounded-full animate-spin" />
          </div>
        )}

        {mode === 'wechat' && qrUrl && (
          <div className="flex flex-col items-center gap-3">
            <img
              src={qrUrl}
              alt={t('popupAct_wechat')}
              className="w-40 h-40 rounded-xl border border-gray-100"
              onError={() => { setStatus('error'); setMsg(t('popupAct_qrFail')) }}
            />
            <p className="text-sm text-gray-500 h-5">
              {status === 'pending' && t('popupAct_waitScan')}
              {status === 'scanned' && t('popupAct_scanned')}
              {status === 'activating' && t('popupAct_activating')}
              {status === 'success' && msg && <span className="text-green-600 font-medium">{t('popupAct_success', msg)}</span>}
            </p>
          </div>
        )}
        {mode === 'email' && <div className="space-y-2"><input value={email} onChange={e => { setEmail(e.target.value); if (emailSent && e.target.value.trim().toLowerCase() !== sentEmail) { setEmailSent(false); setCode(''); setMsg('') } }} placeholder={t('popupAct_emailPlaceholder')} className="w-full border rounded px-3 py-2 text-sm" /><div className="flex gap-2"><input value={code} onChange={e => setCode(e.target.value)} placeholder={t('popupAct_codePlaceholder')} className="flex-1 border rounded px-3 py-2 text-sm" />{emailSent ? <button onClick={verifyCode} className="px-3 py-2 bg-blue-600 text-white rounded text-sm">{t('popupAct_verify')}</button> : <button onClick={sendCode} className="px-3 py-2 bg-blue-600 text-white rounded text-sm">{t('popupAct_sendCode')}</button>}</div></div>}

        {status === 'error' && msg && (
          <div className="mt-2 text-sm text-red-600 text-center bg-red-50 p-2 rounded-lg">{msg}</div>
        )}
      </div>
    </div>
  )
}
