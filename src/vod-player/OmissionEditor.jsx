import React from 'react';
import { Scissors, ListVideo, Plus, Pencil, X, Undo2 } from 'lucide-react';
import { cutTime } from './CutTimeline.jsx';

const messages = {
  de: { clip:'Ausschnitt', omit:'Bereiche auslassen', modes:'Downloadumfang', minutes:'Minuten pro Part', add:'Auswahl ausschließen', update:'Bereich übernehmen', cancel:'Bearbeitung abbrechen', edit:'Bereich bearbeiten', restore:'Bereich wiederherstellen', clear:'Alle wiederherstellen', excluded:'Ausgelassene Bereiche', empty:'Mit I und O einen Bereich markieren und ausschließen. Weitere Bereiche können anschließend hinzugefügt werden.', output:'Dateivorschau', remaining:'Downloadlänge', removed:'Ausgelassen', files:'Dateien', source:'Ursprüngliche VOD-Zeiten', hint:'Verbleibende Inhalte rücken nach. Jeder Part hat die gewählte Länge; nur der letzte kann kürzer sein.', numbering:'Vollständig ausgelassene ursprüngliche Parts behalten ihre Nummernlücke.', noOutput:'Es bleibt kein Material zum Herunterladen übrig.', limit:'Maximal 256 Ausschlussbereiche.', skipped:'Ausgelassene Part-Nummern', invalid:'Teil-Länge oder Startnummer ist ungültig.' },
  en: { clip:'Excerpt', omit:'Exclude ranges', modes:'Download scope', minutes:'Minutes per part', add:'Exclude selection', update:'Apply range', cancel:'Cancel editing', edit:'Edit range', restore:'Restore range', clear:'Restore all', excluded:'Excluded ranges', empty:'Mark a range with I and O and exclude it. You can then add more ranges.', output:'File preview', remaining:'Download length', removed:'Excluded', files:'files', source:'Original VOD times', hint:'Remaining content moves up to fill each part. Only the final part can be shorter than the selected length.', numbering:'Fully excluded original parts keep their number gaps.', noOutput:'No content remains to download.', limit:'A maximum of 256 exclusions is supported.', skipped:'Skipped part numbers', invalid:'Invalid part length or starting number.' },
};

export function OmissionModes({ active, onChange, language }) {
  const t = messages[language];
  return <div className="vod-omission-modes" role="group" aria-label={t.modes}>
    <button type="button" aria-pressed={!active} onClick={() => onChange(false)}><Scissors size={15}/>{t.clip}</button>
    <button type="button" aria-pressed={active} onClick={() => onChange(true)}><ListVideo size={15}/>{t.omit}</button>
  </div>;
}

export function OmissionEditor({ ranges, setRanges, partMinutes, setPartMinutes, plan, range, valid, duration, language, selectRange, editing, setEditing, filename }) {
  const t = messages[language], number = value => value.toLocaleString(language);
  function apply() {
    if (!valid || range.start < 0 || range.end > duration || range.end <= range.start) return;
    setRanges(current => editing === null ? [...current, { ...range }] : current.map((value, index) => index === editing ? { ...range } : value));
    setEditing(null);
  }
  return <section className="vod-omission-editor" aria-label={t.excluded}>
    <div className="vod-omission-actions">
      <button type="button" className="btn-primary" onClick={apply} disabled={!valid || (editing === null && ranges.length >= 256)}><Plus size={16}/>{editing === null ? t.add : t.update}</button>
      {editing !== null && <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>{t.cancel}</button>}
      <label>{t.minutes}<input type="number" min="1" max="1440" step="1" value={partMinutes} onChange={event => setPartMinutes(event.target.value)}/></label>
    </div>
    <p className="vod-omission-help">{t.hint} {t.numbering}</p>
    <div className="vod-omission-columns">
      <div className="vod-omission-list">
        <div className="vod-omission-heading"><h4>{t.excluded} <span>{number(ranges.length)}</span></h4>{ranges.length > 0 && <button type="button" className="btn-secondary" onClick={() => { setRanges([]); setEditing(null); }}><Undo2 size={14}/>{t.clear}</button>}</div>
        {ranges.length === 0 ? <p className="vod-omission-help">{t.empty}</p> : <ol>{ranges.map((item, index) => <li key={index} className={editing === index ? 'is-editing' : undefined}>
          <button type="button" className="vod-omission-time" onClick={() => selectRange(item)}>{cutTime(item.start)} – {cutTime(item.end)}</button>
          <button type="button" className="vod-omission-icon" title={t.edit} aria-label={t.edit} onClick={() => { selectRange(item); setEditing(index); }}><Pencil size={15}/></button>
          <button type="button" className="vod-omission-icon" title={t.restore} aria-label={t.restore} onClick={() => { setRanges(current => current.filter((_, at) => at !== index)); setEditing(null); }}><X size={17}/></button>
        </li>)}</ol>}
      </div>
      <div className="vod-omission-overview">
        {plan ? <><details className="vod-output-preview"><summary>{t.output}<span>{number(plan.parts.length)} {t.files}</span></summary><div className="vod-output-summary"><strong>{number(plan.parts.length)} {t.files}</strong><span>{t.remaining}: {cutTime(plan.duration)}</span><span>{t.removed}: {cutTime(plan.omittedDuration)}</span></div>
          {plan.parts.length === 0 && <p role="status">{t.noOutput}</p>}
          {plan.skippedNumbers.length > 0 && <p className="vod-omission-help">{t.skipped}: {plan.skippedNumbers.map(number).join(', ')}</p>}
          <ol>{plan.parts.map(part => <li key={part.number}><div><strong>Part {String(part.number).padStart(2, '0')}</strong><time>{cutTime(part.duration)}</time></div><span className="vod-output-filename" title={filename(part)}>{filename(part)}</span><span className="vod-output-sources">{t.source}: {part.ranges.map(source => cutTime(source.start) + '–' + cutTime(source.end)).join(' · ')}</span></li>)}</ol>
        </details><div className="vod-output-summary"><strong>{t.remaining}: {cutTime(plan.duration)}</strong><span>{t.removed}: {cutTime(plan.omittedDuration)}</span></div></> : <p role="status">{t.invalid}</p>}
      </div>
    </div>
  </section>;
}

export function OmissionBands({ ranges = [], from = 0, to, compact = false }) {
  const span = Math.max(.001, to - from);
  return <span className={'vod-omission-bands' + (compact ? ' is-compact' : '')} aria-hidden="true">{ranges.filter(range => range.end > from && range.start < to).map((range, index) => <i key={index} style={{ left: Math.max(0, (range.start - from) / span * 100) + '%', width: (Math.min(to, range.end) - Math.max(from, range.start)) / span * 100 + '%' }}/>)}</span>;
}
