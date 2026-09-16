import { useState, useEffect, useCallback } from 'react'
import { ActivationPrompt } from './ActivationPrompt'
import '../styles/report-panel.css'
import { ShareModal } from './ShareModal'
import { expressionVoteService } from '../services/expression-vote.service'
import { userService } from '../services/user.service'
import { t } from '../lib/i18n'
import type { VocabularyStats } from '../content/vocabulary-stats'

// 同步简单 hash（用于本地状态追踪，避免异步阻塞按钮）
function simpleHash(str: string): string {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0
  }
  return h.toString(16)
}

interface IdiomEntry { idiom: string; derivation?: string; explanation?: string }
interface QuoteEntry { text: string; from?: string }
interface XiehouyuEntry { text: string; answer?: string }
interface ExpressionEntry { type: string; text: string; score?: number }
interface QuotaStatus { remaining: number; isPaid: boolean; used: number; limit: number }
interface ReportPanelProps {
  idioms?: IdiomEntry[]
  quotes?: QuoteEntry[]
  xiehouyu?: XiehouyuEntry[]
  expressions?: ExpressionEntry[]
  quota?: QuotaStatus
  vocabularyStats?: VocabularyStats
  onItemClick?: (text: string, type: 'idiom' | 'quote' | 'xiehouyu' | 'expression', start?: number, end?: number) => void
}

const expressionLabels: Record<string, string> = { golden_sentence: t('ct_exprGolden'), parallelism: t('ct_exprParallelism'), contrast: t('ct_exprContrast'), rhetorical_question: t('ct_exprRhetorical'), numeric_impact: t('ct_exprNumeric'), metaphor: t('ct_exprMetaphor'), citation: t('ct_exprCitation') }

