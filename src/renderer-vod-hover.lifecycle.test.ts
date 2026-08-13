import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

class FakeClassList {
    private readonly values = new Set<string>();

    add(...tokens: string[]): void {
        tokens.forEach((token) => this.values.add(token));
    }

    remove(...tokens: string[]): void {
        tokens.forEach((token) => this.values.delete(token));
    }

    contains(token: string): boolean {
        return this.values.has(token);
    }
}

class FakeElement {
    readonly classList = new FakeClassList();
    readonly dataset: Record<string, string> = {};
    readonly style: Record<string, string> = {};
    readonly children: FakeElement[] = [];
    readonly listeners = new Map<string, Array<(event: { target: FakeElement; relatedTarget: FakeElement | null }) => void>>();
    className = '';
    parentElement: FakeElement | null = null;

    constructor(readonly tagName: string) { }

    appendChild(child: FakeElement): FakeElement {
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    addEventListener(type: string, listener: (event: { target: FakeElement; relatedTarget: FakeElement | null }) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    dispatch(type: string, target: FakeElement, relatedTarget: FakeElement | null): void {
        for (const listener of this.listeners.get(type) ?? []) listener({ target, relatedTarget });
    }

    closest(selector: string): FakeElement | null {
        if (selector === '.vod-card' && this.className.split(/\s+/).includes('vod-card')) return this;
        return this.parentElement?.closest(selector) ?? null;
    }

    contains(node: FakeElement): boolean {
        return node === this || this.children.some((child) => child.contains(node));
    }

    remove(): void {
        if (!this.parentElement) return;
        const index = this.parentElement.children.indexOf(this);
        if (index >= 0) this.parentElement.children.splice(index, 1);
        this.parentElement = null;
    }

    querySelector(selector: string): FakeElement | null {
        if (selector === '.vod-thumb-wrap') return this.children.find((child) => child.className === 'vod-thumb-wrap') ?? null;
        return null;
    }

    getBoundingClientRect(): { width: number; height: number } {
        return { width: 320, height: 180 };
    }
}

describe('renderer VOD hover lifecycle', () => {
    it('does not restart an active preview while moving between elements of the same card', async () => {
        const source = readFileSync(join(__dirname, 'renderer-vod-hover.ts'), 'utf8');
        const grid = new FakeElement('section');
        const card = createCard();
        const title = new FakeElement('h3');
        card.appendChild(title);
        grid.appendChild(card);
        const context = createHoverContext([Promise.resolve(storyboard())], grid);
        evaluateHover(source, context);
        const bind = (context.window as Record<string, unknown>).ensureVodHoverHandlersBound as (() => void);
        bind();

        grid.dispatch('mouseover', card.children[0], null);
        context.scheduledTimers.shift()?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(context.intervalCount).toBe(1);
        expect(context.scheduledTimers).toEqual([]);

        grid.dispatch('mouseover', title, card.children[0]);

        expect(context.scheduledTimers).toEqual([]);
        expect(context.intervalCount).toBe(1);
    });

    it('does not let an older same-ID fetch steal the newer card activation', async () => {
        const source = readFileSync(join(__dirname, 'renderer-vod-hover.ts'), 'utf8');
        const requests = [deferredStoryboard(), deferredStoryboard()];
        const cardA = createCard();
        const cardB = createCard();
        const context = createHoverContext(requests.map((request) => request.promise));
        const exposed = evaluateHover(source, context);

        exposed.scheduleHoverPreview(cardA, 'vod-1');
        context.scheduledTimers.shift()?.();
        exposed.clearHoverPreview();
        exposed.scheduleHoverPreview(cardB, 'vod-1');
        context.scheduledTimers.shift()?.();

        requests[0].resolve(storyboard());
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(cardA.children[0].children).toEqual([]);

        requests[1].resolve(storyboard());
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(cardA.children[0].children).toEqual([]);
        expect(cardB.children[0].children).toHaveLength(1);
        expect(context.intervalCount).toBe(1);
    });

    it('exports cleanup that cancels the interval, removes the preview and invalidates a queued activation frame', async () => {
        const source = readFileSync(join(__dirname, 'renderer-vod-hover.ts'), 'utf8');
        const scheduledFrames: Array<() => void> = [];
        const scheduledTimers: Array<() => void> = [];
        const clearedIntervals: number[] = [];
        const card = new FakeElement('article');
        const thumbnail = new FakeElement('div');
        thumbnail.className = 'vod-thumb-wrap';
        card.appendChild(thumbnail);
        const context: Record<string, unknown> = {
            document: {
                readyState: 'loading',
                addEventListener: () => undefined,
                getElementById: () => null,
                createElement: (tagName: string) => new FakeElement(tagName)
            },
            HTMLElement: FakeElement,
            requestAnimationFrame: (callback: () => void) => { scheduledFrames.push(callback); return scheduledFrames.length; },
            setTimeout: (callback: () => void) => { scheduledTimers.push(callback); return scheduledTimers.length; },
            setInterval: () => 73,
            clearInterval: (id: number) => clearedIntervals.push(id),
            api: {
                getVodStoryboard: vi.fn(async () => ({
                    framesInSprite: 4,
                    cols: 2,
                    rows: 2,
                    cellWidth: 160,
                    cellHeight: 90,
                    spriteDataUrl: 'data:image/jpeg;base64,preview',
                    frameDataUrls: []
                }))
            }
        };
        context.window = context;
        const compiled = transpileModule(`${source}\nglobalThis.exposed = { scheduleHoverPreview };`, {
            compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 }
        }).outputText;
        runInNewContext(compiled, context);
        const exposed = (context as { exposed: { scheduleHoverPreview(card: FakeElement, vodId: string): void } }).exposed;
        exposed.scheduleHoverPreview(card, 'vod-1');
        scheduledTimers.shift()?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        const cleanup = (context.window as Record<string, unknown>).clearVodHoverPreview as (() => void) | undefined;
        expect(cleanup).toBeTypeOf('function');
        cleanup?.();
        scheduledFrames.forEach((callback) => callback());

        expect(clearedIntervals).toEqual([73]);
        expect(card.classList.contains('preview-active')).toBe(false);
        expect(thumbnail.children[0]?.style.opacity).toBe('0');
    });
});

function storyboard(): Record<string, unknown> {
    return {
        framesInSprite: 4,
        cols: 2,
        rows: 2,
        cellWidth: 160,
        cellHeight: 90,
        spriteDataUrl: 'data:image/jpeg;base64,preview',
        frameDataUrls: []
    };
}

function deferredStoryboard(): { promise: Promise<Record<string, unknown>>; resolve(value: Record<string, unknown>): void } {
    let resolvePromise!: (value: Record<string, unknown>) => void;
    return {
        promise: new Promise((resolve) => { resolvePromise = resolve; }),
        resolve: resolvePromise
    };
}

function createCard(): FakeElement {
    const card = new FakeElement('article');
    card.className = 'vod-card';
    card.dataset.vodId = 'vod-1';
    const thumbnail = new FakeElement('div');
    thumbnail.className = 'vod-thumb-wrap';
    card.appendChild(thumbnail);
    return card;
}

interface HoverTestContext extends Record<string, unknown> {
    scheduledTimers: Array<() => void>;
    intervalCount: number;
}

function createHoverContext(requests: Array<Promise<Record<string, unknown>>>, grid: FakeElement | null = null): HoverTestContext {
    const scheduledTimers: Array<() => void> = [];
    const context: HoverTestContext = {
        scheduledTimers,
        intervalCount: 0,
        document: {
            readyState: 'loading',
            addEventListener: () => undefined,
            getElementById: () => grid,
            createElement: (tagName: string) => new FakeElement(tagName)
        },
        HTMLElement: FakeElement,
        requestAnimationFrame: () => 1,
        setTimeout: (callback: () => void) => { scheduledTimers.push(callback); return scheduledTimers.length; },
        setInterval: () => { context.intervalCount += 1; return context.intervalCount; },
        clearInterval: () => undefined,
        api: { getVodStoryboard: vi.fn(() => requests.shift()) }
    };
    context.window = context;
    return context;
}

function evaluateHover(source: string, context: HoverTestContext): { scheduleHoverPreview(card: FakeElement, vodId: string): void; clearHoverPreview(): void } {
    const compiled = transpileModule(`${source}\nglobalThis.exposed = { scheduleHoverPreview, clearHoverPreview };`, {
        compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 }
    }).outputText;
    runInNewContext(compiled, context);
    return (context as unknown as { exposed: { scheduleHoverPreview(card: FakeElement, vodId: string): void; clearHoverPreview(): void } }).exposed;
}
