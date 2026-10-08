import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChevronDown, SkipBack, SkipForward } from 'lucide-react';
import { PlayerButton, PlayerPanel, RateControl } from './PlayerControls.jsx';
import { ExactTimeForm } from './ExactTimeForm.jsx';
import { playerTexts } from './texts.js';
import './local-cutter.css';

function LocalCutterPlayer({ options, bind }) {
  const [state, setState] = useState(options.state);
  const [media, setMedia] = useState({ playing: false, volume: 1, muted: false, rate: 1, position: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const [message, setMessage] = useState('');
  const root = useRef(document.getElementById('cutterPlayer'));
  const lastVolume = useRef(1);
  bind.current = setState;
  const t = key => playerTexts[state.language === 'de' ? 'de' : 'en'][key] || key;
  const de = state.language === 'de';
  const video = options.video;
  useEffect(() => {
    const update = () => setMedia({ playing: !video.paused, volume: video.volume, muted: video.muted, rate: video.playbackRate, position: video.currentTime });
    const events = ['play', 'pause', 'timeupdate', 'seeked', 'volumechange', 'ratechange', 'loadedmetadata', 'emptied'];
    events.forEach(event => video.addEventListener(event, update));
    const full = () => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', full);
    update();
    return () => { events.forEach(event => video.removeEventListener(event, update)); document.removeEventListener('fullscreenchange', full); };
  }, [video]);
  useEffect(() => {
    if (!state.active) { root.current.classList.remove('cinema'); }
  }, [state.active]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 4000);
    return () => clearTimeout(timer);
  }, [message]);
  function volume(value) {
    video.volume = Math.max(0, Math.min(1, value)); video.muted = video.volume === 0;
  }
  function mute() {
    if (media.muted || !media.volume) volume(lastVolume.current || 1);
    else { lastVolume.current = media.volume; volume(0); }
  }
  async function toggleFullscreen() {
    try { if (document.fullscreenElement === root.current) await document.exitFullscreen(); else await root.current.requestFullscreen(); }
    catch { setMessage(t('fullscreenUnavailable')); }
  }
  async function picture() {
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); }
    catch { setMessage(t('pictureInPictureUnavailable')); }
  }
  function toggleCinema() { root.current.classList.toggle('cinema'); }
  if (!state.active) return null;
  const rate = <PlayerPanel root={root} label={t('playbackSpeed')} className="player-rate-button" trigger={<>{media.rate}×<ChevronDown size={14}/></>}>
    <RateControl value={String(media.rate)} onChange={value => { video.playbackRate = Number(value); }} t={t}/>
  </PlayerPanel>;
  return <div className="archive-controls local-cutter-controls" hidden={!state.active}>
    <div className="archive-control-row">
      <PlayerButton name="back" label={t('skipBack')} disabled={!state.enabled} onClick={() => options.seek(video.currentTime - 10)}/>
      <PlayerButton name={media.playing ? 'pause' : 'play'} label={media.playing ? t('pause') : t('playerPlay')} disabled={!state.enabled} onClick={options.play}/>
      <PlayerButton name="forward" label={t('skipForward')} disabled={!state.enabled} onClick={() => options.seek(video.currentTime + 10)}/>
      <div className="player-volume-control">
        <PlayerButton name={media.muted || !media.volume ? 'muted' : 'volume'} label={t(media.muted ? 'unmute' : 'mute')} onClick={mute}/>
        <input className="archive-volume" type="range" min="0" max="1" step="0.01" aria-label={t('volume')} value={media.muted ? 0 : media.volume} onChange={event => volume(Number(event.target.value))} style={{ '--range-progress': (media.muted ? 0 : media.volume * 100) + '%' }}/>
        <label className="player-volume-entry"><input type="number" min="0" max="100" aria-label={t('volumePercent')} value={Math.round(media.muted ? 0 : media.volume * 100)} onChange={event => volume(Number(event.target.value) / 100)}/>%</label>
      </div>
      <PlayerPanel root={root} label={t('exactTime')} className="player-time-button" trigger={options.format(media.position)}>
        {close => <ExactTimeForm position={media.position} total={state.duration} onCommit={options.seek} onClose={close} t={t}/>}
      </PlayerPanel>
      <span className="archive-control-spacer"/>
      <div className="local-frame-controls">
        <button type="button" className="player-button" aria-label={de ? 'Ein Bild zurück' : 'Previous frame'} title={de ? 'Ein Bild zurück' : 'Previous frame'} disabled={!state.enabled} onClick={() => options.frame(-1)}><SkipBack size={20}/></button>
        <button type="button" className="player-button" aria-label={de ? 'Ein Bild vor' : 'Next frame'} title={de ? 'Ein Bild vor' : 'Next frame'} disabled={!state.enabled} onClick={() => options.frame(1)}><SkipForward size={20}/></button>
      </div>
      {rate}
      <PlayerPanel root={root} label={t('playbackOptions')} className="local-player-options" trigger={<ChevronDown size={20}/>}>
        {close => <>
          <button type="button" className="player-menu-action" onClick={() => { toggleCinema(); close(); }}>{t('cinema')}</button>
          <button className="player-menu-action" disabled={!state.enabled} onClick={() => { void picture(); close(); }}>{t('pictureInPicture')}</button>
          <button className="player-menu-action" disabled={!state.enabled} onClick={() => options.frame(-1)}>{de ? 'Ein Bild zurück' : 'Previous frame'}</button>
          <button className="player-menu-action" disabled={!state.enabled} onClick={() => options.frame(1)}>{de ? 'Ein Bild vor' : 'Next frame'}</button>
          <label className="player-compact-volume">{t('volume')}<input type="range" min="0" max="1" step="0.01" value={media.muted ? 0 : media.volume} onChange={event => volume(Number(event.target.value))}/></label>
        </>}
      </PlayerPanel>
      <PlayerButton name={fullscreen ? 'exitFullscreen' : 'fullscreen'} label={t(fullscreen ? 'exitFullscreen' : 'fullscreen')} disabled={!state.enabled} onClick={toggleFullscreen}/>
    </div>
    {message && <div className="local-player-message" role="status">{message}</div>}
  </div>;
}

window.LocalCutterPlayer = {
  mount(element, options) {
    const root = createRoot(element), bind = { current: null };
    root.render(<LocalCutterPlayer options={options} bind={bind}/>);
    return { update(state) { if (bind.current) bind.current(state); else options.state = state; }, destroy() { root.unmount(); } };
  },
};
