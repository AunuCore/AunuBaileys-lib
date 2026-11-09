import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage, WASocket } from '../Types';
export declare class AunuHandler {
    sock: WASocket;
    readonly name: string;
    readonly brand: string;
    constructor(sock: WASocket);
    send(jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions): Promise<WAMessage | undefined>;
    reply(jid: string, content: AnyMessageContent, quoted: WAMessage, options?: MiscMessageGenerationOptions): Promise<WAMessage | undefined>;
    react(jid: string, emoji: string, key: WAMessage['key']): Promise<WAMessage | undefined>;
    newsletterId(jid: string): string;
}
