import makeWASocket from './Socket/index'

export * from '../WAProto/index.js'
export * from './Utils/index'
export * from './Types/index'
export * from './Defaults/index'
export * from './WABinary/index'
export * from './WAM/index'
export * from './WAUSync/index'

export type WASocket = ReturnType<typeof makeWASocket>
export { makeWASocket }
export default makeWASocket
export * from './Store/index'
export * from './Utils/builders'
export { processedMessages, initInMemoryKeyStore } from './Utils/fork-compat'
export { PHONENUMBER_MCC } from './Utils/phonenumber-mcc'
export * from './Utils/antiban'
export * from './Utils/lid-store'
export * from './Utils/sent-message-cache'
export * from './Utils/aunu-handler'
