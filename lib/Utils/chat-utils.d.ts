import { waproto } from '../../WAProto/index.js';
import type { BaileysEventEmitter, ChatModification, ChatMutation, Contact, InitialAppStateSyncOptions, LTHashState, WAPatchCreate, WAPatchName } from '../Types/index.js';
import { type BinaryNode } from '../WABinary/index.js';
import type { ILogger } from './logger.js';
type FetchAppStateSyncKey = (keyId: string) => Promise<waproto.Message.IAppStateSyncKeyData | null | undefined>;
export type ChatMutationMap = {
    [index: string]: ChatMutation;
};
type Mac = {
    indexMac: Uint8Array;
    valueMac: Uint8Array;
    operation: waproto.SyncdMutation.SyncdOperation;
};
export declare const makeLtHashGenerator: ({ indexValueMap, hash }: Pick<LTHashState, "hash" | "indexValueMap">) => {
    mix: ({ indexMac, valueMac, operation }: Mac) => void;
    finish: () => {
        hash: Buffer<ArrayBuffer>;
        indexValueMap: {
            [indexMacBase64: string]: {
                valueMac: Uint8Array | Buffer;
            };
        };
    };
};
export declare const newLTHashState: () => LTHashState;
export declare const ensureLTHashStateVersion: (state: LTHashState) => LTHashState;
export declare const MAX_SYNC_ATTEMPTS = 2;
/**
 * Check if an error is a missing app state sync key.
 * WA Web treats these as "Blocked" (waits for key arrival), not fatal.
 * In Baileys we retry with a snapshot which may use a different key.
 */
export declare const isMissingKeyError: (error: any) => boolean;
/**
 * Determines if an app state sync error is unrecoverable.
 * TypeError indicates a WASM crash; otherwise we give up after MAX_SYNC_ATTEMPTS.
 * Missing keys are NOT checked here — they are handled separately as "Blocked".
 */
export declare const isAppStateSyncIrrecoverable: (error: any, attempts: number) => boolean;
export declare const encodeSyncdPatch: ({ type, index, syncAction, apiVersion, operation }: WAPatchCreate, myAppStateKeyId: string, state: LTHashState, getAppStateSyncKey: FetchAppStateSyncKey) => Promise<{
    patch: waproto.ISyncdPatch;
    state: LTHashState;
}>;
export declare const decodeSyncdMutations: (msgMutations: (waproto.ISyncdMutation | waproto.ISyncdRecord)[], initialState: LTHashState, getAppStateSyncKey: FetchAppStateSyncKey, onMutation: (mutation: ChatMutation) => void, validateMacs: boolean) => Promise<{
    hash: Buffer<ArrayBuffer>;
    indexValueMap: {
        [indexMacBase64: string]: {
            valueMac: Uint8Array | Buffer;
        };
    };
}>;
export declare const decodeSyncdPatch: (msg: waproto.ISyncdPatch, name: WAPatchName, initialState: LTHashState, getAppStateSyncKey: FetchAppStateSyncKey, onMutation: (mutation: ChatMutation) => void, validateMacs: boolean) => Promise<{
    hash: Buffer<ArrayBuffer>;
    indexValueMap: {
        [indexMacBase64: string]: {
            valueMac: Uint8Array | Buffer;
        };
    };
}>;
export declare const extractSyncdPatches: (result: BinaryNode, options: RequestInit) => Promise<{
    critical_unblock_low: {
        patches: waproto.ISyncdPatch[];
        hasMorePatches: boolean;
        snapshot?: waproto.ISyncdSnapshot;
    };
    regular_high: {
        patches: waproto.ISyncdPatch[];
        hasMorePatches: boolean;
        snapshot?: waproto.ISyncdSnapshot;
    };
    regular_low: {
        patches: waproto.ISyncdPatch[];
        hasMorePatches: boolean;
        snapshot?: waproto.ISyncdSnapshot;
    };
    critical_block: {
        patches: waproto.ISyncdPatch[];
        hasMorePatches: boolean;
        snapshot?: waproto.ISyncdSnapshot;
    };
    regular: {
        patches: waproto.ISyncdPatch[];
        hasMorePatches: boolean;
        snapshot?: waproto.ISyncdSnapshot;
    };
}>;
export declare const downloadExternalBlob: (blob: waproto.IExternalBlobReference, options: RequestInit) => Promise<Buffer<ArrayBuffer>>;
export declare const downloadExternalPatch: (blob: waproto.IExternalBlobReference, options: RequestInit) => Promise<waproto.SyncdMutations>;
export declare const decodeSyncdSnapshot: (name: WAPatchName, snapshot: waproto.ISyncdSnapshot, getAppStateSyncKey: FetchAppStateSyncKey, minimumVersionNumber: number | undefined, validateMacs?: boolean, logger?: ILogger) => Promise<{
    state: LTHashState;
    mutationMap: ChatMutationMap;
}>;
export declare const decodePatches: (name: WAPatchName, syncds: waproto.ISyncdPatch[], initial: LTHashState, getAppStateSyncKey: FetchAppStateSyncKey, options: RequestInit, minimumVersionNumber?: number, logger?: ILogger, validateMacs?: boolean) => Promise<{
    state: LTHashState;
    mutationMap: ChatMutationMap;
}>;
export declare const chatModificationToAppPatch: (mod: ChatModification, jid: string) => WAPatchCreate;
export declare const processSyncAction: (syncAction: ChatMutation, ev: BaileysEventEmitter, me: Contact, initialSyncOpts?: InitialAppStateSyncOptions, logger?: ILogger) => void;
export {};
//# sourceMappingURL=chat-utils.d.ts.map