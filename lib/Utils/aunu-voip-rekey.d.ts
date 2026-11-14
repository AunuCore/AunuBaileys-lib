/**
 * Decode an E2E VoIP rekey payload buffer into a structured object.
 * @param {Buffer|Uint8Array} buffer raw bytes of proto.E2eRekeyPayload
 * @returns {{ keys: Array<{ type: string|number, key: Buffer }> }}
 */
export declare const decodeAunuE2eRekeyPayload: (buffer: any) => {
    keys: {
        type: any;
        key: Buffer<ArrayBuffer>;
    }[];
};
//# sourceMappingURL=aunu-voip-rekey.d.ts.map