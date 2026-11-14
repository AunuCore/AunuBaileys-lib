import { assertNodeErrorFree, getBinaryNodeChild } from '../../WABinary/index.js';
export class USyncDeviceProtocol {
    constructor() {
        this.name = 'devices';
    }
    getQueryElement() {
        return {
            tag: 'devices',
            attrs: {
                version: '2'
            }
        };
    }
    getUserElement( /* user: USyncUser */) {
        //TODO: Implement device phashing, ts and expectedTs
        //TODO: if all are not present, return null <- current behavior
        //TODO: otherwise return a node w tag 'devices' w those as attrs
        return null;
    }
    parser(node) {
        const deviceList = [];
        let keyIndex = undefined;
        if (node.tag === 'devices') {
            assertNodeErrorFree(node);
            const deviceListNode = getBinaryNodeChild(node, 'device-list');
            const keyIndexNode = getBinaryNodeChild(node, 'key-index-list');
            if (Array.isArray(deviceListNode?.content)) {
                for (const { tag, attrs } of deviceListNode.content) {
                    if (tag !== 'device') {
                        continue;
                    }
                    // AunuBaileys (HB-272, P4): a <device> without an id
                    // attribute parsed as NaN, and extractDeviceJids'
                    // keyIndex clause let it through — jidEncode then
                    // dropped the device suffix entirely, collapsing
                    // the entry onto the bare (device 0) JID at send
                    // time. A device with no finite id does not exist.
                    const id = +attrs.id;
                    if (!Number.isFinite(id)) {
                        continue;
                    }
                    const keyIndex = +attrs['key-index'];
                    deviceList.push({
                        id,
                        keyIndex,
                        isHosted: !!(attrs['is_hosted'] && attrs['is_hosted'] === 'true')
                    });
                }
            }
            if (keyIndexNode?.tag === 'key-index-list') {
                keyIndex = {
                    timestamp: +keyIndexNode.attrs['ts'],
                    signedKeyIndex: keyIndexNode?.content,
                    expectedTimestamp: keyIndexNode.attrs['expected_ts'] ? +keyIndexNode.attrs['expected_ts'] : undefined
                };
            }
        }
        return {
            deviceList,
            keyIndex
        };
    }
}
//# sourceMappingURL=USyncDeviceProtocol.js.map