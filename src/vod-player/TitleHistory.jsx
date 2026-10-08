import React, { useMemo, useRef, useState } from "react";
import { AlignLeft, LocateFixed, Play, Gamepad2, Scissors } from "lucide-react";
import { ChannelImage } from "./ChannelImage.jsx";
import { chapterAt, chapterColor, chapterDuration } from "./chapters.js";
import { timeLabel } from "./timeline.js";
import { createStreamClock, streamTimestamp } from "./stream-clock.js";
import { projectTitles, titleAt, timelineEntries } from "./title-history.js";
import "./title-history.css";

export function TitleHistory({id,chapters,history=[],parts=[],started,seconds,onSeek,onTitleSeek,onHover,onFocus,onSelectRange,t}) {
  const [filter,setFilter] = useState('all');
  const list = useRef(null);
  const clock = useMemo(()=>createStreamClock(t('locale')),[t('locale')]);
  const titles = useMemo(()=>projectTitles(history,parts,started),[history,parts,started]);
  const rows = useMemo(()=>timelineEntries(chapters,titles,parts,started),[chapters,titles,parts,started]);
  const currentChapter = chapterAt(chapters,seconds), currentTitle = titleAt(history,streamTimestamp(parts,started,seconds));
  const filtered = rows.filter(row=>filter==='all' || (filter==='games' ? row.chapter : row.titles.length));
  function focusCurrent() {
    const target = list.current?.querySelector('[data-current-title="true"]') || list.current?.querySelector('[aria-current="true"]');
    if (!target) return;
    target.scrollIntoView({block:'nearest',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    target.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
  }
  return <div className="title-history">
    <div className="history-toolbar">
      <div className="history-filters" role="group" aria-label={t('historyFilter')} style={{'--history-filter-index':['all','games','titles'].indexOf(filter)}}>
        <span className="history-filter-indicator" aria-hidden="true"/>
        {['all','games','titles'].map(value=><button key={value} aria-pressed={filter===value} onClick={()=>{setFilter(value);onHover(null);onFocus(null);}}>{t(`history_${value}`)}</button>)}
      </div>
      <button className="history-current" onClick={focusCurrent} aria-label={t('historyCurrent')} title={t('historyCurrent')}><LocateFixed size={18}/></button>
    </div>
    <div ref={list} className="chapter-list history-list" onKeyDown={event=>{if(event.key==='Escape'){onHover(null);onFocus(null);}}}>
      {filtered.map(row=>{
        const chapter = filter!=='titles' ? row.chapter : null;
        const entries = filter!=='games' ? row.titles : [];
        const activeTitle = entries.some(title=>title.id===currentTitle?.id);
        const active = activeTitle || Boolean(chapter && chapter.id===currentChapter?.id);
        return <article key={row.id} className={`chapter-card history-card${active?' is-current':''}`} aria-current={active?'true':undefined} data-current-title={activeTitle||undefined}
          onPointerEnter={event=>{if(event.pointerType!=='touch')onHover(chapter?.id ?? null);}} onPointerLeave={()=>onHover(null)} onPointerCancel={()=>onHover(null)}
          onFocusCapture={()=>onFocus(chapter?.id ?? null)} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget))onFocus(null);}}>
          {chapter&&<><button className="chapter-seek" onClick={()=>onSeek(chapter.start)} aria-label={`${t('play')}: ${chapter.name||t('categoryUnavailable')} · ${timeLabel(chapter.start)}`}>
            <span className="chapter-cover">{chapter.image?<ChannelImage src={chapter.image} alt="" loading="lazy"/>:<Gamepad2 size={24}/>}<Play className="chapter-cover-play" size={18}/></span>
            <span className="chapter-description"><span className="history-kind">{t(chapter.start===0?'historyGame':'historyGameChanged')}</span><strong><i style={{background:chapterColor(chapter,chapters)}}/>{chapter.name||t('categoryUnavailable')}</strong><span className="chapter-time">{timeLabel(chapter.start)} – {timeLabel(chapter.end)}</span><span className="chapter-duration">{chapterDuration(chapter)}</span>{chapter.precision==='minute'&&<small>{t('chapterApproximate')}</small>}</span>
          </button><button type="button" className="history-select-range" onClick={()=>onSelectRange(chapter)}><Scissors size={15}/>{t("selectChapterRange")}</button></>}
          {entries.map(title=>{
            const playable = title.seconds !== null, timestamp = clock(title.at,0);
            return <div className="history-title-entry" key={title.id}>
              <button className="history-title-seek" disabled={!playable} onClick={()=>onTitleSeek(title)} aria-label={`${t('play')}: ${title.title||t('historyEmptyTitle')}${playable?` · ${timeLabel(title.seconds)}`:''}`}>
                <span className="history-kind"><AlignLeft size={16}/>{t(title.status==='carried'?'historyTitleAtStart':title.kind==='changed'?'historyTitleChanged':title.kind==='initial'?'historyInitialTitle':'historyFirstObserved')}</span>
                <strong>{title.title||t('historyEmptyTitle')}</strong>
                <span className="history-title-meta">
                  <span className="history-title-time">{playable?<><Play size={14}/>{timeLabel(title.seconds)}</>:t(title.status==='gap'?'historyGap':'historyPending')}</span>
                  {timestamp&&<time dateTime={timestamp.dateTime} title={title.initialSnapshot ? [t('historyInitialSnapshot'),title.observedAt ? clock(title.observedAt,0)?.label : null].filter(Boolean).join(' · ') : t(title.precision==='eventsub'?'historyEventTime':title.precision==='observed'?'historyPollTime':title.precision==='minute'?'chapterApproximate':'historySourceTime')}>{timestamp.label}</time>}
                </span>
              </button>
            </div>;
          })}
        </article>;
      })}
      {!filtered.length&&<p className="muted">{t(filter==='titles'?'historyNoTitles':'historyEmpty')}</p>}
    </div>
  </div>;
}
