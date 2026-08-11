export function createTrustedIpcHandler<TEvent, TArgs extends unknown[], TResult, TDenied>(
    isTrusted: (event: TEvent) => boolean,
    deniedResult: () => TDenied,
    handler: (event: TEvent, ...args: TArgs) => TResult,
): (event: TEvent, ...args: TArgs) => TResult | TDenied {
    return (event, ...args) => isTrusted(event) ? handler(event, ...args) : deniedResult();
}

export function registerTrustedIpcHandler<TEvent, TArgs extends unknown[], TResult, TDenied>(
    registrar: { handle(channel: string, handler: (event: TEvent, ...args: TArgs) => TResult | TDenied): void },
    channel: string,
    isTrusted: (event: TEvent) => boolean,
    deniedResult: () => TDenied,
    handler: (event: TEvent, ...args: TArgs) => TResult,
): void {
    registrar.handle(channel, createTrustedIpcHandler(isTrusted, deniedResult, handler));
}
