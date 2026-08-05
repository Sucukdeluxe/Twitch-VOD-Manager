export function normalizeUpdateVersion(version: string | null | undefined): string {
    return (version || '').trim().replace(/^v/i, '');
}

function parseVersionPart(part: string): number {
    const numeric = Number(part.replace(/[^0-9].*$/, ''));
    return Number.isFinite(numeric) ? numeric : 0;
}

export function compareUpdateVersions(left: string | null | undefined, right: string | null | undefined): number {
    const a = normalizeUpdateVersion(left);
    const b = normalizeUpdateVersion(right);

    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;

    const aParts = a.split('.').map(parseVersionPart);
    const bParts = b.split('.').map(parseVersionPart);
    const maxLength = Math.max(aParts.length, bParts.length);

    for (let i = 0; i < maxLength; i += 1) {
        const av = aParts[i] || 0;
        const bv = bParts[i] || 0;
        if (av > bv) return 1;
        if (av < bv) return -1;
    }

    return 0;
}

export function isNewerUpdateVersion(candidate: string | null | undefined, baseline: string | null | undefined): boolean {
    return compareUpdateVersions(candidate, baseline) > 0;
}
