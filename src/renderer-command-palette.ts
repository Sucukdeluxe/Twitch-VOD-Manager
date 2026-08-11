// Command Palette — Pillar 5 UI Power.
// Ctrl+K oeffnet ein Suchfeld + Liste schnell ausfuehrbarer Aktionen.
// MVP: 6 statische Tab-Wechsel-Befehle, prefix-match auf Label.

interface PaletteCommand {
    id: string;
    label: string;
    hint: string;
    keywords: string;   // fuer Match — Label kleingeschrieben + Synonyme
    action: () => void;
}

(function initCommandPalette() {
    const STORE: { commands: PaletteCommand[]; activeIndex: number; filtered: PaletteCommand[] } = {
        commands: [],
        activeIndex: 0,
        filtered: [],
    };

    function buildCommands(): PaletteCommand[] {
        const w = window as unknown as {
            showTab?: (tab: string) => void;
            selectStreamer?: (name: string, forceRefresh?: boolean) => Promise<void>;
            config?: { streamers?: Array<{ name: string }> };
        };
        const showTab = w.showTab;
        if (typeof showTab !== 'function') {
            return [];
        }

        // hint 'Open' statt 'Tab' — 'Tab' las sich wie eine Tastatur-Taste
        // ('druecke Tab') statt 'oeffnet diesen Tab'.
        const commandText = UI_TEXT.static.commandPaletteCommands;
        const tabs: Array<{ id: string; label: string; keywords: string }> = [
            { id: 'vods', ...commandText.vods },
            { id: 'clips', ...commandText.clips },
            { id: 'cutter', ...commandText.cutter },
            { id: 'merge', ...commandText.merge },
            { id: 'stats', ...commandText.stats },
            { id: 'archive', ...commandText.archive },
            { id: 'settings', ...commandText.settings },
        ];

        const tabCommands: PaletteCommand[] = tabs.map(t => ({
            id: 'tab:' + t.id,
            label: t.label,
            hint: UI_TEXT.static.commandPaletteOpenHint,
            keywords: `${t.label} ${t.keywords}`.toLowerCase(),
            action: () => showTab(t.id),
        }));

        // Streamer-Liste aus globalem config (gefuellt nach renderer-Init).
        const streamerCommands: PaletteCommand[] = [];
        const streamers = Array.isArray(w.config?.streamers) ? w.config.streamers : [];
        const selectStreamer = w.selectStreamer;
        if (typeof selectStreamer === 'function') {
            for (const entry of streamers) {
                if (!entry || typeof entry.name !== 'string') continue;
                const name = entry.name;
                streamerCommands.push({
                    id: 'streamer:' + name.toLowerCase(),
                    label: name,
                    hint: UI_TEXT.static.commandPaletteStreamerHint,
                    keywords: ('@' + name + ' ' + name).toLowerCase(),
                    action: () => {
                        showTab('vods');
                        void selectStreamer(name);
                    },
                });
            }
        }

        return [...tabCommands, ...streamerCommands];
    }

    function getModal(): HTMLElement | null {
        return document.getElementById('commandPaletteModal');
    }

    function getInput(): HTMLInputElement | null {
        return document.getElementById('commandPaletteInput') as HTMLInputElement | null;
    }

    function getList(): HTMLUListElement | null {
        return document.getElementById('commandPaletteList') as HTMLUListElement | null;
    }

    function isOpen(): boolean {
        return Boolean(getModal()?.classList.contains('show'));
    }

    function clearList(list: HTMLUListElement) {
        while (list.firstChild) list.removeChild(list.firstChild);
    }

    function render() {
        const list = getList();
        if (!list) return;
        clearList(list);
        STORE.filtered.forEach((cmd, idx) => {
            const li = document.createElement('li');
            li.id = `commandPaletteOption-${idx}`;
            li.className = 'cp-item' + (idx === STORE.activeIndex ? ' cp-active' : '');
            li.dataset.cmdId = cmd.id;
            li.setAttribute('role', 'option');
            li.setAttribute('aria-selected', idx === STORE.activeIndex ? 'true' : 'false');

            const label = document.createElement('span');
            label.className = 'cp-item-label';
            label.textContent = cmd.label;
            li.appendChild(label);

            const hint = document.createElement('span');
            hint.className = 'cp-item-hint';
            hint.textContent = cmd.hint;
            li.appendChild(hint);

            li.addEventListener('mouseenter', () => {
                STORE.activeIndex = idx;
                render();
            });
            li.addEventListener('click', () => {
                executeAt(idx);
            });

            list.appendChild(li);
        });
        const input = getInput();
        if (input) input.setAttribute('aria-activedescendant', STORE.filtered[STORE.activeIndex] ? `commandPaletteOption-${STORE.activeIndex}` : '');
    }

    function applyFilter(query: string) {
        const q = query.trim().toLowerCase();
        if (!q) {
            STORE.filtered = STORE.commands.slice();
        } else {
            STORE.filtered = STORE.commands.filter(c => c.keywords.includes(q));
        }
        STORE.activeIndex = 0;
        render();
    }

    function executeAt(idx: number) {
        const cmd = STORE.filtered[idx];
        if (!cmd) return;
        close();
        try {
            cmd.action();
        } catch (e) {
            console.error('command-palette: action failed', cmd.id, e);
        }
    }

    function open() {
        const modal = getModal();
        const input = getInput();
        if (!modal || !input) return;
        STORE.commands = buildCommands();
        STORE.filtered = STORE.commands.slice();
        STORE.activeIndex = 0;
        input.value = '';
        render();
        input.setAttribute('aria-expanded', 'true');
        RendererAccessibility.openDialog('commandPaletteModal', { initialFocus: input, onEscape: close });
    }

    function close() {
        const modal = getModal();
        if (!modal) return;
        getInput()?.setAttribute('aria-expanded', 'false');
        getInput()?.removeAttribute('aria-activedescendant');
        RendererAccessibility.closeDialog('commandPaletteModal');
    }

    function onKeydown(e: KeyboardEvent) {
        // Toggle: Ctrl+K (Linux/Windows) or Cmd+K (Mac)
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            if (isOpen()) {
                close();
            } else {
                open();
            }
            return;
        }

        if (!isOpen()) return;

        if (e.key === 'Escape') {
            e.preventDefault();
            close();
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (STORE.filtered.length === 0) return;
            STORE.activeIndex = (STORE.activeIndex + 1) % STORE.filtered.length;
            render();
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (STORE.filtered.length === 0) return;
            STORE.activeIndex = (STORE.activeIndex - 1 + STORE.filtered.length) % STORE.filtered.length;
            render();
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            executeAt(STORE.activeIndex);
            return;
        }
    }

    function attach() {
        const input = getInput();
        if (input) {
            input.addEventListener('input', () => applyFilter(input.value));
        }
        const modal = getModal();
        if (modal) {
            modal.addEventListener('click', e => {
                if (e.target === modal) close();
            });
        }
        document.addEventListener('keydown', onKeydown, { capture: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attach);
    } else {
        attach();
    }

    // Expose for renderer.ts closeTopmostOpenModal integration.
    (window as unknown as { closeCommandPalette?: () => void }).closeCommandPalette = close;
})();
