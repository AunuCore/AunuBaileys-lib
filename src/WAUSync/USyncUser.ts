export class USyncUser {
	id?: string
	lid?: string
	phone?: string
	username?: string
	usernameKey?: string
	type?: string
	personaId?: string
	pictureId?: string | number
	verifiedNameSerial?: string
	businessProfileTag?: string
	sidelistDelete?: boolean

	withId(id: string) {
		this.id = id
		return this
	}

	withLid(lid: string) {
		this.lid = lid
		return this
	}

	withPhone(phone: string) {
		this.phone = phone
		return this
	}

	withUsername(username: string) {
		this.username = username
		return this
	}

	withUsernameKey(usernameKey: string) {
		this.usernameKey = usernameKey
		return this
	}

	withType(type: string) {
		this.type = type
		return this
	}

	withPersonaId(personaId: string) {
		this.personaId = personaId
		return this
	}

	// AunuBaileys (1.0.71): username / picture / business fields the new
	// USync protocols read (donor: violetix lib/WAUSync/USyncUser.js)
	/** currently-known profile picture id, so the server can skip unchanged pictures */
	withPictureId(pictureId: string | number) {
		this.pictureId = pictureId
		return this
	}

	withVerifiedNameSerial(verifiedNameSerial: string) {
		this.verifiedNameSerial = verifiedNameSerial
		return this
	}

	withBusinessProfileTag(businessProfileTag: string) {
		this.businessProfileTag = businessProfileTag
		return this
	}

	withSidelistDelete(sidelistDelete = true) {
		this.sidelistDelete = sidelistDelete
		return this
	}
}
