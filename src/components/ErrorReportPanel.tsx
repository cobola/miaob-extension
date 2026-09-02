import { useState, useEffect } from 'react'
import { TextError } from '../shared/types'
import { ErrorItem } from './ErrorItem'
import { CreditsDisplay } from './CreditsDisplay'
import { ActivationPrompt } from './ActivationPrompt'
import '../styles/error-panel.css'

interface IdiomEntry { idiom: string; derivation?: string; explanation?: string }
interface QuoteEntry { text: string; from?: string }
interface XiehouyuEntry { text: string; answer?: string }

interface ErrorReportPanelProps {
  errors: TextError[]
  idioms?: IdiomEntry[]
  quotes?: QuoteEntry[]
  xiehouyu?: XiehouyuEntry[]
  onFeedback: (error: TextError, isCorrect: boolean) => void
  onErrorClick: (error: TextError) => void
  onItemClick?: (text: string, type: 'idiom' | 'quote' | 'xiehouyu') => void
}

export function ErrorReportPanel({ errors, idioms = [], quotes = [], xiehouyu = [], onFeedback, onErrorClick, onItemClick }: ErrorReportPanelProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [credits, setCredits] = useState(0)
  const [userId, setUserId] = useState('')
  const [isActivated, setIsActivated] = useState(false)
  const [activeTab, setActiveTab] = useState<'error' | 'idiom' | 'quote' | 'xiehouyu'>('error')

  useEffect(() => {
    chrome.storage.local.get(['userId', 'credits', 'isActivated'], (result) => {
      if (result.userId) setUserId(result.userId as string)
      if (result.credits !== undefined) setCredits(result.credits as number)
      if (result.isActivated !== undefined) setIsActivated(result.isActivated as boolean)
    })

    if (errors.length > 0 && !isOpen) {
      const hasOpened = sessionStorage.getItem('miaob_panel_opened')
      if (!hasOpened) {
        setIsOpen(true)
        sessionStorage.setItem('miaob_panel_opened', 'true')
      }
    }
  }, [errors.length])

  const handleFeedback = async (error: TextError, isCorrect: boolean) => {
    await onFeedback(error, isCorrect)
    const points = isCorrect ? 2 : 5
    const newCredits = credits + points
    setCredits(newCredits)
    chrome.storage.local.set({ credits: newCredits })
  }

  const handleActivation = () => {
    setIsActivated(true)
    chrome.storage.local.set({ isActivated: true })
    chrome.storage.local.get(['credits'], (result) => {
      if (result.credits !== undefined) setCredits(result.credits as number)
    })
  }

  const totalFindings = errors.length + idioms.length + quotes.length + xiehouyu.length

  useEffect(() => {
    if (errors.length > 0) setActiveTab('error')
    else if (idioms.length > 0) setActiveTab('idiom')
    else if (quotes.length > 0) setActiveTab('quote')
    else if (xiehouyu.length > 0) setActiveTab('xiehouyu')
  }, [errors.length, idioms.length, quotes.length, xiehouyu.length])

  const tabs = [
    { key: 'error' as const, label: '错误', count: errors.length, color: '#ef4444' },
    { key: 'idiom' as const, label: '成语', count: idioms.length, color: '#8b5cf6' },
    { key: 'quote' as const, label: '名句', count: quotes.length, color: '#10b981' },
    { key: 'xiehouyu' as const, label: '歇后语', count: xiehouyu.length, color: '#f59e0b' },
  ]

  return (
    <>
      <div className={`miaob-panel-toggle ${isOpen ? 'open' : ''}`} onClick={() => setIsOpen(!isOpen)}>
        <span className="icon">📝</span>
        {totalFindings > 0 && <span className="badge">{totalFindings}</span>}
      </div>

      <div className={`miaob-panel ${isOpen ? 'open' : ''}`}>
        <div className="panel-header">
          <h3>阅读报告（{totalFindings}）</h3>
          <button className="close-btn" onClick={() => setIsOpen(false)}>✕</button>
        </div>

        <div className="panel-tabs">
          {tabs.map(tab => tab.count > 0 && (
            <button
              key={tab.key}
              className={`panel-tab ${activeTab === tab.key ? 'active' : ''}`}
              style={{ '--tab-color': tab.color } as React.CSSProperties}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label} {tab.count}
            </button>
          ))}
        </div>

        <div className="panel-content">
          {activeTab === 'error' && (
            errors.length === 0 ? (
              <div className="empty-state"><p>暂无检测到的问题</p></div>
            ) : (
              <div className="error-list">
                {errors.map((error, index) => (
                  <ErrorItem
                    key={`${error.start}-${error.end}-${index}`}
                    error={error}
                    onFeedback={handleFeedback}
                    onClick={() => onErrorClick(error)}
                  />
                ))}
              </div>
            )
          )}
          {activeTab === 'idiom' && (
            idioms.length === 0 ? (
              <div className="empty-state"><p>暂无成语</p></div>
            ) : (
              <div className="error-list">
                {idioms.map((i, idx) => (
                  <div key={idx} className="error-item idiom-item" onClick={() => onItemClick?.(i.idiom, 'idiom')}>
                    <span className="error-type type-idiom">成语</span>
                    <div className="error-text">
                      <span className="original">{i.idiom}</span>
                      {i.derivation && <span className="suggestion"> — {i.derivation.slice(0, 30)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
          {activeTab === 'quote' && (
            quotes.length === 0 ? (
              <div className="empty-state"><p>暂无名句</p></div>
            ) : (
              <div className="error-list">
                {quotes.map((q, idx) => (
                  <div key={idx} className="error-item quote-item" onClick={() => onItemClick?.(q.text, 'quote')}>
                    <span className="error-type type-quote">名句</span>
                    <div className="error-text">
                      <span className="original">{q.text}</span>
                      {q.from && <span className="suggestion"> — {q.from}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
          {activeTab === 'xiehouyu' && (
            xiehouyu.length === 0 ? (
              <div className="empty-state"><p>暂无歇后语</p></div>
            ) : (
              <div className="error-list">
                {xiehouyu.map((x, idx) => (
                  <div key={idx} className="error-item xiehouyu-item" onClick={() => onItemClick?.(x.text, 'xiehouyu')}>
                    <span className="error-type type-xiehouyu">歇后语</span>
                    <div className="error-text">
                      <span className="original">{x.text}</span>
                      {x.answer && <span className="suggestion"> — {x.answer}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>

        <div className="panel-footer">
          <CreditsDisplay credits={credits} />
          {!isActivated && <ActivationPrompt userId={userId} onActivated={handleActivation} />}
        </div>
      </div>
    </>
  )
}
