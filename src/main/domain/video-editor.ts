export interface EditorCut {
    id: string;
    start: number;
    end: number;
}

export interface EditorSegment {
    start: number;
    end: number;
}

export interface VideoEditorState {
    duration: number;
    fps: number;
    trimStart: number;
    trimEnd: number;
    cuts: EditorCut[];
}

export interface EditorHistory {
    past: VideoEditorState[];
    present: VideoEditorState;
    future: VideoEditorState[];
}

const precision = 9;
const frameTolerance = 1e-8;
export const maxVideoEditorCuts = 64;

function finitePositive(value: number, name: string): number {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be greater than zero`);
    }
    return value;
}

function rounded(value: number): number {
    return Number(value.toFixed(precision));
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}

function snapToFrame(value: number, fps: number): number {
    return rounded(Math.round(value * fps) / fps);
}

function cloneState(state: VideoEditorState): VideoEditorState {
    return {
        duration: state.duration,
        fps: state.fps,
        trimStart: state.trimStart,
        trimEnd: state.trimEnd,
        cuts: state.cuts.map((cut) => ({ ...cut })),
    };
}

function statesEqual(left: VideoEditorState, right: VideoEditorState): boolean {
    return left.duration === right.duration
        && left.fps === right.fps
        && left.trimStart === right.trimStart
        && left.trimEnd === right.trimEnd
        && left.cuts.length === right.cuts.length
        && left.cuts.every((cut, index) => {
            const other = right.cuts[index];
            return cut.id === other.id && cut.start === other.start && cut.end === other.end;
        });
}

function nextCutId(cuts: EditorCut[]): string {
    const used = new Set(cuts.map((cut) => cut.id));
    let index = cuts.length + 1;
    while (used.has(`cut-${index}`)) index += 1;
    return `cut-${index}`;
}

function overlapsAnotherCut(cuts: EditorCut[], id: string, start: number, end: number): boolean {
    return cuts.some((cut) => cut.id !== id && start < cut.end && end > cut.start);
}

function sortCuts(cuts: EditorCut[]): EditorCut[] {
    return [...cuts].sort((left, right) => left.start - right.start || left.end - right.end || left.id.localeCompare(right.id));
}

function hasPlayableFrame(state: VideoEditorState, cuts: EditorCut[]): boolean {
    const removedDuration = cuts.reduce((total, cut) => total + cut.end - cut.start, 0);
    return state.trimEnd - state.trimStart - removedDuration >= 1 / state.fps - frameTolerance;
}

export function createVideoEditorState(duration: number, fps: number): VideoEditorState {
    const safeDuration = finitePositive(duration, 'duration');
    const safeFps = finitePositive(fps, 'fps');
    return {
        duration: rounded(safeDuration),
        fps: safeFps,
        trimStart: 0,
        trimEnd: rounded(safeDuration),
        cuts: [],
    };
}

export function formatEditorTimecode(time: number, fps: number): string {
    const safeFps = finitePositive(fps, 'fps');
    let wholeSeconds = Math.floor(Math.max(0, time));
    let frames = Math.round((Math.max(0, time) - wholeSeconds) * safeFps);
    const frameBase = Math.max(1, Math.round(safeFps));
    if (frames >= frameBase) {
        wholeSeconds += 1;
        frames = 0;
    }
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const seconds = wholeSeconds % 60;
    const fields = hours > 0
        ? [hours, minutes, seconds, frames]
        : [minutes, seconds, frames];
    return fields.map((field) => String(field).padStart(2, '0')).join(':');
}

export function parseEditorTimecode(value: string, fps: number): number {
    const safeFps = finitePositive(fps, 'fps');
    const fields = value.trim().split(':');
    if (fields.length !== 3 && fields.length !== 4) {
        throw new Error('Timecode must use MM:SS:FF or HH:MM:SS:FF');
    }
    const numbers = fields.map((field) => Number(field));
    if (numbers.some((field) => !Number.isInteger(field) || field < 0)) {
        throw new Error('Timecode fields must be non-negative integers');
    }
    const [hours, minutes, seconds, frames] = numbers.length === 4
        ? numbers
        : [0, numbers[0], numbers[1], numbers[2]];
    if (minutes >= 60 || seconds >= 60 || frames >= Math.max(1, Math.round(safeFps))) {
        throw new Error('Timecode field is out of range');
    }
    return rounded(hours * 3600 + minutes * 60 + seconds + frames / safeFps);
}

export function setTrimRange(state: VideoEditorState, start: number, end: number): VideoEditorState {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return state;
    const frameDuration = 1 / state.fps;
    const nextStart = clamp(snapToFrame(start, state.fps), 0, state.duration);
    const nextEnd = clamp(snapToFrame(end, state.fps), 0, state.duration);
    if (nextEnd - nextStart < frameDuration - frameTolerance) return state;
    const cuts = state.cuts
        .map((cut) => ({
            ...cut,
            start: Math.max(cut.start, nextStart),
            end: Math.min(cut.end, nextEnd),
        }))
        .filter((cut) => cut.end - cut.start >= frameDuration - frameTolerance);
    const nextState = {
        ...state,
        trimStart: rounded(nextStart),
        trimEnd: rounded(nextEnd),
        cuts: sortCuts(cuts),
    };
    return hasPlayableFrame(nextState, nextState.cuts) ? nextState : state;
}

export function addCutAt(state: VideoEditorState, start: number, duration: number): { state: VideoEditorState; cut: EditorCut } {
    if (state.cuts.length >= maxVideoEditorCuts) throw new Error(`Edit supports up to ${maxVideoEditorCuts} removed ranges`);
    const nextStart = clamp(snapToFrame(start, state.fps), state.trimStart, state.trimEnd);
    const nextEnd = clamp(snapToFrame(start + duration, state.fps), state.trimStart, state.trimEnd);
    const frameDuration = 1 / state.fps;
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0 || nextEnd - nextStart < frameDuration - frameTolerance) {
        throw new Error('Cut must contain at least one frame');
    }
    const cut: EditorCut = { id: nextCutId(state.cuts), start: rounded(nextStart), end: rounded(nextEnd) };
    if (overlapsAnotherCut(state.cuts, cut.id, cut.start, cut.end)) {
        throw new Error('Cut overlaps another cut');
    }
    const cuts = sortCuts([...state.cuts, cut]);
    if (!hasPlayableFrame(state, cuts)) throw new Error('Edit must keep at least one playable frame');
    return {
        cut,
        state: { ...state, cuts },
    };
}

export function setCutRange(state: VideoEditorState, id: string, start: number, end: number): VideoEditorState {
    const existing = state.cuts.find((cut) => cut.id === id);
    if (!existing || !Number.isFinite(start) || !Number.isFinite(end)) return state;
    const nextStart = clamp(snapToFrame(start, state.fps), state.trimStart, state.trimEnd);
    const nextEnd = clamp(snapToFrame(end, state.fps), state.trimStart, state.trimEnd);
    if (nextEnd - nextStart < 1 / state.fps - frameTolerance) return state;
    if (overlapsAnotherCut(state.cuts, id, nextStart, nextEnd)) return state;
    const cuts = sortCuts(state.cuts.map((cut) => cut.id === id
        ? { ...cut, start: rounded(nextStart), end: rounded(nextEnd) }
        : cut));
    if (!hasPlayableFrame(state, cuts)) return state;
    return {
        ...state,
        cuts,
    };
}

export function removeCut(state: VideoEditorState, id: string): VideoEditorState {
    if (!state.cuts.some((cut) => cut.id === id)) return state;
    return { ...state, cuts: state.cuts.filter((cut) => cut.id !== id) };
}

export function getPlayableSegments(state: VideoEditorState): EditorSegment[] {
    const segments: EditorSegment[] = [];
    let cursor = state.trimStart;
    for (const cut of sortCuts(state.cuts)) {
        const start = clamp(cut.start, state.trimStart, state.trimEnd);
        const end = clamp(cut.end, state.trimStart, state.trimEnd);
        if (start > cursor) segments.push({ start: rounded(cursor), end: rounded(start) });
        cursor = Math.max(cursor, end);
    }
    if (cursor < state.trimEnd) segments.push({ start: rounded(cursor), end: rounded(state.trimEnd) });
    return segments;
}

export function getPlayableDuration(state: VideoEditorState): number {
    return rounded(getPlayableSegments(state).reduce((total, segment) => total + segment.end - segment.start, 0));
}

export function movePreviewTimeOutOfCuts(state: VideoEditorState, time: number): number {
    let nextTime = clamp(time, state.trimStart, state.trimEnd);
    for (const cut of sortCuts(state.cuts)) {
        if (nextTime >= cut.start && nextTime < cut.end) nextTime = cut.end;
    }
    return rounded(clamp(nextTime, state.trimStart, state.trimEnd));
}

export function timeToTimelinePercent(state: VideoEditorState, time: number): number {
    return clamp((time / state.duration) * 100, 0, 100);
}

export function timelinePercentToTime(state: VideoEditorState, percent: number): number {
    return snapToFrame(clamp(percent, 0, 100) / 100 * state.duration, state.fps);
}

export function createEditorHistory(initial: VideoEditorState): EditorHistory {
    return { past: [], present: cloneState(initial), future: [] };
}

export function commitEditorState(history: EditorHistory, next: VideoEditorState): EditorHistory {
    if (statesEqual(history.present, next)) return history;
    return {
        past: [...history.past, cloneState(history.present)],
        present: cloneState(next),
        future: [],
    };
}

export function undoEditorState(history: EditorHistory): EditorHistory {
    const previous = history.past.at(-1);
    if (!previous) return history;
    return {
        past: history.past.slice(0, -1),
        present: cloneState(previous),
        future: [cloneState(history.present), ...history.future],
    };
}

export function redoEditorState(history: EditorHistory): EditorHistory {
    const next = history.future[0];
    if (!next) return history;
    return {
        past: [...history.past, cloneState(history.present)],
        present: cloneState(next),
        future: history.future.slice(1),
    };
}
