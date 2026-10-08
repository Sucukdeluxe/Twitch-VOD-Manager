import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { chapterColor } from './chapters.js';
import { timeLabel } from './timeline.js';

export function cutTime(seconds) {
  const value = Math.round(Math.max(0, seconds) * 1000);
  return `${timeLabel(Math.floor(value / 1000))}.${String(value % 1000).padStart(3, '0')}`;
}

export function RangeMarkers({ duration, range, onChange, text, from = 0, to = duration, compact = false, onInteraction }) {
  const track = useRef(null), drag = useRef(null);
  const span = Math.max(.001, to - from);
  function update(which, value) {
    onChange(which === 'start' ? Math.max(0, Math.min(value, range.end - .001)) : range.start,
      which === 'end' ? Math.min(duration, Math.max(value, range.start + .001)) : range.end);
  }
  return <div ref={track} className={`vod-range-markers${compact ? ' is-compact' : ''}`}>
    <span className="vod-range-band" style={{ left: `${(range.start - from) / span * 100}%`, width: `${(range.end - range.start) / span * 100}%` }}/>
    {['start', 'end'].map(which => <button key={which} type="button" role="slider" className={`vod-range-handle is-${which}`}
      aria-label={text[which]} aria-orientation="horizontal" aria-valuemin={which === 'start' ? 0 : range.start + .001}
      aria-valuemax={which === 'start' ? range.end - .001 : duration} aria-valuenow={range[which]} aria-valuetext={cutTime(range[which])}
      title={`${text[which]}: ${cutTime(range[which])}`} style={{ left: `${(range[which] - from) / span * 100}%` }}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault(); event.stopPropagation(); onInteraction?.();
        event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, value: range[which], span, width: track.current.getBoundingClientRect().width };
      }}
      onPointerMove={event => {
        if (drag.current?.id !== event.pointerId) return;
        event.stopPropagation();
        const value = drag.current.value + (event.clientX - drag.current.x) / Math.max(1, drag.current.width) * drag.current.span;
        update(which, Math.max(from, Math.min(to, Math.round(value * 10) / 10)));
      }}
      onPointerUp={event => { event.stopPropagation(); drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        const step = event.shiftKey ? 10 : event.altKey ? .001 : .1;
        const delta = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[event.key];
        if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault(); event.stopPropagation(); onInteraction?.();
        update(which, delta === undefined ? event.key === 'Home' ? 0 : duration : Math.round((range[which] + delta) * 1000) / 1000);
      }}><span>{which === 'start' ? 'I' : 'O'}</span></button>)}
  </div>;
}

export function CutTimeline({ duration, range, position, chapters, onChange, onSeek, text }) {
  const track = useRef(null);
  const [view, setView] = useState(null);
  function selectionView() {
    const padding = Math.max(2, (range.end - range.start) * .15);
    return { from: Math.max(0, range.start - padding), to: Math.min(duration, range.end + padding) };
  }
  useEffect(() => {
    if (view && (range.start < view.from || range.end > view.to || view.to > duration)) setView(selectionView());
  }, [range.start, range.end, duration]);
  const from = view?.from ?? 0, to = view?.to ?? duration, span = Math.max(.001, to - from);
  const ticks = Array.from({ length: 7 }, (_, index) => from + span * index / 6);
  function seekAt(event) {
    const bounds = track.current.getBoundingClientRect();
    onSeek(Math.max(from, Math.min(to, from + (event.clientX - bounds.left) / bounds.width * span)));
  }
  return <div className="vod-selection">
    {createPortal(<div className="vod-timeline-view" role="group" aria-label={text.timelineView}>
      <button type="button" aria-pressed={!view} onClick={() => setView(null)}>{text.overview}</button>
      <button type="button" aria-pressed={Boolean(view)} onClick={() => setView(selectionView())}>{text.zoomSelection}</button>
    </div>, document.getElementById('clipTimelineView'))}
    <div ref={track} className="vod-selection-track" onClick={seekAt}>
      <div className="vod-selection-chapters" aria-hidden="true">{chapters.filter(chapter => chapter.end > from && chapter.start < to).map(chapter => {
        const start = Math.max(from, chapter.start), end = Math.min(to, chapter.end);
        return <span key={chapter.id} style={{ left: `${(start - from) / span * 100}%`, width: `${(end - start) / span * 100}%`, '--chapter-color': chapterColor(chapter, chapters) }} title={`${chapter.name} · ${cutTime(chapter.start)} – ${cutTime(chapter.end)}`}>{chapter.name}</span>;
      })}</div>
      <RangeMarkers duration={duration} range={range} onChange={onChange} text={text} from={from} to={to}/>
      {position >= from && position <= to && <i className="vod-selection-playhead" title={cutTime(position)} style={{ left: `${(position - from) / span * 100}%` }}/>} 
    </div>
    <div className="vod-selection-labels" aria-hidden="true">{ticks.map((value, index) => <span key={index}>{view && span < 10 ? cutTime(value) : timeLabel(value)}</span>)}</div>
  </div>;
}
