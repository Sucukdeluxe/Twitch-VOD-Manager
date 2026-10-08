import React, { useId, useState } from 'react';
import { exactTimeLabel, parseExactTime } from './exact-time.js';

export function ExactTimeForm({ position, total, onCommit, onClose, t }) {
  const [value, setValue] = useState(() => exactTimeLabel(position));
  const hint = useId(), error = useId();
  const parsed = parseExactTime(value, total), invalid = parsed === null;
  return <form className="player-exact-time" onSubmit={event => {
    event.preventDefault();
    if (invalid) return;
    onCommit(parsed); onClose();
  }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <label><strong>{t('exactTime')}</strong><input type="text" value={value} placeholder="1:23:45,250" aria-invalid={invalid} aria-describedby={`${hint}${invalid ? ` ${error}` : ''}`}
      onChange={event => setValue(event.target.value)} spellCheck={false} autoComplete="off" /></label>
    <p id={hint}>{t('exactTimeHint')} · 0:00:00 – {exactTimeLabel(total)}</p>
    {invalid && <p id={error} role="status">{t('exactTimeInvalid')}</p>}
    <div><button type="button" onClick={onClose}>{t('close')}</button><button type="submit" disabled={invalid}>{t('jumpToTime')}</button></div>
  </form>;
}
