import { createReadStream } from 'node:fs';

export interface ChatReadSuccess {
    success: true;
    format: 'replay' | 'live';
    messages: Array<Record<string, unknown>>;
    truncated: boolean;
    total: number;
}

export interface ChatReadFailure {
    success: false;
    error?: string;
    cancelled?: boolean;
}

export type ChatReadResult = ChatReadSuccess | ChatReadFailure;

export interface ChatReadOptions {
    maxMessages?: number;
    signal?: AbortSignal;
    yieldEveryChunks?: number;
}

const DEFAULT_MAX_MESSAGES = 50_000;
const MAX_BUFFERED_ENTRY_CHARS = 512 * 1024;

function normalizeMaxMessages(value: number | undefined): number {
    if (!Number.isInteger(value) || value === undefined || value < 1) return DEFAULT_MAX_MESSAGES;
    return Math.min(value, DEFAULT_MAX_MESSAGES);
}

function normalizeYieldEveryChunks(value: number | undefined): number {
    if (!Number.isInteger(value) || value === undefined || value < 1) return 8;
    return value;
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function addMessage(messages: Array<Record<string, unknown>>, candidate: unknown, maxMessages: number): void {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    if ((candidate as { type?: unknown }).type === 'header') return;
    if (messages.length < maxMessages) messages.push(candidate as Record<string, unknown>);
}

function findJsonValueEnd(input: string): number | null {
    const first = input[0];
    if (!first) return null;
    if (first === '"') {
        let escaped = false;
        for (let index = 1; index < input.length; index++) {
            const char = input[index];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === '"') return index + 1;
        }
        return null;
    }
    if (first !== '{' && first !== '[') {
        const separator = input.search(/[\],]/);
        return separator < 0 ? null : separator;
    }
    const closing = first === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < input.length; index++) {
        const char = input[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === first) depth++;
        if (char === closing) {
            depth--;
            if (depth === 0) return index + 1;
        }
    }
    return null;
}

async function readLiveChat(filePath: string, maxMessages: number, signal: AbortSignal | undefined, yieldEveryChunks: number): Promise<ChatReadResult> {
    const messages: Array<Record<string, unknown>> = [];
    const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    const abort = () => stream.destroy();
    signal?.addEventListener('abort', abort, { once: true });
    let total = 0;
    let chunkCount = 0;
    let carry = '';
    try {
        for await (const chunk of stream) {
            if (signal?.aborted) return { success: false, cancelled: true };
            carry += chunk;
            if (carry.length > MAX_BUFFERED_ENTRY_CHARS && !carry.includes('\n')) throw new Error('Chat line exceeds read limit');
            let newlineIndex = carry.indexOf('\n');
            while (newlineIndex >= 0) {
                const line = carry.slice(0, newlineIndex).trim();
                carry = carry.slice(newlineIndex + 1);
                if (line) {
                    try {
                        const candidate = JSON.parse(line);
                        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && (candidate as { type?: unknown }).type !== 'header') {
                            total++;
                            addMessage(messages, candidate, maxMessages);
                        }
                    } catch { }
                }
                newlineIndex = carry.indexOf('\n');
            }
            chunkCount++;
            if (chunkCount % yieldEveryChunks === 0) await yieldToEventLoop();
        }
        if (signal?.aborted) return { success: false, cancelled: true };
        const finalLine = carry.trim();
        if (finalLine) {
            try {
                const candidate = JSON.parse(finalLine);
                if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && (candidate as { type?: unknown }).type !== 'header') {
                    total++;
                    addMessage(messages, candidate, maxMessages);
                }
            } catch { }
        }
        return { success: true, format: 'live', messages, truncated: total > messages.length, total };
    } catch (error) {
        if (signal?.aborted) return { success: false, cancelled: true };
        return { success: false, error: String(error) };
    } finally {
        signal?.removeEventListener('abort', abort);
        stream.destroy();
    }
}

async function readReplayChat(filePath: string, maxMessages: number, signal: AbortSignal | undefined, yieldEveryChunks: number): Promise<ChatReadResult> {
    const messages: Array<Record<string, unknown>> = [];
    const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    const abort = () => stream.destroy();
    signal?.addEventListener('abort', abort, { once: true });
    let total = 0;
    let chunkCount = 0;
    let beforeMessages = '';
    let entries = '';
    let foundMessages = false;
    let closed = false;
    try {
        for await (const chunk of stream) {
            if (signal?.aborted) return { success: false, cancelled: true };
            if (!foundMessages) {
                beforeMessages += chunk;
                const match = /"messages"\s*:\s*\[/.exec(beforeMessages);
                if (!match || match.index === undefined) {
                    beforeMessages = beforeMessages.slice(-128);
                    continue;
                }
                foundMessages = true;
                entries = beforeMessages.slice(match.index + match[0].length);
                beforeMessages = '';
            } else {
                entries += chunk;
            }
            if (entries.length > MAX_BUFFERED_ENTRY_CHARS) throw new Error('Chat entry exceeds read limit');
            while (entries) {
                const leading = /^\s*,?\s*/.exec(entries)?.[0] ?? '';
                entries = entries.slice(leading.length);
                if (!entries) break;
                if (entries[0] === ']') {
                    closed = true;
                    entries = '';
                    break;
                }
                const valueEnd = findJsonValueEnd(entries);
                if (valueEnd === null) break;
                const value = entries.slice(0, valueEnd);
                entries = entries.slice(valueEnd);
                try {
                    const candidate = JSON.parse(value);
                    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
                        total++;
                        addMessage(messages, candidate, maxMessages);
                    }
                } catch { }
            }
            chunkCount++;
            if (chunkCount % yieldEveryChunks === 0) await yieldToEventLoop();
            if (closed) break;
        }
        if (signal?.aborted) return { success: false, cancelled: true };
        if (!foundMessages || !closed) return { success: false, error: 'Unsupported chat file format' };
        return { success: true, format: 'replay', messages, truncated: total > messages.length, total };
    } catch (error) {
        if (signal?.aborted) return { success: false, cancelled: true };
        return { success: false, error: String(error) };
    } finally {
        signal?.removeEventListener('abort', abort);
        stream.destroy();
    }
}

export async function readChatFile(filePath: string, options: ChatReadOptions = {}): Promise<ChatReadResult> {
    if (options.signal?.aborted) return { success: false, cancelled: true };
    const maxMessages = normalizeMaxMessages(options.maxMessages);
    const yieldEveryChunks = normalizeYieldEveryChunks(options.yieldEveryChunks);
    return filePath.toLowerCase().endsWith('.jsonl')
        ? readLiveChat(filePath, maxMessages, options.signal, yieldEveryChunks)
        : readReplayChat(filePath, maxMessages, options.signal, yieldEveryChunks);
}
