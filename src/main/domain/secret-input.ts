export type SecretInputUpdate =
    | { action: 'unchanged' }
    | { action: 'clear' }
    | { action: 'set'; value: string };

export const SECRET_INPUT_MASK = '••••••••';

export function resolveSecretInputUpdate(value: string, configured: boolean): SecretInputUpdate {
    if (configured && value === SECRET_INPUT_MASK) return { action: 'unchanged' };
    const normalized = value.trim();
    if (normalized) return { action: 'set', value: normalized };
    return configured ? { action: 'clear' } : { action: 'unchanged' };
}
