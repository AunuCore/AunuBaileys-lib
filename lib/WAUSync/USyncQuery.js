import { getBinaryNodeChild } from '../WABinary/index.js';
import { USyncBotProfileProtocol } from './Protocols/UsyncBotProfileProtocol.js';
import { USyncLIDProtocol } from './Protocols/UsyncLIDProtocol.js';
import { USyncBusinessProtocol, USyncContactProtocol, USyncDeviceProtocol, USyncDisappearingModeProtocol, USyncFeatureProtocol, USyncPictureProtocol, USyncSidelistProtocol, USyncStatusProtocol, USyncTextStatusProtocol, USyncUsernameProtocol } from './Protocols/index.js';
import { USyncUser } from './USyncUser.js';
export class USyncQuery {
    constructor() {
        this.protocols = [];
        this.users = [];
        this.context = 'interactive';
        this.mode = 'query';
    }
    withMode(mode) {
        this.mode = mode;
        return this;
    }
    withContext(context) {
        this.context = context;
        return this;
    }
    withUser(user) {
        this.users.push(user);
        return this;
    }
    parseUSyncQueryResult(result) {
        if (result?.attrs.type !== 'result') {
            return;
        }
        const protocolMap = Object.fromEntries(this.protocols.map(protocol => {
            return [protocol.name, protocol.parser];
        }));
        const queryResult = {
            errors: {},
            refresh: {},
            list: [],
            sideList: []
        };
        const usyncNode = getBinaryNodeChild(result, 'usync');
        // AunuBaileys (1.0.71): each protocol's result child can carry
        // either an <error code text backoff/> (caller should back off
        // future queries for that protocol) or a refresh="n" attr (caller
        // may cache the response for n seconds).
        const resultNode = usyncNode ? getBinaryNodeChild(usyncNode, 'result') : undefined;
        if (resultNode) {
            for (const protocol of this.protocols) {
                const protocolNode = getBinaryNodeChild(resultNode, protocol.name);
                if (!protocolNode) {
                    continue;
                }
                const errorNode = getBinaryNodeChild(protocolNode, 'error');
                if (errorNode) {
                    queryResult.errors[protocol.name] = {
                        errorCode: errorNode.attrs.code ? +errorNode.attrs.code : undefined,
                        errorText: errorNode.attrs.text,
                        errorBackoff: errorNode.attrs.backoff ? +errorNode.attrs.backoff : undefined
                    };
                }
                else if (protocolNode.attrs.refresh !== undefined) {
                    queryResult.refresh[protocol.name] = +protocolNode.attrs.refresh;
                }
            }
        }
        const parseUserNodes = (nodes) => nodes.reduce((acc, node) => {
            const id = node?.attrs.jid;
            // a username lookup answered without a jid means the server
            // wants the 4-digit username key before it reveals the
            // account; keep the row so callers can see that
            const keyRequired = !id && !!getBinaryNodeChild(node, 'contact')?.attrs?.username;
            if (id || keyRequired) {
                // a user-level error attr means the contact has blocked
                // us; WA uses 401/403/405 on the <user> node in that case
                const userErrorCode = node?.attrs?.error ? parseInt(node.attrs.error, 10) : 0;
                const isBlockedByAttr = userErrorCode === 401 || userErrorCode === 403 || userErrorCode === 405;
                const data = Array.isArray(node?.content)
                    ? Object.fromEntries(node.content
                        .map(content => {
                        const protocol = content.tag;
                        // per-contact privacy token, sent either as child
                        // nodes or inline attrs
                        if (protocol === 'privacy') {
                            const tokenNode = getBinaryNodeChild(content, 'token');
                            const modeTsNode = getBinaryNodeChild(content, 'mode_ts');
                            const tokenVal = tokenNode?.content || content.attrs?.token;
                            const modeTsVal = modeTsNode?.content?.toString?.() ||
                                modeTsNode?.attrs?.value ||
                                content.attrs?.mode_ts ||
                                null;
                            if (tokenVal) {
                                return [
                                    'privacy',
                                    {
                                        token: Buffer.isBuffer(tokenVal) || tokenVal instanceof Uint8Array
                                            ? Buffer.from(tokenVal)
                                            : tokenVal,
                                        modeTs: modeTsVal
                                    }
                                ];
                            }
                            return ['privacy', null];
                        }
                        const parser = protocolMap[protocol];
                        if (parser) {
                            try {
                                return [protocol, parser(content)];
                            }
                            catch (err) {
                                // a blocked-code parser error should surface
                                // as a flag, not crash the query
                                const errCode = err?.data ?? err?.output?.payload?.data;
                                if (errCode === 401 || errCode === 403 || errCode === 405) {
                                    return ['isBlockedByContact', true];
                                }
                                // AunuBaileys (1.0.87, HB-175): any
                                // OTHER per-user parser error — the
                                // protocol node carried an <error>
                                // child with e.g. a 404 — used to be
                                // rethrown, aborting the parse of
                                // the ENTIRE batch: one user's error
                                // cost every other user's devices /
                                // contacts, and downstream sends that
                                // depend on the device list failed
                                // outright. Treat it the way the
                                // business parser treats an error
                                // child: this user simply has no data
                                // for this protocol (the null is
                                // dropped by the filter below); the
                                // rest of the batch continues.
                                return [protocol, null];
                            }
                        }
                        else {
                            return [protocol, null];
                        }
                    })
                        .filter(([, b]) => b !== null))
                    : {};
                if (isBlockedByAttr) {
                    data.isBlockedByContact = true;
                }
                acc.push({ ...data, id, ...(keyRequired ? { keyRequired: true } : {}) });
            }
            return acc;
        }, []);
        const listNode = usyncNode ? getBinaryNodeChild(usyncNode, 'list') : undefined;
        if (listNode?.content && Array.isArray(listNode.content)) {
            queryResult.list = parseUserNodes(listNode.content);
        }
        const sideListNode = usyncNode ? getBinaryNodeChild(usyncNode, 'side_list') : undefined;
        if (sideListNode?.content && Array.isArray(sideListNode.content)) {
            queryResult.sideList = parseUserNodes(sideListNode.content);
        }
        return queryResult;
    }
    withDeviceProtocol() {
        this.protocols.push(new USyncDeviceProtocol());
        return this;
    }
    withContactProtocol(addressingMode) {
        this.protocols.push(new USyncContactProtocol(addressingMode));
        return this;
    }
    withUsernameProtocol() {
        this.protocols.push(new USyncUsernameProtocol());
        return this;
    }
    withBusinessProtocol(profileVersion) {
        this.protocols.push(new USyncBusinessProtocol(profileVersion));
        return this;
    }
    /** @param type 'image' for full resolution, 'preview' for a thumbnail */
    withPictureProtocol(type) {
        this.protocols.push(new USyncPictureProtocol(type));
        return this;
    }
    withTextStatusProtocol() {
        this.protocols.push(new USyncTextStatusProtocol());
        return this;
    }
    /** alias: the text-status protocol is the contact's "about" */
    withAboutProtocol() {
        return this.withTextStatusProtocol();
    }
    withSidelistProtocol(useLidAddressing) {
        this.protocols.push(new USyncSidelistProtocol(useLidAddressing));
        return this;
    }
    /** alias for the 'side_list' spelling used in result nodes */
    withSideListProtocol(useLidAddressing) {
        return this.withSidelistProtocol(useLidAddressing);
    }
    withFeatureProtocol(features) {
        this.protocols.push(new USyncFeatureProtocol(features));
        return this;
    }
    withStatusProtocol() {
        this.protocols.push(new USyncStatusProtocol());
        return this;
    }
    withDisappearingModeProtocol() {
        this.protocols.push(new USyncDisappearingModeProtocol());
        return this;
    }
    withBotProfileProtocol() {
        this.protocols.push(new USyncBotProfileProtocol());
        return this;
    }
    withLIDProtocol() {
        this.protocols.push(new USyncLIDProtocol());
        return this;
    }
}
//# sourceMappingURL=USyncQuery.js.map