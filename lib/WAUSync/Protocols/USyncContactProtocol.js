import { assertNodeErrorFree } from '../../WABinary/index.js';
import { USyncUser } from '../USyncUser.js';
export class USyncContactProtocol {
    // AunuBaileys (1.0.71): addressingMode + username branches (donor:
    // violetix lib/WAUSync/Protocols/USyncContactProtocol.js). Username
    // lookups are LID-addressed, so onWhatsAppUsername passes 'lid'.
    constructor(addressingMode) {
        this.name = 'contact';
        this.addressingMode = addressingMode;
    }
    getQueryElement() {
        return {
            tag: 'contact',
            attrs: this.addressingMode ? { addressing_mode: this.addressingMode } : {}
        };
    }
    getUserElement(user) {
        if (user.phone) {
            return {
                tag: 'contact',
                attrs: {},
                content: user.phone
            };
        }
        if (user.username) {
            return {
                tag: 'contact',
                attrs: {
                    username: user.username,
                    ...(user.usernameKey ? { pin: user.usernameKey } : {}),
                    ...(user.lid ? { lid: user.lid } : {})
                }
            };
        }
        if (user.type) {
            return {
                tag: 'contact',
                attrs: {
                    type: user.type
                }
            };
        }
        return {
            tag: 'contact',
            attrs: {}
        };
    }
    parser(node) {
        if (node.tag === 'contact') {
            assertNodeErrorFree(node);
            return node?.attrs?.type === 'in';
        }
        return false;
    }
}
//# sourceMappingURL=USyncContactProtocol.js.map