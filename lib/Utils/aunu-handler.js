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
    /** ID numerik dari JID newsletter. */
    newsletterId(jid) {
        return this.sock.newsletterId(jid);
    }
}
