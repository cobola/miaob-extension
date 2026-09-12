import { useState, useEffect } from 'react'
import './index.css'
import { PopupActivation } from '../components/PopupActivation'
import { userService } from '../services/user.service'

// 获取扩展内资源的绝对 URL（popup 页面相对路径解析不同）
const assetUrl = (p: string) => chrome.runtime.getURL(p)

function App() {
  const [config, setConfig] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [userId, setUserId] = useState('')
  const [credits, setCredits] = useState(0)
  const [isActivated, setIsActivated] = useState(false)

  useEffect(() => {
    loadConfig()
    loadUser()
  }, [])

  const loadUser = () => {
    chrome.storage.local.get(['userId', 'credits', 'isActivated'], (result) => {
      if (result.userId) setUserId(result.userId as string)
      if (result.credits !== undefined) setCredits(result.credits as number)
      if (result.isActivated !== undefined) setIsActivated(result.isActivated as boolean)

      // 从服务端拉取最新积分（异步更新缓存）
      if (result.userId) {
        userService.getUserProfile(result.userId as string)
          .then(profile => {
            setCredits(profile.credits)
            chrome.storage.local.set({ credits: profile.credits })
          })
          .catch(() => {}) // 网络错误时保持缓存值
      }
    })
  }

  const handleActivated = (newCredits: number) => {
    setCredits(newCredits)
    setIsActivated(true)
    chrome.storage.local.set({ credits: newCredits, isActivated: true })
  }

  const loadConfig = async () => {
    chrome.storage.sync.get(['config'], (result) => {
      setConfig(result.config || getDefaultConfig())
      setLoading(false)
    })
  }

  const saveConfig = async (newConfig: any) => {
    chrome.storage.sync.set({ config: newConfig }, () => {
      setConfig(newConfig)
    })
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.id) {
        await chrome.tabs.sendMessage(tab.id, { type: 'CONFIG_UPDATED', data: newConfig })
      }
    } catch { /* tab 可能没有 content script */ }
  }

  const handleManualCheck = async () => {
    setChecking(true)
    try {
      await chrome.runtime.sendMessage({ type: 'CHECK_PAGE' })
    } catch (error) {
      console.error('检查失败:', error)
    } finally {
      setChecking(false)
    }
  }

  const handleClearMarks = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.id) {
        await chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_ALL_MARKS' })
      }
    } catch (error) {
      console.error('清除失败:', error)
    }
  }

  const getDefaultConfig = () => ({
    enabled: true,
    autoCheck: true,
    debounceMs: 800,
    minLength: 4,
    checkOnBlur: true,
  })

  if (loading) {
    return (
      <div className="popup-container">
        <div className="flex items-center justify-center h-48">
          <div className="animate-pulse text-gray-400">加载中...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="popup-container">
      {/* Header */}
      <div className="popup-header">
        <div className="flex items-center gap-3">
          <img src={assetUrl('src/assets/icons/icon128.png')} alt="妙笔" className="w-10 h-10 rounded-full" />
          <div>
            <h1 className="text-lg font-bold text-gray-900">妙笔</h1>
            <p className="text-xs text-gray-500">中文阅读伴侣</p>
          </div>
        </div>
        {userId && (
          <PopupActivation
            credits={credits}
            isActivated={isActivated}
            onActivated={handleActivated}
          />
        )}
      </div>

      {/* Actions */}
      <div className="popup-actions">
        <button
          onClick={handleManualCheck}
          disabled={checking}
          className="btn-primary"
        >
          {checking ? (
            <>
              <span className="spinner"></span>
              检查中...
            </>
          ) : (
            <>检查页面</>
          )}
        </button>
        <button onClick={handleClearMarks} className="btn-secondary">
          清除标注
        </button>
      </div>

      {/* Settings */}
      <div className="popup-settings">
        <Toggle
          label="启用检查"
          checked={config.enabled}
          onChange={(v) => saveConfig({ ...config, enabled: v })}
        />
        <Toggle
          label="自动检查"
          checked={config.autoCheck}
          onChange={(v) => saveConfig({ ...config, autoCheck: v })}
        />
        <Toggle
          label="失焦时检查"
          checked={config.checkOnBlur}
          onChange={(v) => saveConfig({ ...config, checkOnBlur: v })}
        />

      </div>

      {/* Footer */}
      <div className="popup-footer">
        <span>快捷键 Ctrl+Shift+E</span>
      </div>
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="toggle-row">
      <span>{label}</span>
      <button
        onClick={() => onChange(!checked)}
        className={`toggle-switch ${checked ? 'on' : ''}`}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  )
}

export default App
