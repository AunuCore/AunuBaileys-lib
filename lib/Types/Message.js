import { waproto } from '../../WAProto/index.js';
// export the WAMessage Prototypes
export { waproto as WAProto };
export const WAMessageStubType = waproto.WebMessageInfo.StubType;
export const WAMessageStatus = waproto.WebMessageInfo.Status;
export var WAMessageAddressingMode;
(function (WAMessageAddressingMode) {
    WAMessageAddressingMode["PN"] = "pn";
    WAMessageAddressingMode["LID"] = "lid";
})(WAMessageAddressingMode || (WAMessageAddressingMode = {}));
//# sourceMappingURL=Message.js.map