import * as http from 'http';
import { URL } from 'url';

/**
 * Ephemerer HTTP-Server auf localhost:PORT fuer OAuth-Redirect-Capture.
 * RFC 8252 (OAuth 2.0 for Native Apps) — System-Browser + Loopback-Redirect.
 *
 * Lifecycle:
 *   const server = await startLoopbackServer({ pathPrefix: '/oauth/callback' });
 *   console.log(server.url); // http://127.0.0.1:54321/oauth/callback
 *   const params = await server.awaitParams({ timeoutMs: 5 * 60 * 1000 });
 *   server.close();
 *
 * Bindet immer auf 127.0.0.1 (nicht 0.0.0.0) — der OS-Listener ist nur lokal
 * erreichbar, kein Firewall-Prompt unter Windows.
 */

export interface LoopbackServerOptions {
    pathPrefix: string;            // z.B. '/oauth/callback'
    port?: number;                 // 0 = OS waehlt freien Port
    successHtml?: string;          // HTML-Antwort beim Capture
    errorHtml?: string;
}

export interface LoopbackServer {
    readonly url: string;
    awaitParams(opts?: { timeoutMs?: number }): Promise<URLSearchParams>;
    close(): void;
}

const DEFAULT_SUCCESS = `<!doctype html><html><head><meta charset="utf-8"><title>Login erfolgreich</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0e0e10;color:#efeff1;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;padding:2rem 3rem;background:#1f1f23;border-radius:8px}
h1{color:#9146FF;margin:0 0 0.5rem}</style></head>
<body><div class="box"><h1>Login erfolgreich</h1><p>Du kannst dieses Fenster jetzt schließen.</p></div></body></html>`;

const DEFAULT_ERROR = `<!doctype html><html><head><meta charset="utf-8"><title>Fehler</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0e0e10;color:#efeff1;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;padding:2rem 3rem;background:#1f1f23;border-radius:8px}
h1{color:#ff4444;margin:0 0 0.5rem}</style></head>
<body><div class="box"><h1>Fehler</h1><p>Login abgebrochen.</p></div></body></html>`;

export function startLoopbackServer(opts: LoopbackServerOptions): Promise<LoopbackServer> {
    const successHtml = opts.successHtml ?? DEFAULT_SUCCESS;
    const errorHtml = opts.errorHtml ?? DEFAULT_ERROR;
    const pathPrefix = opts.pathPrefix.startsWith('/') ? opts.pathPrefix : '/' + opts.pathPrefix;

    return new Promise((resolve, reject) => {
        let resolveCapture: ((p: URLSearchParams) => void) | null = null;
        let rejectCapture: ((e: Error) => void) | null = null;
        let captureSettled = false;

        const captureP = new Promise<URLSearchParams>((res, rej) => {
            resolveCapture = res;
            rejectCapture = rej;
        });

        const server = http.createServer((req, res) => {
            try {
                const url = new URL(req.url || '/', 'http://127.0.0.1');
                if (!url.pathname.startsWith(pathPrefix)) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('not found');
                    return;
                }
                const params = url.searchParams;
                const hasError = params.has('error');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(hasError ? errorHtml : successHtml);
                if (!captureSettled && resolveCapture) {
                    captureSettled = true;
                    resolveCapture(params);
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('internal error');
                if (!captureSettled && rejectCapture) {
                    captureSettled = true;
                    rejectCapture(e instanceof Error ? e : new Error(String(e)));
                }
            }
        });

        server.on('error', reject);
        server.listen(opts.port ?? 0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                server.close();
                reject(new Error('loopback-server: failed to determine bound port'));
                return;
            }
            const url = `http://127.0.0.1:${addr.port}${pathPrefix}`;

            resolve({
                url,
                async awaitParams(awaitOpts) {
                    const timeoutMs = awaitOpts?.timeoutMs ?? 5 * 60 * 1000;
                    let timer: NodeJS.Timeout | null = null;
                    const timeoutP = new Promise<URLSearchParams>((_, rej) => {
                        timer = setTimeout(() => {
                            if (!captureSettled && rejectCapture) {
                                captureSettled = true;
                                rejectCapture(new Error('loopback-server: timeout waiting for redirect'));
                            }
                            rej(new Error('loopback-server: timeout waiting for redirect'));
                        }, timeoutMs);
                    });
                    try {
                        return await Promise.race([captureP, timeoutP]);
                    } finally {
                        if (timer) clearTimeout(timer);
                    }
                },
                close() {
                    try { server.close(); } catch { /* already closed */ }
                },
            });
        });
    });
}
