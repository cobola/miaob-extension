import { useState, useEffect, useRef } from 'react'
import { userService } from '../services/user.service'

interface PopupActivationProps {
  userId: string
  credits: number
  isActivated: boolean
  onActivated: (newCredits: number) => void
}

type Status = 'idle' | 'starting' | 'pending' | 'scanned' | 'activating' | 'success' | 'error'

export function PopupActivation({ userId, credits, isActivated, onActivated }: PopupActivationProps) {
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const [qrUrl, setQrUrl] = useState('')
  const [msg, setMsg] = useState('')
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
      await userService.startActivation(userId)
      const qr = await userService.getWechatQrcode()
      setQrUrl(qr.qrcodeUrl)
      setStatus('pending')
      pollRef.current = setInterval(async () => {
        try {
          const st = await userService.getWechatStatus(qr.sessionId)
          if (st.ok && st.scanned && st.openid) {
            cleanup()
            setStatus('scanned')
            const login = await userService.wechatScanLogin(qr.sessionId)
            if (login.ok) {
              setStatus('activating')
              const result = await userService.completeActivation(userId, login.openid)
              if (result.ok) {
                setStatus('success')
                setMsg(`+100 积分`)
                onActivated(result.credits)
              }
            }
          }
        } catch (e) {
          cleanup()
          setStatus('error')
          setMsg(e instanceof Error ? e.message : '轮询扫码状态失败')
        }
      }, 1500)
    } catch (e) {
      setStatus('error')
      setMsg(e instanceof Error ? e.message : '获取二维码失败')
    }
  }

  const close = () => {
    cleanup()
    setExpanded(false)
    setStatus('idle')
    setQrUrl('')
  }

  // 已激活：header 内绿色徽章
  if (isActivated) {
    return (
      <div className="header-activation activated" title="已激活">
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
          <span className="text-sm font-semibold text-gray-800">微信扫码激活</span>
          <button onClick={close} className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">✕</button>
        </div>

        {!qrUrl && status === 'starting' && (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 border-2 border-gray-200 border-t-blue-500 rounded-full animate-spin" />
          </div>
        )}

        {qrUrl && (
          <div className="flex flex-col items-center gap-3">
            <img
              src={qrUrl}
              alt="微信扫码激活"
              className="w-40 h-40 rounded-xl border border-gray-100"
              onError={() => { setStatus('error'); setMsg('二维码加载失败') }}
            />
            <p className="text-sm text-gray-500 h-5">
              {status === 'pending' && '请使用微信扫码'}
              {status === 'scanned' && '扫码成功，登录中...'}
              {status === 'activating' && '正在激活...'}
              {status === 'success' && msg && <span className="text-green-600 font-medium">🎉 激活成功 {msg}</span>}
            </p>
          </div>
        )}

        {status === 'error' && msg && (
          <div className="mt-2 text-sm text-red-600 text-center bg-red-50 p-2 rounded-lg">{msg}</div>
        )}
      </div>
    </div>
  )
}
