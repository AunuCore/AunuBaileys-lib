/** Known integrator IDs (assigned by WhatsApp). */
export declare const INTEGRATOR_BIRDYCHAT = 12;
export declare const INTEGRATOR_HAIKET = 13;
/** True when the JID is an interop address (server 'interop'). */
export declare const isInteropJid: (jid: any) => boolean;
/**
 * Parse an interop JID into { integratorId, externalId, device, server }.
 * Returns null for non-interop JIDs. integratorId 12 = BirdyChat,
 * 13 = Haiket; externalId is the email (BirdyChat) or phone string (Haiket).
 */
export declare const parseInteropJid: (jid: any) => {
    integratorId: number;
    externalId: string | undefined;
    device: number;
    server: string;
} | null;
export declare const makeInteropSocket: (sock: any) => any;
//# sourceMappingURL=interop.d.ts.map