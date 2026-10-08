import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { ArchivePlayer } from './ArchivePlayer.jsx';
import { TitleHistory } from './TitleHistory.jsx';
import { ListVideo, Scissors } from 'lucide-react';
import { playerTexts } from './texts.js';
import { timeLabel } from './timeline.js';
import './player.css';
import './chapters.css';
import './workspace.css';

const labels = {
  de: { loading: 'VOD wird geöffnet …', failed: 'Das VOD konnte nicht geladen werden. Schnittzeiten können weiterhin eingegeben werden.', retry: 'Erneut laden', range: 'Schnittbereich', start: 'Start', end: 'Ende', markStart: 'Start hier setzen', markEnd: 'Ende hier setzen', playRange: 'Auswahl abspielen', stopRange: 'Auswahl anhalten', full: 'Gesamtes VOD wählen', source: 'Streamqualität', keyboard: 'Leertaste / K: Wiedergabe · ← / →: 10 Sekunden · I / O: Schnittmarken · F: Vollbild', active: 'Auswahl wird abgespielt', sourceBest: 'Beste verfügbare Qualität' },
  en: { loading: 'Opening VOD …', failed: 'Could not load the VOD. You can still enter cut times.', retry: 'Retry', range: 'Selected range', start: 'Start', end: 'End', markStart: 'Set start here', markEnd: 'Set end here', playRange: 'Play selection', stopRange: 'Pause selection', full: 'Select entire VOD', source: 'Stream quality', keyboard: 'Space / K: playback · ← / →: 10 seconds · I / O: cut markers · F: fullscreen', active: 'Playing selection', sourceBest: 'Best available quality' },
};

function SelectionTimeline({ duration, range, position, onChange, onSeek, text }) {
  const track = useRef(null);
  const dragging = useRef(null);
  function valueAt(event) {
    const bounds = track.current.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(duration, (event.clientX - bounds.left) / bounds.width * duration)) * 10) / 10;
  }
  function set(which, value) {
    onChange(which === 'start' ? Math.max(0, Math.min(value, range.end - .1)) : range.start,
      which === 'end' ? Math.min(duration, Math.max(value, range.start + .1)) : range.end);
  }
  return <div className="vod-selection">
    <div className="vod-selection-heading"><strong>{text.range}</strong><span>{timeLabel(Math.max(0, range.end - range.start))}</span></div>
    <div ref={track} className="vod-selection-track" onClick={event => { if (event.target === event.currentTarget) onSeek(valueAt(event)); }}>
      <div className="vod-selection-band" style={{ left: `${range.start / duration * 100}%`, width: `${(range.end - range.start) / duration * 100}%` }}/>
      <i className="vod-selection-playhead" style={{ left: `${Math.min(1, position / duration) * 100}%` }}/>
      {['start', 'end'].map(which => <button key={which} type="button" className={`vod-selection-handle is-${which}`} role="slider" aria-label={text[which]}
        aria-valuemin={which === 'start' ? 0 : range.start + .1} aria-valuemax={which === 'start' ? range.end - .1 : duration}
        aria-valuenow={range[which]} aria-valuetext={timeLabel(range[which])} style={{ left: `${range[which] / duration * 100}%` }}
        onPointerDown={event => { if (event.button !== 0) return; dragging.current = { which, id: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (dragging.current?.id === event.pointerId) set(which, valueAt(event)); }}
        onPointerUp={() => { dragging.current = null; }} onPointerCancel={() => { dragging.current = null; }} onLostPointerCapture={() => { dragging.current = null; }}
        onKeyDown={event => {
          const step = event.shiftKey ? 10 : .1;
          const delta = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[event.key];
          if (delta !== undefined) { event.preventDefault(); set(which, Math.round((range[which] + delta) * 10) / 10); }
          if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); set(which, event.key === 'Home' ? 0 : duration); }
        }}><span>{which === 'start' ? 'I' : 'O'}</span></button>)}
    </div>
    <div className="vod-selection-labels"><span>00:00:00</span><span>{timeLabel(duration)}</span></div>
  </div>;
}

