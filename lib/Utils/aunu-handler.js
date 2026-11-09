/**
 * AunuHandler — lapisan kenyamanan khas AunuBaileys di atas socket.
 * Diekspos sebagai `sock.aunuHandler` dan diekspor sebagai kelas dari paket.
 */
export class AunuHandler {
    constructor(sock) {
        this.sock = sock;
        this.name = 'AunuBaileys';
        this.brand = 'AunuCore Creative Network';
    }
    /** Kirim pesan apa pun (delegate ke sock.sendMessage). */
    async send(jid, content, options) {
        return this.sock.sendMessage(jid, content, options);
    }
    /** Balas sebuah pesan (quote). */
    async reply(jid, content, quoted, options = {}) {
        return this.sock.sendMessage(jid, content, { ...options, quoted });
    }
    /** Beri reaksi emoji ke sebuah pesan. */
    async react(jid, emoji, key) {
        return this.sock.sendMessage(jid, { react: { text: emoji, key } });
    }
    /**
     * Kirim pesan interaktif; otomatis fallback ke teks polos bila
     * perangkat pasangan adalah iOS (tombol tidak tampil andal di sana)
     * atau bila options.forceFallback diaktifkan.
     */
    async sendInteractive(jid, content, options = {}) {
        const platform = this.sock.authState?.creds?.platform;
        if (options.forceFallback || platform === 'ios') {
            const i = content?.interactive || {};
            const text = options.fallbackText || i.text || i.body?.text || '';
            const rest = { ...options };
            delete rest.forceFallback;
            delete rest.fallbackText;
            return this.sock.sendMessage(jid, { text }, rest);
        }
        return this.sock.sendMessage(jid, content, options);
    }
    /** ID numerik dari JID newsletter. */
    newsletterId(jid) {
        return this.sock.newsletterId(jid);
    }
}
