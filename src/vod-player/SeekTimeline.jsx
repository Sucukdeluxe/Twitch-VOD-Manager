import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFloating, offset, flip, shift, size, autoUpdate, FloatingPortal, useTransitionStyles } from "@floating-ui/react";
import { RangeMarkers } from "./CutTimeline.jsx";
import { ChapterPreview } from "./ChapterPreview.jsx";
import { ChapterRangePreview } from "./ChapterRangePreview.jsx";
import { chapterAt, chapterColor, chapterGradient } from "./chapters.js";
import { timeLabel, remapTimelineTime } from "./timeline.js";
import { playerPortalRoot } from "./player-settings.js";
import { beginFineSeek, alignFineSeek, moveFineSeek, finishFineSeek, pointerTime, fineWindow, fineTicks, clampTime } from "./fine-seek.js";
import "./fine-seek.css";
import { createStreamClock, streamTimestamp } from "./stream-clock.js";
import { viewerSampleAt, viewerGapAt } from "./viewer-history.js";
import { ViewerHistory, ViewerCount } from "./ViewerHistory.jsx";
import { projectTitles, titleAt, titleMarkers } from "./title-history.js";
import "./title-history.css";

export function SeekTimeline({ total:availableTotal, position, parts, broadcastStarted, viewerHistory, viewerGaps, titleHistory:availableTitles = [], vodTitle, viewerCurves = [], chapters:availableChapters, endpoint:availableEndpoint, highlightedRange, root, onCommit, onScrub, onPreview, t, cutRange, onCutRange, cutText }) {
  const locale = t("locale");
  const streamClock = useMemo(() => createStreamClock(locale), [locale]);
  const input = useRef(null), ruler = useRef(null), drag = useRef(null), lastPreview = useRef(null), callbacks = useRef(null);
  const total = drag.current?.total ?? availableTotal;
  const previewParts = drag.current?.parts ?? parts;
  const chapters = drag.current?.chapters ?? availableChapters;
  const titleHistory = drag.current?.titleHistory ?? availableTitles;
  const titleEvents = useMemo(()=>projectTitles(titleHistory,previewParts,broadcastStarted),[titleHistory,previewParts,broadcastStarted]);
  const [trackWidth,setTrackWidth] = useState(1000);
  useLayoutEffect(()=>{
    const measure = ()=>setTrackWidth(input.current?.getBoundingClientRect().width || 1000);
    measure();
    const observer = new ResizeObserver(measure);
    if(input.current)observer.observe(input.current);
    return ()=>observer.disconnect();
  },[]);
  const endpoint = drag.current ? drag.current.endpoint : availableEndpoint;
  const [preview, setPreview] = useState(null), [panelWidth, setPanelWidth] = useState(480);
  callbacks.current = { onCommit, onScrub };
  const hintId = useId();
  const { refs, floatingStyles, context } = useFloating({ open:Boolean(preview), placement:"top", strategy:"fixed", whileElementsMounted:autoUpdate,
    middleware:[offset(12), flip({padding:12}), shift({padding:12}), size({padding:12,apply({availableWidth,elements}) {
      const width = Math.min(480, Math.max(0, availableWidth));
      elements.floating.style.width = `${width}px`;
      setPanelWidth(width);
    }})] });
  const { isMounted, styles } = useTransitionStyles(context, { duration:{open:140,close:140}, initial:{opacity:0,transform:"translateY(4px)"} });
  if (preview) lastPreview.current = preview;
  const shown = preview || lastPreview.current;
  useLayoutEffect(() => {
    if (!preview || !input.current) return;
    const anchor = preview.fine ? preview.anchor : preview.value;
    const element = input.current;
    refs.setPositionReference({contextElement:element,getBoundingClientRect() {
      const bounds=element.getBoundingClientRect();
      const x=preview.fine ? preview.anchorX : bounds.left+7+clampTime(anchor,total)/Math.max(1,total)*Math.max(1,bounds.width-14);
      return {x,y:bounds.top,left:x,right:x,top:bounds.top,bottom:bounds.top,width:0,height:0};
    }});
  }, [preview, total, refs]);
  useLayoutEffect(() => {
    if (!drag.current?.fine || !ruler.current) return;
    const aligned = alignFineSeek(drag.current,ruler.current.getBoundingClientRect());
    if (aligned !== drag.current) { drag.current=aligned; setPreview(aligned); }
  }, [preview, floatingStyles.transform, panelWidth]);
  useEffect(() => { onPreview(Boolean(preview)); }, [preview, onPreview]);
  function cancel() {
    if (drag.current) { drag.current=null; callbacks.current.onScrub(false); }
    setPreview(null);
  }
  useEffect(() => {
    const blur = () => cancel();
    window.addEventListener("blur",blur);
    window.addEventListener("resize",blur);
    return () => { window.removeEventListener("blur",blur); window.removeEventListener("resize",blur); callbacks.current.onScrub(false); };
  }, []);
  const boundaries = [...new Set(chapters.flatMap(chapter=>[chapter.start,chapter.end]))];
  const gradient = chapterGradient(chapters,total);
  function hover(value) { setPreview({value,anchor:value,window:fineWindow(value,total),fine:false,snapped:false}); }
  function move(event) {
    if (drag.current) {
      if (drag.current.pointerId !== event.pointerId) return;
      drag.current=moveFineSeek(drag.current,event.clientX,event.clientY,boundaries,event.altKey);
      setPreview(drag.current);
    } else if(event.pointerType!=="touch") hover(pointerTime(event.clientX,event.currentTarget.getBoundingClientRect(),total));
  }
  function finish(event) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const selection=finishFineSeek(drag.current,event.clientX,event.clientY,boundaries,event.altKey);
    drag.current=null;
    callbacks.current.onScrub(false);
    setPreview(null);
    if (Math.abs(selection.value-selection.original)>.001) callbacks.current.onCommit(remapTimelineTime(selection.value,selection.parts,parts));
  }
  const value = drag.current ? drag.current.value : position;
  const shownChapter = shown && chapterAt(chapters,shown.value,endpoint);
  const timestamp = shown ? streamClock(streamTimestamp(previewParts, broadcastStarted, shown.value), 0) : null;
  const currentTimestamp = streamClock(streamTimestamp(previewParts, broadcastStarted, value), 0);
  const shownTitle = shown && titleAt(titleHistory,streamTimestamp(previewParts,broadcastStarted,shown.value));
  const currentTitle = titleAt(titleHistory,streamTimestamp(previewParts,broadcastStarted,value));
  const viewerSample = shown && viewerSampleAt(viewerHistory, streamTimestamp(previewParts, broadcastStarted, shown.value));
  const currentViewerSample = viewerSampleAt(viewerHistory, streamTimestamp(previewParts, broadcastStarted, value));
  const shownViewerGap = shown && viewerGapAt(viewerGaps, streamTimestamp(previewParts, broadcastStarted, shown.value));
  const currentViewerGap = viewerGapAt(viewerGaps, streamTimestamp(previewParts, broadcastStarted, value));
  const time = shown ? `${timeLabel(shown.value)}${shown.fine ? (t("locale")==="de" ? "," : ".") + Math.floor((shown.value+0.00001)%1*10) : ""}` : "";
  return <div className="archive-timeline-track">
    <ViewerHistory curves={drag.current?.viewerCurves ?? viewerCurves}/>
    {gradient&&<svg className="category-track" viewBox="0 0 1000 6" preserveAspectRatio="none" shapeRendering="crispEdges" aria-hidden="true">
      <rect width="1000" height="6" fill="#777e8a"/>
      {chapters.map(chapter=>{
        const ending=chapter===chapters.at(-1) && Number.isFinite(endpoint) ? endpoint : chapter.end;
        const start=Math.max(0,Math.min(1000,chapter.start/total*1000)),end=Math.max(start,Math.min(1000,ending/total*1000));
        return <rect key={chapter.id} x={start} y="0" width={end-start} height="6" fill={chapterColor(chapter,chapters)}/>;
      })}
    </svg>}
    <span className="timeline-title-markers" aria-hidden="true">{titleMarkers(titleEvents,total,trackWidth).map(marker=><i key={marker.id} className={marker.count>1?'is-grouped':undefined} style={{left:`${marker.fraction*100}%`}}/>)}</span>
    <ChapterRangePreview range={highlightedRange} suppressed={Boolean(preview)} chapters={chapters} fallback={t("categoryUnavailable")}/>
    {cutRange && <RangeMarkers compact trackWidth={trackWidth - 14} duration={total} range={cutRange} onChange={onCutRange} text={cutText} onInteraction={cancel}/>}
    <span id={hintId} className="fine-seek-instructions">{t("fineSeekInstructions")}</span>
    <input ref={input} className={`archive-timeline${gradient?" has-chapters":""}`} type="range" aria-label={t("playbackPosition")} aria-describedby={hintId}
      aria-valuetext={`${timeLabel(value)} / ${timeLabel(total)}${currentTimestamp ? ` · ${currentTimestamp.label}` : ""} - ${chapterAt(chapters,value,endpoint)?.name || t("categoryUnavailable")}${currentTitle ? ` · ${currentTitle.title || t('historyEmptyTitle')}` : ''}${currentViewerGap ? ` · ${t("viewerMeasurementMissing")}` : currentViewerSample ? ` · ${currentViewerSample.viewers.toLocaleString(locale)} ${t("viewerCount")}` : ""}`} min="0" max={total||1} step="0.1" value={Math.min(value,total)} disabled={total<=0}
      style={{"--range-progress":`${total?value/total*100:0}%`,"--chapter-gradient":gradient}}
      onPointerDown={event=>{
        if(event.button!==0 || !event.isPrimary || drag.current || total<=0)return;
        event.preventDefault();
        event.currentTarget.focus({preventScroll:true});
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current={...beginFineSeek({x:event.clientX,y:event.clientY,bounds:event.currentTarget.getBoundingClientRect(),total,position,width:panelWidth}),pointerId:event.pointerId,parts,viewerCurves,chapters,endpoint,titleHistory};
        onScrub(true);setPreview(drag.current);
      }} onPointerMove={move} onPointerUp={finish}
      onPointerCancel={cancel} onLostPointerCapture={()=>{if(drag.current)cancel();}}
      onPointerLeave={()=>{if(!drag.current)setPreview(null);}} onBlur={cancel}
      onFocus={()=>{if(!drag.current)hover(position);}}
      onChange={event=>{if(!drag.current){onCommit(Number(event.target.value));hover(Number(event.target.value));}}}
      onKeyDown={event=>{
        if(event.key==="Escape"){event.preventDefault();event.stopPropagation();cancel();return;}
        if(drag.current)return;
        const amount={ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1,PageDown:-10,PageUp:10}[event.key];
        if(amount!==undefined || event.key==="Home" || event.key==="End"){
          event.preventDefault();event.stopPropagation();
          const next=clampTime(event.key==="Home"?0:event.key==="End"?total:position+amount*(event.shiftKey?10:1),total);
          onCommit(next);hover(next);
        }
      }}/>
    {isMounted && shown && <FloatingPortal root={playerPortalRoot(root.current,document.fullscreenElement,document.body)}>
      <div ref={refs.setFloating} className="fine-seek-position" style={floatingStyles} aria-hidden="true">
        <div className={`fine-seek-preview${shown.fine?" is-fine":""}${shown.snapped?" is-snapped":""}`} style={styles}>
          <div className="fine-seek-heading"><ChapterPreview fraction={.5} chapter={shownChapter} time={time} timestamp={timestamp} viewer={shownViewerGap ? <span className="viewer-count">{t("viewerMeasurementMissing")}</span> : viewerSample ? <ViewerCount sample={viewerSample} t={t}/> : null} fallback={t("categoryUnavailable")} color={chapterColor(shownChapter,chapters)}/></div>
          {(titleHistory.length>0 || vodTitle)&&<div className="fine-seek-title"><span>{shownTitle ? shownTitle.title || t('historyEmptyTitle') : vodTitle ? `${t('vodTitle')}: ${vodTitle}` : t('historyTitleUnknown')}</span></div>}
          <div ref={ruler} className="fine-seek-ruler">
            {chapters.filter(c=>c.end>shown.window.start&&c.start<shown.window.end).map(c=>{
              const start=Math.max(0,c.start,shown.window.start),end=Math.min(total,c.end,shown.window.end);
              return <span key={c.id} className="fine-seek-segment" style={{left:`${(start-shown.window.start)/shown.window.span*100}%`,width:`${(end-start)/shown.window.span*100}%`,background:chapterColor(c,chapters)}}/>;
            })}
            {boundaries.filter(b=>b>=shown.window.start&&b<=shown.window.end).map(b=><i key={b} className="fine-seek-boundary" style={{left:`${(b-shown.window.start)/shown.window.span*100}%`}}/>)}
            {titleEvents.filter(event=>event.kind==='changed'&&event.status==='ready'&&event.seconds>=shown.window.start&&event.seconds<=shown.window.end).map(event=><i key={event.id} className="fine-seek-title-marker" style={{left:`${(event.seconds-shown.window.start)/shown.window.span*100}%`}}/>)}
            {fineTicks(shown.window,panelWidth).filter(tick=>tick.time>=0&&tick.time<=total).map(tick=><span key={tick.time} className={`fine-seek-tick${tick.major?" is-major":""}`} style={{left:`${tick.fraction*100}%`}}>{tick.major&&tick.fraction>.07&&tick.fraction<.93&&<small>{timeLabel(tick.time)}</small>}</span>)}
            <span className="fine-seek-cursor" style={{left:`${(shown.value-shown.window.start)/Math.max(.001,shown.window.span)*100}%`}}/>
          </div>
          <div className="fine-seek-limits">{[Math.max(0,shown.window.start),Math.min(total,shown.window.end)].map((limit,index)=><span key={index} style={{left:`${(limit-shown.window.start)/Math.max(.001,shown.window.span)*100}%`,transform:index?"translateX(-100%)":undefined}}>{timeLabel(limit)}</span>)}</div>
        </div>
      </div>
    </FloatingPortal>}
  </div>;
}
