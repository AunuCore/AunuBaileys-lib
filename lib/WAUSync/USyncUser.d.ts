export declare class USyncUser {
    id?: string;
    lid?: string;
    phone?: string;
    username?: string;
    usernameKey?: string;
    type?: string;
    personaId?: string;
    pictureId?: string | number;
    verifiedNameSerial?: string;
    businessProfileTag?: string;
    sidelistDelete?: boolean;
    withId(id: string): this;
    withLid(lid: string): this;
    withPhone(phone: string): this;
    withUsername(username: string): this;
    withUsernameKey(usernameKey: string): this;
    withType(type: string): this;
    withPersonaId(personaId: string): this;
    /** currently-known profile picture id, so the server can skip unchanged pictures */
    withPictureId(pictureId: string | number): this;
    withVerifiedNameSerial(verifiedNameSerial: string): this;
    withBusinessProfileTag(businessProfileTag: string): this;
    withSidelistDelete(sidelistDelete?: boolean): this;
}
//# sourceMappingURL=USyncUser.d.ts.map