function Workspace({ options, bind }) {
  const language = options.language === 'en' ? 'en' : 'de';
  const text = labels[language];
  const t = useCallback(key => playerTexts[language][key] || key, [language]);
  const [metadata, setMetadata] = useState(null), [metadataState, setMetadataState] = useState('loading'), [historyAttempt, setHistoryAttempt] = useState(0);
  const [sidebarTab, setSidebarTab] = useState('history'), [chapterPreview, setChapterPreview] = useState(null);
  const [hoveredChapter, setHoveredChapter] = useState(null), [focusedChapter, setFocusedChapter] = useState(null);
  const [session, setSession] = useState(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const [duration, setDuration] = useState(options.duration), [position, setPosition] = useState(0);
  const [range, setRange] = useState({ start: options.start, end: options.end });
  const [seekRequest, setSeekRequest] = useState(null), [selectionPlaying, setSelectionPlaying] = useState(false);
  const host = useRef(null), rangeRef = useRef(range), selectedPlayback = useRef(false);
  rangeRef.current = range;
  const requestId = useMemo(() => crypto.randomUUID(), [options.url, attempt]);
  const started = metadata?.started ?? Date.parse(options.date);
  const parts = useMemo(() => [{ id: options.url, url: session?.sourceUrl, duration, started }], [session, duration, options.url, started]);
  const chapters = useMemo(() => (metadata?.chapters || []).map(chapter => ({ ...chapter, end: Math.min(duration, chapter.end) })).filter(chapter => chapter.end > chapter.start), [metadata, duration]);
  useEffect(() => {
    document.getElementById('clipHistoryPanel').hidden = sidebarTab !== 'history';
    document.getElementById('clipCutPanel').hidden = sidebarTab !== 'cut';
    setHoveredChapter(null); setFocusedChapter(null);
  }, [sidebarTab]);
  useEffect(() => {
    setChapterPreview(sidebarTab === 'history' && (hoveredChapter || focusedChapter) ? { recordingId: options.url, chapterId: hoveredChapter || focusedChapter } : null);
  }, [sidebarTab, hoveredChapter, focusedChapter, options.url]);
  const changeRange = useCallback((start, end) => {
    selectedPlayback.current = false; setSelectionPlaying(false);
    setRange({ start, end }); options.onRange(start, end);
  }, [options]);
  const seek = useCallback(seconds => { setSeekRequest({ seconds }); }, []);
  bind.current = { updateRange(start, end) { setRange({ start, end }); selectedPlayback.current = false; setSelectionPlaying(false); }, seek };
  useEffect(() => {
    const id = requestId;
    let closed = false;
    setSession(null); setError(false);
    window.api.openVodPlayback({ id, url: options.url }).then(result => {
      if (closed) return;
      if (result) setSession(result);
      else setError(true);
    }).catch(() => { if (!closed) setError(true); });
    return () => { closed = true; void window.api.closeVodPlayback(id).catch(() => undefined); };
  }, [options.url, requestId]);
  useEffect(() => {
    let closed = false;
    setMetadataState('loading');
    window.api.getVodTimeline({ id: requestId, url: options.url }).then(result => {
      if (closed) return;
      setMetadata(result); setMetadataState(result ? 'ready' : 'error');
    }).catch(() => { if (!closed) setMetadataState('error'); });
    return () => { closed = true; };
  }, [options.url, requestId, historyAttempt]);
  const onTimeline = useCallback(timeline => {
    const total = timeline.reduce((sum, part) => sum + part.duration, 0);
    if (total > 0 && Math.abs(total - duration) > .05) {
      setDuration(total); options.onDuration(total);
      const start = Math.min(rangeRef.current.start, Math.max(0, total - .1));
      const end = Math.min(total, Math.max(start + .1, rangeRef.current.end));
      setRange({ start, end }); options.onRange(start, end);
    }
  }, [duration, options]);
  const onPosition = useCallback(seconds => {
    setPosition(seconds);
    if (selectedPlayback.current && seconds >= rangeRef.current.end) {
      selectedPlayback.current = false; setSelectionPlaying(false);
      host.current?.querySelector('video.active')?.pause();
    }
  }, []);
  function mark(which) {
    const value = Math.min(duration, Math.max(0, Math.round(position * 10) / 10));
    changeRange(which === 'start' ? Math.min(value, range.end - .1) : range.start,
      which === 'end' ? Math.max(value, range.start + .1) : range.end);
  }
  function playRange() {
    const video = host.current?.querySelector('video.active');
    if (selectionPlaying) { selectedPlayback.current = false; setSelectionPlaying(false); video?.pause(); return; }
    selectedPlayback.current = true; setSelectionPlaying(true);
    seek(range.start);
    void video?.play().catch(() => undefined);
  }
  return <div ref={host} className="vod-player-workspace" onKeyDown={event => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.target.closest('input, textarea, button, [contenteditable="true"]')) return;
    if (event.key.toLowerCase() === 'i' || event.key.toLowerCase() === 'o') { event.preventDefault(); mark(event.key.toLowerCase() === 'i' ? 'start' : 'end'); }
  }}>
    {session ? <ArchivePlayer key={session.id} id={options.url} userId="tvm-local" parts={parts} seconds={range.start}
      broadcastStarted={started} started t={t} chapters={chapters} titleHistory={metadata?.titleHistory || []} vodTitle={metadata?.title || options.title} chapterPreview={chapterPreview} onProgress={() => {}} onError={() => setError(true)}
      onPosition={onPosition} onTimeline={onTimeline} seekRequest={seekRequest}/>
      : !error && <div className="vod-player-loading" role="status"><span className="vod-loading-symbol"/>{text.loading}</div>}
    {error && <div className="vod-player-error" role="status"><span>{text.failed}</span><button type="button" className="btn-secondary" onClick={() => setAttempt(value => value + 1)}>{text.retry}</button></div>}
    <div className="vod-player-source"><span>{text.source}: {session?.quality === 'best' ? text.sourceBest : session?.quality || '…'}</span>{selectionPlaying && <span>{text.active}</span>}</div>
    {createPortal(<div className="vod-sidebar-tabs" role="tablist" aria-label={t('vodWorkspaceTools')} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'history' : event.key === 'End' ? 'cut' : sidebarTab === 'history' ? 'cut' : 'history';
      setSidebarTab(next); document.getElementById(next === 'history' ? 'clipHistoryTab' : 'clipCutTab').focus();
    }}>
      <button id="clipHistoryTab" role="tab" aria-selected={sidebarTab === 'history'} aria-controls="clipHistoryPanel" tabIndex={sidebarTab === 'history' ? 0 : -1} onClick={() => setSidebarTab('history')}><ListVideo size={17}/>{t('streamHistory')}</button>
      <button id="clipCutTab" role="tab" aria-selected={sidebarTab === 'cut'} aria-controls="clipCutPanel" tabIndex={sidebarTab === 'cut' ? 0 : -1} onClick={() => setSidebarTab('cut')}><Scissors size={17}/>{text.range}</button>
    </div>, document.getElementById('clipSidebarTabs'))}
    {createPortal(<div className="vod-history">
      <div className="vod-history-heading"><span>{t('vodTitle')}</span><strong>{metadata?.title || options.title}</strong></div>
      {metadataState === 'loading' && <p className="vod-history-status" role="status">{t('historyLoading')}</p>}
      {metadataState === 'error' && <div className="vod-history-status" role="status"><span>{t('historyUnavailable')}</span><button type="button" className="btn-secondary" onClick={() => setHistoryAttempt(value => value + 1)}>{text.retry}</button></div>}
      {metadataState === 'ready' && <>
        <TitleHistory id={options.url} chapters={chapters} history={metadata.titleHistory} parts={parts} started={started} seconds={position}
          onSeek={seek} onTitleSeek={title => seek(title.seconds)} onHover={setHoveredChapter} onFocus={setFocusedChapter}
          onSelectRange={chapter => { changeRange(chapter.start, chapter.end); seek(chapter.start); setSidebarTab('cut'); }} t={t}/>
        <p className="vod-history-status">{t(metadata.titlesStatus === 'local' ? 'historyLocalTitles' : 'historyNoTitleSource')}</p>
        {metadata.chaptersStatus === 'unavailable' && <p className="vod-history-status">{t('historyNoChapterSource')}</p>}
      </>}
    </div>, document.getElementById('clipHistory'))}
    {createPortal(<><SelectionTimeline duration={Math.max(.1, duration)} range={range} position={position} onChange={changeRange} onSeek={seek} text={text}/>
    <div className="vod-mark-actions">
      <button type="button" className="btn-secondary" disabled={!session} onClick={() => mark('start')}>{text.markStart} <kbd>I</kbd></button>
      <button type="button" className="btn-secondary" disabled={!session} onClick={() => mark('end')}>{text.markEnd} <kbd>O</kbd></button>
      <button type="button" className="btn-secondary" disabled={!session} onClick={playRange}>{selectionPlaying ? text.stopRange : text.playRange}</button>
      <button type="button" className="btn-secondary" onClick={() => changeRange(0, duration)}>{text.full}</button>
    </div>
    <p className="vod-keyboard-help">{text.keyboard}</p></>, document.getElementById('clipSelectionTools'))}
  </div>;
}

window.VodPlayer = {
  mount(element, options) {
    const root = createRoot(element), bind = { current: null };
    root.render(<Workspace options={options} bind={bind}/>);
    return {
      destroy() { root.unmount(); },
      updateRange(start, end) { bind.current?.updateRange(start, end); },
      seek(seconds) { bind.current?.seek(seconds); },
    };
  },
};
