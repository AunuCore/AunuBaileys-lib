export class USyncUser {
    withId(id) {
        this.id = id;
        return this;
    }
    withLid(lid) {
        this.lid = lid;
        return this;
    }
    withPhone(phone) {
        this.phone = phone;
        return this;
    }
    withType(type) {
        this.type = type;
        return this;
    }
    withPersonaId(personaId) {
        this.personaId = personaId;
        return this;
    }
    // AunuBaileys (1.0.71): username / picture / business fields the new
    // USync protocols read (donor: violetix lib/WAUSync/USyncUser.js)
    withUsername(username) {
        this.username = username;
        return this;
    }
    withUsernameKey(usernameKey) {
        this.usernameKey = usernameKey;
        return this;
    }
    /** currently-known profile picture id, so the server can skip unchanged pictures */
    withPictureId(pictureId) {
        this.pictureId = pictureId;
        return this;
    }
    withVerifiedNameSerial(verifiedNameSerial) {
        this.verifiedNameSerial = verifiedNameSerial;
        return this;
    }
    withBusinessProfileTag(businessProfileTag) {
        this.businessProfileTag = businessProfileTag;
        return this;
    }
    withSidelistDelete(sidelistDelete = true) {
        this.sidelistDelete = sidelistDelete;
        return this;
    }
}
//# sourceMappingURL=USyncUser.js.map