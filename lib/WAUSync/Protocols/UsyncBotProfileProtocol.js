import { getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildString } from '../../WABinary/index.js';
import { USyncUser } from '../USyncUser.js';
export class USyncBotProfileProtocol {
    constructor() {
        this.name = 'bot';
    }
    getQueryElement() {
        return {
            tag: 'bot',
            attrs: {},
            content: [{ tag: 'profile', attrs: { v: '1' } }]
        };
    }
    getUserElement(user) {
        return {
            tag: 'bot',
            attrs: {},
            content: [{ tag: 'profile', attrs: { persona_id: user.personaId } }]
        };
    }
    parser(node) {
        // AunuBaileys (2.3.0, HB-402): parseUSyncQueryResult hands
        // this parser the <bot> node ITSELF, but the parser searched
        // for a child 'bot' inside it — always undefined, so every
        // public withBotProfileProtocol() query died with a
        // TypeError. Read <profile> directly from the node received;
        // a bot without a public profile gets an empty <bot/> back,
        // which is a null result, not an error.
        const profile = getBinaryNodeChild(node, 'profile');
        if (!profile) {
            return null;
        }
        const commandsNode = getBinaryNodeChild(profile, 'commands');
        const promptsNode = getBinaryNodeChild(profile, 'prompts');
        const commands = [];
        const prompts = [];
        for (const command of getBinaryNodeChildren(commandsNode, 'command')) {
            commands.push({
                name: getBinaryNodeChildString(command, 'name'),
                description: getBinaryNodeChildString(command, 'description')
            });
        }
        for (const prompt of getBinaryNodeChildren(promptsNode, 'prompt')) {
            prompts.push(`${getBinaryNodeChildString(prompt, 'emoji')} ${getBinaryNodeChildString(prompt, 'text')}`);
        }
        return {
            isDefault: !!getBinaryNodeChild(profile, 'default'),
            jid: node.attrs.jid,
            name: getBinaryNodeChildString(profile, 'name'),
            attributes: getBinaryNodeChildString(profile, 'attributes'),
            description: getBinaryNodeChildString(profile, 'description'),
            category: getBinaryNodeChildString(profile, 'category'),
            personaId: profile.attrs['persona_id'],
            commandsDescription: getBinaryNodeChildString(commandsNode, 'description'),
            commands,
            prompts
        };
    }
}
//# sourceMappingURL=UsyncBotProfileProtocol.js.map