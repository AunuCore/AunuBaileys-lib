/**
 * AunuHandler — lapisan kenyamanan khas AunuBaileys di atas socket.
 * Diekspos sebagai `sock.aunuHandler` dan diekspor sebagai kelas dari paket.
 */
export declare class AunuHandler {
    constructor(sock: any);
    /** Kirim pesan apa pun (delegate ke sock.sendMessage). */
    send(jid: any, content: any, options: any): Promise<any>;
    /** Balas sebuah pesan (quote). */
    reply(jid: any, content: any, quoted: any, options?: {}): Promise<any>;
    /** Beri reaksi emoji ke sebuah pesan. */
    react(jid: any, emoji: any, key: any): Promise<any>;
    /**
     * Kirim pesan interaktif; otomatis fallback ke teks polos bila
     * perangkat pasangan adalah iOS (tombol tidak tampil andal di sana)
     * atau bila options.forceFallback diaktifkan.
     */
    sendInteractive(jid: any, content: any, options?: {}): Promise<any>;
    /** ID numerik dari JID newsletter. */
    newsletterId(jid: any): any;
}
//# sourceMappingURL=aunu-handler.d.ts.map