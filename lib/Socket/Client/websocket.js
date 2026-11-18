import WebSocket from 'ws';
import { DEFAULT_ORIGIN } from '../../Defaults/index.js';
import { AbstractSocketClient } from './types.js';
export class WebSocketClient extends AbstractSocketClient {
    constructor() {
        super(...arguments);
        this.socket = null;
    }
    get isOpen() {
        return this.socket?.readyState === WebSocket.OPEN;
    }
    get isClosed() {
        return this.socket === null || this.socket?.readyState === WebSocket.CLOSED;
    }
    get isClosing() {
        return this.socket === null || this.socket?.readyState === WebSocket.CLOSING;
    }
    get isConnecting() {
        return this.socket?.readyState === WebSocket.CONNECTING;
    }
    connect() {
        if (this.socket) {
            return;
        }
        this.socket = new WebSocket(this.url, {
            origin: DEFAULT_ORIGIN,
            headers: this.config.options?.headers,
            handshakeTimeout: this.config.connectTimeoutMs,
            timeout: this.config.connectTimeoutMs,
            agent: this.config.agent
        });
        this.socket.setMaxListeners(0);
        const events = ['close', 'error', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response'];
        for (const event of events) {
            this.socket?.on(event, (...args) => this.emit(event, ...args));
        }
    }
    async close() {
        if (!this.socket) {
            return;
        }
        const socket = this.socket;
        // AunuBaileys (2.2.0, HB-341): the close handshake waits for the
        // peer's close frame — a peer that black-holes it (exactly the
        // dead-peer paths that call end()) stalled the caller for the
        // full ws closeTimeout (30s) before connection.update: close
        // could be emitted. Give the handshake a short grace, then
        // force the transport down and settle anyway.
        await new Promise(resolve => {
            const timer = setTimeout(() => {
                try {
                    socket.terminate();
                }
                catch { }
                resolve();
            }, 5000);
            timer.unref?.();
            socket.once('close', () => {
                clearTimeout(timer);
                resolve();
            });
            socket.close();
        });
        this.socket = null;
    }
    send(str, cb) {
        // AunuBaileys (HB-280, P4): a send against a nulled socket
        // used to swallow the callback entirely — `this.socket?.send`
        // no-ops when the socket is gone, so the promisified caller
        // in sendRawMessage only settled via its connectTimeoutMs
        // timeout with a misleading 408 'Timed Out'. Call the
        // callback back with an error, like the underlying ws library
        // does for a non-open socket, so the send fails at once.
        if (!this.socket) {
            cb?.(new Error('Connection Closed'));
            return false;
        }
        this.socket.send(str, cb);
        return true;
    }
}
//# sourceMappingURL=websocket.js.map