export function ReportPanel({ idioms = [], quotes = [], xiehouyu = [], expressions = [], quota, vocabularyStats, onItemClick }: ReportPanelProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [credits, setCredits] = useState(0)
  const [userId, setUserId] = useState('')
  const [userName, setUserName] = useState('')
  const [isActivated, setIsActivated] = useState(false)
  const [activeTab, setActiveTab] = useState<'idiom' | 'quote' | 'xiehouyu' | 'expression'>('idiom')
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  // 表达高光投票状态：hash → { hasVoted, totalVotes, approved }
  const [voteStatusMap, setVoteStatusMap] = useState<Record<string, { hasVoted: boolean; totalVotes: number; approved: boolean }>>({})
  const [voteLoading, setVoteLoading] = useState<Record<string, boolean>>({})
  // 预计算的 expression hash 列表（与 expressions 一一对应）
  const [exprHashes, setExprHashes] = useState<string[]>([])

  const handleShare = () => {
    setSharing(true)
    const author = document.querySelector('meta[name="author"]')?.getAttribute('content') || ''
    const favicon = (document.querySelector('link[rel*="icon"]') as HTMLLinkElement | null)?.href || ''
    const bodyText = document.body.innerText || ''
    const context = (text: string) => { const i = bodyText.indexOf(text); if (i < 0) return text; const s = Math.max(0, i - 30), e = Math.min(bodyText.length, i + text.length + 30); return (s ? '...' : '') + bodyText.slice(s, e).trim() + (e < bodyText.length ? '...' : '') }
    const items = [
      ...idioms.map(i => ({ type: 'idiom', text: i.idiom, context: context(i.idiom), explanation: i.explanation || '', derivation: i.derivation || '' })),
      ...quotes.map(i => ({ type: 'quote', text: i.text, context: context(i.text), from: i.from || '' })),
      ...xiehouyu.map(i => ({ type: 'xiehouyu', text: i.text, context: context(i.text), answer: i.answer || '' })),
      ...expressions.map(i => ({ type: i.type, text: i.text, context: context(i.text), score: i.score })),
    ]
    chrome.runtime.sendMessage({ type: 'CREATE_SHARE', data: { title: document.title || '未命名文章', url: location.href, author, favicon, items } }, (response) => { setSharing(false); if (response?.success && response.data?.shareUrl) setShareUrl(response.data.shareUrl); else alert('分享失败：' + (response?.error || response?.data?.message || '请稍后重试')) })
  }

  // 初始加载用户数据（只执行一次）
  useEffect(() => {
    chrome.storage.local.get(['userId', 'credits', 'isActivated', 'userName'], (result) => {
      if (result.userId) setUserId(result.userId as string)
      if (result.userName) setUserName(result.userName as string)
      if (result.credits !== undefined) setCredits(result.credits as number)
      if (result.isActivated !== undefined) setIsActivated(result.isActivated as boolean)
      if (result.userId) userService.getUserProfile(result.userId as string).then(profile => {
        if (profile.name) { setUserName(profile.name); chrome.storage.local.set({ userName: profile.name }) }
        setCredits(profile.credits); chrome.storage.local.set({ credits: profile.credits })
      }).catch(() => {})
    })

    const handleStorageChange = (changes: { credits?: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === 'local' && changes.credits?.newValue !== undefined) {
        setCredits(changes.credits.newValue as number)
      }
    }

    chrome.storage.onChanged.addListener(handleStorageChange)
    return () => chrome.storage.onChanged.removeListener(handleStorageChange)
  }, [])

  // 同步计算 hash（立即生效，不阻塞按钮）
  useEffect(() => {
    if (expressions.length === 0) {
      setExprHashes([])
      return
    }
    setExprHashes(expressions.map(e => simpleHash(e.text)))
  }, [expressions])

  // 加载投票状态（优先用本地缓存，再请求服务端）
  useEffect(() => {
    if (exprHashes.length === 0) return
    let cancelled = false
    const load = async () => {
      // 先加载本地缓存（立即反映已投票状态）
      await expressionVoteService.loadCache()
      if (cancelled) return
      // 用缓存初始化投票状态
      const cached: Record<string, { hasVoted: boolean; totalVotes: number; approved: boolean }> = {}
      for (const h of exprHashes) {
        if (expressionVoteService.hasVotedLocal(h)) {
          cached[h] = { hasVoted: true, totalVotes: 0, approved: false }
        }
      }
      if (Object.keys(cached).length > 0) setVoteStatusMap(cached)
      // 再请求服务端获取最新状态
      try {
        const status = await expressionVoteService.getStatus(exprHashes)
        if (!cancelled) setVoteStatusMap(status)
      } catch {
        // 忽略投票状态加载失败
      }
    }
    load()
    return () => { cancelled = true }
  }, [exprHashes])

  const handleVote = useCallback(async (hash: string, text: string, type: string) => {
    console.log('[Miaob] handleVote 调用', hash, text.slice(0, 20))
    const current = voteStatusMap[hash]
    if (current?.hasVoted) {
      console.log('[Miaob] 已投票，跳过')
      return
    }
    setVoteLoading(prev => ({ ...prev, [hash]: true }))
    try {
      const result = await expressionVoteService.vote({
        expressionHash: hash,
        text,
        type,
        sourceUrl: location.href,
        vote: true,
      })
      setVoteStatusMap(prev => {
        const next = { ...prev, [hash]: { hasVoted: result.voted, totalVotes: result.totalVotes, approved: result.approved } }
        console.log('[Miaob] 状态更新', hash, next[hash])
        return next
      })
    } catch (e) {
      console.error('[Miaob] 投票失败', e)
    } finally {
      setVoteLoading(prev => ({ ...prev, [hash]: false }))
    }
  }, [voteStatusMap])

  // 有发现时自动打开面板
  useEffect(() => {
    if (idioms.length + quotes.length + xiehouyu.length + expressions.length > 0 && !isOpen) {
      const hasOpened = sessionStorage.getItem('miaob_panel_opened')
      if (!hasOpened) {
        setIsOpen(true)
        sessionStorage.setItem('miaob_panel_opened', 'true')
      }
    }
  }, [idioms.length, quotes.length, xiehouyu.length, expressions.length, isOpen])

  const handleActivation = () => {
    setIsActivated(true)
    chrome.storage.local.set({ isActivated: true })
    chrome.storage.local.get(['credits'], (result) => {
      if (result.credits !== undefined) setCredits(result.credits as number)
    })
  }

  const totalFindings = idioms.length + quotes.length + xiehouyu.length + expressions.length

  const handleOpenMiaoben = () => {
    window.open('https://miaob.net/miaoben', '_blank', 'noopener,noreferrer')
  }

  useEffect(() => {
    if (idioms.length > 0) setActiveTab('idiom')
    else if (quotes.length > 0) setActiveTab('quote')
    else if (xiehouyu.length > 0) setActiveTab('xiehouyu')
    else if (expressions.length > 0) setActiveTab('expression')
  }, [idioms.length, quotes.length, xiehouyu.length, expressions.length])

  const tabs = [
    { key: 'idiom' as const, label: t('panel_tabIdiom'), count: idioms.length, color: '#8C3D2B' },
    { key: 'quote' as const, label: t('panel_tabQuote'), count: quotes.length, color: '#10b981' },
    { key: 'xiehouyu' as const, label: t('panel_tabXiehouyu'), count: xiehouyu.length, color: '#f59e0b' },
    { key: 'expression' as const, label: t('panel_tabExpression'), count: expressions.length, color: '#06b6d4' },
  ]

  return (
    <>
      <div className={`miaob-panel-toggle ${isOpen ? 'open' : ''}`} onClick={() => setIsOpen(!isOpen)}>
        <span className="icon">📝</span>
        {totalFindings > 0 && <span className="badge">{totalFindings}</span>}
      </div>

      <div className={`miaob-panel ${isOpen ? 'open' : ''}`}>
        <div className="panel-header">
          <div className="panel-heading">
            <h3>{t('panel_welcome', userName || t('panel_friend'))}</h3>
            <div className="panel-user-meta">{userId && <span className="user-id" title={userId}>{t('panel_idPrefix', userId.slice(0, 8))}</span>}<span className="header-credits">{t('panel_credits', credits)}</span></div>
          </div>
          <div className="header-actions">
            <button className="miaoben-btn" onClick={handleOpenMiaoben}>{t('panel_miaoben')}</button>
            <button className="close-btn" onClick={() => setIsOpen(false)}>✕</button>
          </div>
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
          {quota && !quota.isPaid && quota.remaining <= 3 && <div className="quota-notice">{t('panel_quotaNotice', quota.remaining)}</div>}
          {vocabularyStats && vocabularyStats.totalChineseChars > 0 && (
            <div className="vocabulary-stats" aria-label={t('panel_vocabAria')}>
              <div className="vocabulary-heading"><span className="vocabulary-kicker">{t('panel_vocabKicker')}</span></div>
              <div className="vocabulary-metrics">
                <div><strong>{vocabularyStats.totalChineseChars.toLocaleString()}</strong><span>{t('panel_vocabChars')}</span></div>
                <div><strong>{vocabularyStats.uniqueChineseChars.toLocaleString()}</strong><span>{t('panel_vocabUnique')}</span></div>
                <div><strong>{vocabularyStats.uniqueWords.toLocaleString()}</strong><span>{t('panel_vocabWords')}</span></div>
              </div>
              <div className="vocabulary-readability-label"><span>{t('panel_readingLevel')}</span><b>{vocabularyStats.readability}</b><small>{t('panel_levelHint')}</small></div>
              <div className="vocabulary-readability"><div><span className="easy-dot" />{t('panel_easyChars')} <b>{vocabularyStats.easyChars}</b><small>{vocabularyStats.easyPercent}%</small></div><div><span className="difficult-dot" />{t('panel_maybeNewChars')} <b>{vocabularyStats.difficultChars}</b><small>{100 - vocabularyStats.easyPercent}%</small></div></div>
              <div className="vocabulary-track vocabulary-readability-track" aria-label={t('panel_trackAria', vocabularyStats.easyPercent, 100 - vocabularyStats.easyPercent)}><i style={{ width: `${vocabularyStats.easyPercent}%` }} /><b style={{ width: `${100 - vocabularyStats.easyPercent}%` }} /></div>
            </div>
          )}
          {activeTab === 'idiom' && (
            idioms.length === 0 ? (
              <div className="empty-state"><p>{t('panel_emptyIdioms')}</p></div>
            ) : (
              <div className="report-list">
                {idioms.map((i, idx) => (
                  <div key={idx} className="report-item idiom-item" onClick={() => onItemClick?.(i.idiom, 'idiom')}>
                      <span className="report-tag tag-idiom">{t('panel_tabIdiom')}</span>
                      <div className="report-content">
                        <span className="report-text">{i.idiom}</span>
                        {i.explanation && <span className="report-note">{i.explanation.slice(0, 42)}</span>}
                        {!i.explanation && i.derivation && <span className="report-note">{i.derivation.slice(0, 30)}</span>}
                      </div>
                  </div>
                ))}
              </div>
            )
          )}
          {activeTab === 'quote' && (
            quotes.length === 0 ? (
              <div className="empty-state"><p>{t('panel_emptyQuotes')}</p></div>
            ) : (
              <div className="report-list">
                {quotes.map((q, idx) => (
                  <div key={idx} className="report-item quote-item" onClick={() => onItemClick?.(q.text, 'quote')}>
                    <span className="report-tag tag-quote">{t('panel_tabQuote')}</span>
                    <div className="report-content">
                      <span className="report-text">{q.text}</span>
                      {q.from && <span className="report-note"> — {q.from}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
          {activeTab === 'xiehouyu' && (
            xiehouyu.length === 0 ? (
              <div className="empty-state"><p>{t('panel_emptyXiehouyu')}</p></div>
            ) : (
              <div className="report-list">
                {xiehouyu.map((x, idx) => (
                  <div key={idx} className="report-item xiehouyu-item" onClick={() => onItemClick?.(x.text, 'xiehouyu')}>
                    <span className="report-tag tag-xiehouyu">{t('panel_tabXiehouyu')}</span>
                    <div className="report-content">
                      <span className="report-text">{x.text}</span>
                      {x.answer && <span className="report-note"> — {x.answer}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
          {activeTab === 'expression' && (
            <div className="report-list">
              {expressions.map((e, idx) => (
                <div key={idx} className="report-item expression-item" onClick={() => onItemClick?.(e.text, 'expression')}>
                  <div className="expression-sidebar">
                    <span className="report-tag tag-expression">{expressionLabels[e.type] || t('ct_exprHighlight')}</span>
                    <div className="vote-actions">
                      <button
                        className={`vote-btn${voteStatusMap[exprHashes[idx]]?.hasVoted ? ' voted' : ''}`}
                        onClick={(ev) => { ev.stopPropagation(); handleVote(exprHashes[idx] || simpleHash(e.text), e.text, e.type) }}
                        disabled={voteLoading[exprHashes[idx]] || voteStatusMap[exprHashes[idx]]?.hasVoted}
                        title={t('panel_voteUp')}
                      >
                        {(() => { const s = voteStatusMap[exprHashes[idx]]; console.log('[Miaob] 渲染按钮', idx, exprHashes[idx], s?.hasVoted, s?.totalVotes); return s?.hasVoted ? <span className="vote-count">{s.totalVotes}</span> : '👍'; })()}
                      </button>
                    </div>
                  </div>
                  <div className="report-content"><span className="report-text">{e.text}</span></div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel-footer">
          {totalFindings > 0 && <button className="share-btn" onClick={handleShare} disabled={sharing}>{sharing ? t('panel_generating') : t('panel_share')}</button>}
          {!isActivated && <ActivationPrompt onActivated={handleActivation} />}
        </div>
      </div>
      {shareUrl && <ShareModal url={shareUrl} onClose={() => setShareUrl(null)} />}
    </>
  )
}
