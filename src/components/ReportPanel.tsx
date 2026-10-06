import { useState, useEffect, useCallback, useRef } from 'react'
import { ActivationPrompt } from './ActivationPrompt'
import '../styles/report-panel.css'
import { ShareModal } from './ShareModal'
import { expressionVoteService } from '../services/expression-vote.service'
import { userService } from '../services/user.service'
import { t } from '../lib/i18n'
import { localizeScript } from '../lib/script-conversion'
import type { VocabularyStats } from '../content/vocabulary-stats'

// 阅读难度文案（英文/中文随浏览器语言切换）
function readabilityLabel(level: VocabularyStats['readabilityLevel']): string {
  switch (level) {
    case 'smooth': return t('panel_readability_smooth')
    case 'comfortable': return t('panel_readability_comfortable')
    case 'someVocab': return t('panel_readability_someVocab')
    case 'manyNew': return t('panel_readability_manyNew')
  }
}

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

// 悬浮圆钮尺寸 / 边距（与 report-panel.css 保持一致）
const TOGGLE_SIZE = 56
const EDGE_MARGIN = 8
const PANEL_WIDTH = 400

/** 把圆钮限制在视口内，避免拖出屏幕后找不回来 */
function clampTogglePos(x: number, y: number) {
  const vw = window.innerWidth || document.documentElement.clientWidth
  const vh = window.innerHeight || document.documentElement.clientHeight
  return {
    x: Math.max(EDGE_MARGIN, Math.min(x, vw - TOGGLE_SIZE - EDGE_MARGIN)),
    y: Math.max(EDGE_MARGIN, Math.min(y, vh - TOGGLE_SIZE - EDGE_MARGIN)),
  }
}

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
  // 悬浮圆钮拖拽位置（null = 默认右下角）；位置记忆跨页面 / 刷新
  const [togglePos, setTogglePos] = useState<{ x: number; y: number } | null>(null)
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [isDragging, setIsDragging] = useState(false)
  const toggleRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null)
  const didDragRef = useRef(false)
  const latestPosRef = useRef<{ x: number; y: number } | null>(null)

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
    chrome.runtime.sendMessage({ type: 'CREATE_SHARE', data: { title: document.title || t('share_untitled'), url: location.href, author, favicon, items } }, (response) => { setSharing(false); if (response?.success && response.data?.shareUrl) setShareUrl(response.data.shareUrl); else alert(t('share_failed') + (response?.error || response?.data?.message || t('share_retry'))) })
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

  // 手机端（窄屏）：面板改为底部抽屉，且不再有发现就自动弹出来遮挡文章
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 640px)').matches : false,
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const onChange = () => setIsMobile(mq.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  // 有发现时自动打开面板（仅桌面端；手机端靠圆钮角标提示，点了才展开）
  useEffect(() => {
    if (isMobile) return
    if (idioms.length + quotes.length + xiehouyu.length + expressions.length > 0 && !isOpen) {
      const hasOpened = sessionStorage.getItem('miaob_panel_opened')
      if (!hasOpened) {
        setIsOpen(true)
        sessionStorage.setItem('miaob_panel_opened', 'true')
      }
    }
  }, [idioms.length, quotes.length, xiehouyu.length, expressions.length, isOpen, isMobile])

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

  // 读取上次拖拽位置
  useEffect(() => {
    try {
      chrome.storage?.local?.get?.(['miaobTogglePos'], (r) => {
        const p = r?.miaobTogglePos as { x?: number; y?: number } | undefined
        if (p && typeof p.x === 'number' && typeof p.y === 'number') {
          const c = clampTogglePos(p.x, p.y)
          latestPosRef.current = c
          setTogglePos(c)
        }
      })
    } catch { /* ignore */ }
  }, [])

  // 视口尺寸变化时把圆钮拉回可见范围
  useEffect(() => {
    const onResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight })
      setTogglePos((p) => {
        if (!p) return p
        const c = clampTogglePos(p.x, p.y)
        latestPosRef.current = c
        return c
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 悬浮圆钮拖拽：拖动超过阈值才算拖拽，否则仍视为点击开合面板
  const onTogglePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      originX: rect.left, originY: rect.top,
      moved: false,
    }
    didDragRef.current = false
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
  }

  const onTogglePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragStateRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return
      d.moved = true
      didDragRef.current = true
      setIsDragging(true)
    }
    if (e.cancelable) e.preventDefault()
    const next = clampTogglePos(d.originX + dx, d.originY + dy)
    latestPosRef.current = next
    // 直接改 DOM 样式，拖动过程不触发整块面板重渲染，保证顺滑
    const el = toggleRef.current
    if (el) {
      el.style.left = `${next.x}px`
      el.style.top = `${next.y}px`
      el.style.right = 'auto'
      el.style.bottom = 'auto'
    }
  }

  const endToggleDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragStateRef.current
    if (!d || d.pointerId !== e.pointerId) return
    dragStateRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    if (d.moved) {
      setIsDragging(false)
      const p = latestPosRef.current
      if (p) {
        setTogglePos(p)
        try { chrome.storage?.local?.set?.({ miaobTogglePos: p }) } catch { /* ignore */ }
      }
    }
  }

  const handleToggleClick = () => {
    if (didDragRef.current) { didDragRef.current = false; return }
    setIsOpen(!isOpen)
  }

  // 面板从右侧滑出时，若圆钮会被盖住就临时挪到面板左侧（不改记忆位置）
  const maxXForOpenPanel = Math.max(EDGE_MARGIN, viewport.w - PANEL_WIDTH - TOGGLE_SIZE - 12)
  // 手机端抽屉几乎全宽，圆钮没有地方可让，直接隐藏
  const effectiveTogglePos = togglePos
    ? { x: isOpen && !isMobile ? Math.min(togglePos.x, maxXForOpenPanel) : togglePos.x, y: togglePos.y }
    : null

  // 点条目：滚动定位到原文；手机端顺手收起点开的面板，露出文章
  const handleItemClick = (text: string, type: 'idiom' | 'quote' | 'xiehouyu' | 'expression', start?: number, end?: number) => {
    onItemClick?.(text, type, start, end)
    if (isMobile) setIsOpen(false)
  }

  // 移动端抽屉：向下拖拽把手关闭
  const sheetDragRef = useRef<{ pointerId: number; startY: number; moved: boolean } | null>(null)
  const onSheetHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    sheetDragRef.current = { pointerId: e.pointerId, startY: e.clientY, moved: false }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
  }
  const onSheetHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = sheetDragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    if (e.clientY - d.startY > 60) {
      d.moved = true
      setIsOpen(false)
      sheetDragRef.current = null
    }
  }
  const onSheetHandlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = sheetDragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    sheetDragRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  }

  const tabs = [
    { key: 'idiom' as const, label: t('panel_tabIdiom'), count: idioms.length, color: '#8C3D2B' },
    { key: 'quote' as const, label: t('panel_tabQuote'), count: quotes.length, color: '#10b981' },
    { key: 'xiehouyu' as const, label: t('panel_tabXiehouyu'), count: xiehouyu.length, color: '#f59e0b' },
    { key: 'expression' as const, label: t('panel_tabExpression'), count: expressions.length, color: '#06b6d4' },
  ]

  return (
    <>
      <div
        ref={toggleRef}
        className={`miaob-panel-toggle ${isOpen ? 'open' : ''} ${isDragging ? 'dragging' : ''}`}
        style={effectiveTogglePos ? { left: effectiveTogglePos.x, top: effectiveTogglePos.y, right: 'auto', bottom: 'auto' } : undefined}
        onPointerDown={onTogglePointerDown}
        onPointerMove={onTogglePointerMove}
        onPointerUp={endToggleDrag}
        onPointerCancel={endToggleDrag}
        onClick={handleToggleClick}
        hidden={isMobile && isOpen}
      >
        <span className="icon">📝</span>
        {totalFindings > 0 && <span className="badge">{totalFindings}</span>}
      </div>

      {/* 手机端：抽屉下拉时点遮罩关闭 */}
      <div className={`miaob-panel-overlay ${isOpen && isMobile ? 'open' : ''}`} onClick={() => setIsOpen(false)} />

      <div className={`miaob-panel ${isOpen ? 'open' : ''}`}>
        <div
          className="panel-sheet-handle"
          onPointerDown={onSheetHandlePointerDown}
          onPointerMove={onSheetHandlePointerMove}
          onPointerUp={onSheetHandlePointerUp}
          onPointerCancel={onSheetHandlePointerUp}
        >
          <span className="panel-sheet-handle-bar" />
        </div>
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
              <div className="vocabulary-readability-label"><span>{t('panel_readingLevel')}</span><b>{readabilityLabel(vocabularyStats.readabilityLevel)}</b><small>{t('panel_levelHint')}</small></div>
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
                  <div key={idx} className="report-item idiom-item" onClick={() => handleItemClick(i.idiom, 'idiom')}>
                      <span className="report-tag tag-idiom">{t('panel_tabIdiom')}</span>
                      <div className="report-content">
                        <span className="report-text">{i.idiom}</span>
                        {i.explanation && <span className="report-note">{localizeScript(i.explanation).slice(0, 42)}</span>}
                        {!i.explanation && i.derivation && <span className="report-note">{localizeScript(i.derivation).slice(0, 30)}</span>}
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
                  <div key={idx} className="report-item quote-item" onClick={() => handleItemClick(q.text, 'quote')}>
                    <span className="report-tag tag-quote">{t('panel_tabQuote')}</span>
                    <div className="report-content">
                      <span className="report-text">{q.text}</span>
                      {q.from && <span className="report-note"> — {localizeScript(q.from)}</span>}
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
                  <div key={idx} className="report-item xiehouyu-item" onClick={() => handleItemClick(x.text, 'xiehouyu')}>
                    <span className="report-tag tag-xiehouyu">{t('panel_tabXiehouyu')}</span>
                    <div className="report-content">
                      <span className="report-text">{x.text}</span>
                      {x.answer && <span className="report-note"> — {localizeScript(x.answer)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
          {activeTab === 'expression' && (
            <div className="report-list">
              {expressions.map((e, idx) => (
                <div key={idx} className="report-item expression-item" onClick={() => handleItemClick(e.text, 'expression')}>
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
