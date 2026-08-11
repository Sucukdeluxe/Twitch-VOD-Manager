const SECRET_KEYS = /(^|_)(authorization|cookie|password|secret|token)($|_)/i;

function redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (SECRET_KEYS.test(key) || key.toLowerCase() === 'discord_webhook_url') continue;
        result[key] = redact(entry);
    }
    return result;
}

export function createExportableConfig(config: Record<string, unknown>, exportedAt = new Date()): Record<string, unknown> {
    return {
        ...(redact(config) as Record<string, unknown>),
        __exportVersion: 2,
        __exportedAt: exportedAt.toISOString(),
    };
}
