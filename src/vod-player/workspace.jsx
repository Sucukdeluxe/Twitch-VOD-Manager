import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { ArchivePlayer } from './ArchivePlayer.jsx';
import { TitleHistory } from './TitleHistory.jsx';
import { ListVideo } from 'lucide-react';
import { CutTimeline } from './CutTimeline.jsx';
import { playerTexts } from './texts.js';
import './player.css';
import './chapters.css';
import './workspace.css';

const labels = {
  de: { loading: 'VOD wird geöffnet …', failed: 'Das VOD konnte nicht geladen werden. Schnittzeiten können weiterhin eingegeben werden.', retry: 'Erneut laden', range: 'Schnittbereich', timeline: 'Schnittzeitleiste', timelineView: 'Ansicht der Schnittzeitleiste', overview: 'Gesamtes VOD', zoomSelection: 'Auswahl vergrößern', start: 'Start', end: 'Ende', setHere: 'Hier setzen', markStart: 'Start hier setzen', markEnd: 'Ende hier setzen', playRange: 'Auswahl abspielen', stopRange: 'Auswahl anhalten', full: 'Gesamtes VOD wählen', source: 'Streamqualität', keyboard: 'Leertaste / K: Wiedergabe · ← / →: 10 Sekunden · I / O: Schnittmarken · F: Vollbild', active: 'Auswahl wird abgespielt', sourceBest: 'Beste verfügbare Qualität' },
  en: { loading: 'Opening VOD …', failed: 'Could not load the VOD. You can still enter cut times.', retry: 'Retry', range: 'Selected range', timeline: 'Cut timeline', timelineView: 'Cut timeline view', overview: 'Entire VOD', zoomSelection: 'Zoom to selection', start: 'Start', end: 'End', setHere: 'Set here', markStart: 'Set start here', markEnd: 'Set end here', playRange: 'Play selection', stopRange: 'Pause selection', full: 'Select entire VOD', source: 'Stream quality', keyboard: 'Space / K: playback · ← / →: 10 seconds · I / O: cut markers · F: fullscreen', active: 'Playing selection', sourceBest: 'Best available quality' },
};

function Workspace({ options, bind }) {
  const language = options.language === 'en' ? 'en' : 'de';
  const text = labels[language];
  const t = useCallback(key => playerTexts[language][key] || key, [language]);
  const [metadata, setMetadata] = useState(null), [metadataState, setMetadataState] = useState('loading'), [historyAttempt, setHistoryAttempt] = useState(0);
  const [chapterPreview, setChapterPreview] = useState(null);
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
    setChapterPreview(hoveredChapter || focusedChapter ? { recordingId: options.url, chapterId: hoveredChapter || focusedChapter } : null);
  }, [hoveredChapter, focusedChapter, options.url]);
  const changeRange = useCallback((start, end, interaction) => {
    selectedPlayback.current = false; setSelectionPlaying(false);
    setRange({ start, end }); options.onRange(start, end);
    if (interaction?.source === 'pointer' && interaction.boundary === 'start') setSeekRequest({ seconds: start });
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
    changeRange(which === 'start' ? Math.min(value, range.end - .001) : range.start,
      which === 'end' ? Math.max(value, range.start + .001) : range.end);
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
      onPosition={onPosition} onTimeline={onTimeline} seekRequest={seekRequest} cutRange={range} onCutRange={changeRange} cutText={text}/>
      : !error && <div className="vod-player-loading" role="status"><span className="vod-loading-symbol"/>{text.loading}</div>}
    {error && <div className="vod-player-error" role="status"><span>{text.failed}</span><button type="button" className="btn-secondary" onClick={() => setAttempt(value => value + 1)}>{text.retry}</button></div>}
    <div className="vod-player-source"><span>{text.source}: {session?.quality === 'best' ? text.sourceBest : session?.quality || '…'}</span>{selectionPlaying && <span>{text.active}</span>}</div>
    {createPortal(<div className="vod-history">
      <h3 className="vod-history-title" id="clipHistoryTitle"><ListVideo size={17}/>{t('streamHistory')}</h3>
      <div className="vod-history-heading"><span>{t('vodTitle')}</span><strong>{metadata?.title || options.title}</strong></div>
      {metadataState === 'loading' && <p className="vod-history-status" role="status">{t('historyLoading')}</p>}
      {metadataState === 'error' && <div className="vod-history-status" role="status"><span>{t('historyUnavailable')}</span><button type="button" className="btn-secondary" onClick={() => setHistoryAttempt(value => value + 1)}>{text.retry}</button></div>}
      {metadataState === 'ready' && <>
        <TitleHistory id={options.url} chapters={chapters} history={metadata.titleHistory} parts={parts} started={started} seconds={position}
          onSeek={seek} onTitleSeek={title => seek(title.seconds)} onHover={setHoveredChapter} onFocus={setFocusedChapter}
          onSelectRange={chapter => { changeRange(chapter.start, chapter.end); seek(chapter.start); }} t={t}/>
        {metadata.titlesStatus === 'streamrecorder' && <p className="vod-history-status">{t('historyStreamrecorderTitles')}</p>}
        {metadata.titlesStatus === 'local' && <p className="vod-history-status">{t('historyLocalTitles')}</p>}
        {metadata.chaptersStatus === 'unavailable' && <p className="vod-history-status">{t('historyNoChapterSource')}</p>}
      </>}
    </div>, document.getElementById('clipHistory'))}
    {['start', 'end'].map(which => createPortal(<button type="button" className="vod-set-boundary" disabled={!session} aria-label={which === 'start' ? text.markStart : text.markEnd} title={which === 'start' ? text.markStart : text.markEnd} onClick={() => mark(which)}>{text.setHere}</button>, document.getElementById(which === 'start' ? 'clipMarkStart' : 'clipMarkEnd'), which))}
    {createPortal(<><CutTimeline chapters={chapters} duration={Math.max(.1, duration)} range={range} position={position} onChange={changeRange} onSeek={seek} text={text}/>
    <div className="vod-mark-actions" title={text.keyboard}>
      <button type="button" className="btn-secondary" disabled={!session} onClick={playRange}>{selectionPlaying ? text.stopRange : text.playRange}</button>
      <button type="button" className="btn-secondary" onClick={() => changeRange(0, duration)}>{text.full}</button>
    </div>
</>, document.getElementById('clipSelectionTools'))}
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
