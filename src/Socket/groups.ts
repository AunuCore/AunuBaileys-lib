import { Boom } from '@hapi/boom'
import { waproto } from '../../WAProto/index.js'
import type { GroupMetadata, GroupParticipant, ParticipantAction, SocketConfig, WAMessageKey } from '../Types'
import { WAMessageAddressingMode, WAMessageStubType } from '../Types'
import { generateMessageIDV2, unixTimestampSeconds } from '../Utils'
import {
	type BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	getBinaryNodeChildString,
	isLidUser,
	isPnUser,
	jidEncode,
	jidNormalizedUser
} from '../WABinary'
import { makeChatsSocket } from './chats'

export const makeGroupsSocket = (config: SocketConfig) => {
	const { logger } = config
	const sock = makeChatsSocket(config)
	const { authState, ev, query, upsertMessage, signalRepository } = sock

	const groupQuery = async (jid: string, type: 'get' | 'set', content: BinaryNode[]) =>
		query({
			tag: 'iq',
			attrs: {
				type,
				xmlns: 'w:g2',
				to: jid
			},
			content
		})

	// AunuBaileys (2.8.0, D-1104-A): harvest the server-authoritative
	// LID<->PN pairs extractGroupMetadata already yields on every
	// participant (phoneNumber when the id is a LID, lid when the id
	// is a PN) into the LID mapping store — the pairs used to be
	// discarded, so every mapping had to be re-learned via USync.
	// Best-effort by design: a harvest failure must never fail the
	// metadata fetch it rides on.
	const harvestParticipantLidMappings = (meta: GroupMetadata) => {
		try {
			const pairs = collectGroupLidPnPairs(meta)
			if (!pairs.length) {
				return
			}

			void Promise.resolve(signalRepository.lidMapping.storeLIDPNMappings(pairs)).catch(err => {
				logger.debug({ err, groupId: meta.id }, 'failed to harvest LID/PN mappings from group metadata')
			})
		} catch (err) {
			logger.debug({ err, groupId: meta.id }, 'failed to harvest LID/PN mappings from group metadata')
		}
	}

	const groupMetadata = async (jid: string) => {
		const result = await groupQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }])
		const meta = extractGroupMetadata(result)
		harvestParticipantLidMappings(meta)
		return meta
	}

	const groupFetchAllParticipating = async () => {
		const result = await query({
			tag: 'iq',
			attrs: {
				to: '@g.us',
				xmlns: 'w:g2',
				type: 'get'
			},
			content: [
				{
					tag: 'participating',
					attrs: {},
					content: [
						{ tag: 'participants', attrs: {} },
						{ tag: 'description', attrs: {} }
					]
				}
			]
		})
		// AunuBaileys (2.7.0, HB-435 addendum facet 2): a get-IQ
		// timeout resolves query() as undefined (HB-340 contract) —
		// the old code fabricated an empty success from it: resolved
		// {} AND emitted groups.update [], wiping consumers' group
		// state. Mirror the set-IQ timeout path: fail with Boom 408.
		if (!result) {
			throw new Boom('groupFetchAllParticipating timed out waiting for the IQ response', { statusCode: 408 })
		}

		const data: { [_: string]: GroupMetadata } = {}
		const groupsChild = getBinaryNodeChild(result, 'groups')
		// AunuBaileys (2.8.0, HB-435 addendum facet 4): a bare result
		// IQ with NO <groups> child at all used to fabricate an empty
		// success ({} + groups.update []) — the same fabrication the
		// facet-2 timeout guard removed. A present-but-empty
		// <groups/> is a legitimate empty list and stays a success.
		if (!groupsChild) {
			throw new Boom('groupFetchAllParticipating received an IQ result without a <groups> node', { statusCode: 502 })
		}

		if (groupsChild) {
			const groups = getBinaryNodeChildren(groupsChild, 'group')
			for (const groupNode of groups) {
				// AunuBaileys (2.1.0, HB-126): isolate per-node failures — one malformed group node must not kill the whole fetch.
				try {
					const meta = extractGroupMetadata({
						tag: 'result',
						attrs: {},
						content: [groupNode]
					})
					harvestParticipantLidMappings(meta)
					data[meta.id] = meta
				} catch (err) {
					logger.warn({ err, groupNode }, 'skipping malformed group in groupFetchAllParticipating')
				}
			}
		}

		// TODO: properly parse LID / PN DATA
		sock.ev.emit('groups.update', Object.values(data))

		return data
	}

	sock.ws.on('CB:ib,,dirty', async (node: BinaryNode) => {
		// AunuBaileys (HB-287, donor v6 HB-2026-1112-4): a rejected
		// fetch/cleanDirtyBits here (e.g. the socket closes mid-sync)
		// used to be an unhandled rejection = process crash.
		try {
			const { attrs } = getBinaryNodeChild(node, 'dirty')!
			if (attrs.type !== 'groups') {
				return
			}

			await groupFetchAllParticipating()
			await sock.cleanDirtyBits('groups')
		} catch (err) {
			sock.onUnexpectedError(err as Error, 'dirty bits (groups)')
		}
	})

	return {
		...sock,
		groupMetadata,
		groupCreate: async (subject: string, participants: string[]) => {
			const key = generateMessageIDV2()
			const result = await groupQuery('@g.us', 'set', [
				{
					tag: 'create',
					attrs: {
						subject,
						key
					},
					content: participants.map(jid => ({
						tag: 'participant',
						attrs: { jid }
					}))
				}
			])
			const meta = extractGroupMetadata(result)
			harvestParticipantLidMappings(meta)
			return meta
		},
		groupLeave: async (id: string) => {
			await groupQuery('@g.us', 'set', [
				{
					tag: 'leave',
					attrs: {},
					content: [{ tag: 'group', attrs: { id } }]
				}
			])
		},
		groupUpdateSubject: async (jid: string, subject: string) => {
			await groupQuery(jid, 'set', [
				{
					tag: 'subject',
					attrs: {},
					content: Buffer.from(subject, 'utf-8')
				}
			])
		},
		groupRequestParticipantsList: async (jid: string) => {
			const result = await groupQuery(jid, 'get', [
				{
					tag: 'membership_approval_requests',
					attrs: {}
				}
			])
			const node = getBinaryNodeChild(result, 'membership_approval_requests')
			const participants = getBinaryNodeChildren(node, 'membership_approval_request')
			return participants.map(v => v.attrs)
		},
		groupRequestParticipantsUpdate: async (jid: string, participants: string[], action: 'approve' | 'reject') => {
			const result = await groupQuery(jid, 'set', [
				{
					tag: 'membership_requests_action',
					attrs: {},
					content: [
						{
							tag: action,
							attrs: {},
							content: participants.map(jid => ({
								tag: 'participant',
								attrs: { jid }
							}))
						}
					]
				}
			])
			const node = getBinaryNodeChild(result, 'membership_requests_action')
			const nodeAction = getBinaryNodeChild(node, action)
			const participantsAffected = getBinaryNodeChildren(nodeAction, 'participant')
			return participantsAffected.map(p => {
				return { status: p.attrs.error || '200', jid: p.attrs.jid }
			})
		},
		groupParticipantsUpdate: async (jid: string, participants: string[], action: ParticipantAction) => {
			const result = await groupQuery(jid, 'set', [
				{
					tag: action,
					attrs: {},
					content: participants.map(jid => ({
						tag: 'participant',
						attrs: { jid }
					}))
				}
			])
			const node = getBinaryNodeChild(result, action)
			const participantsAffected = getBinaryNodeChildren(node, 'participant')
			return participantsAffected.map(p => {
				return { status: p.attrs.error || '200', jid: p.attrs.jid, content: p }
			})
		},
		groupUpdateDescription: async (jid: string, description?: string) => {
			const metadata = await groupMetadata(jid)
			const prev = metadata.descId ?? null

			await groupQuery(jid, 'set', [
				{
					tag: 'description',
					attrs: {
						...(description ? { id: generateMessageIDV2() } : { delete: 'true' }),
						...(prev ? { prev } : {})
					},
					content: description ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }] : undefined
				}
			])
		},
		groupInviteCode: async (jid: string) => {
			const result = await groupQuery(jid, 'get', [{ tag: 'invite', attrs: {} }])
			const inviteNode = getBinaryNodeChild(result, 'invite')
			return inviteNode?.attrs.code
		},
		groupRevokeInvite: async (jid: string) => {
			const result = await groupQuery(jid, 'set', [{ tag: 'invite', attrs: {} }])
			const inviteNode = getBinaryNodeChild(result, 'invite')
			return inviteNode?.attrs.code
		},
		groupAcceptInvite: async (code: string) => {
			const results = await groupQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }])
			const result = getBinaryNodeChild(results, 'group')
			return result?.attrs.jid
		},

		/**
		 * AunuBaileys (2.7.0, Zapo D2): structured variant of
		 * groupAcceptInvite. A group that requires admin approval
		 * answers the invite IQ with a <membership_approval_request>
		 * node instead of a <group> node — groupAcceptInvite returns
		 * undefined for that case, indistinguishable from a malformed
		 * response. This variant reports the outcome explicitly:
		 * { status: 'joined', jid } when the <group> node is present,
		 * { status: 'pending', jid } when the server registered a
		 * membership approval request (jid may be undefined if the
		 * node carries none). groupAcceptInvite is unchanged and
		 * keeps returning string | undefined for existing callers.
		 */
		groupAcceptInviteWithStatus: async (
			code: string
		): Promise<{ status: 'joined' | 'pending'; jid: string | undefined }> => {
			const results = await groupQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }])
			const groupNode = getBinaryNodeChild(results, 'group')
			if (groupNode) {
				return { status: 'joined', jid: groupNode.attrs.jid }
			}

			const approvalNode = getBinaryNodeChild(results, 'membership_approval_request')
			if (approvalNode) {
				return { status: 'pending', jid: approvalNode.attrs.jid }
			}

			throw new Boom('groupAcceptInviteWithStatus: invite response carried neither <group> nor <membership_approval_request>', {
				statusCode: 502,
				data: results
			})
		},

		/**
		 * revoke a v4 invite for someone
		 * @param groupJid group jid
		 * @param invitedJid jid of person you invited
		 * @returns true if successful
		 */
		groupRevokeInviteV4: async (groupJid: string, invitedJid: string) => {
			const result = await groupQuery(groupJid, 'set', [
				{ tag: 'revoke', attrs: {}, content: [{ tag: 'participant', attrs: { jid: invitedJid } }] }
			])
			return !!result
		},

		/**
		 * accept a GroupInviteMessage
		 * @param key the key of the invite message, or optionally only provide the jid of the person who sent the invite
		 * @param inviteMessage the message to accept
		 */
		groupAcceptInviteV4: ev.createBufferedFunction(
			async (key: string | WAMessageKey, inviteMessage: waproto.Message.IGroupInviteMessage) => {
				key = typeof key === 'string' ? { remoteJid: key } : key
				// AunuBaileys (2.1.0, HB-21/22): an invite message missing its fields used to throw a raw TypeError from .toString() — reject it as a caller-visible Boom 400 instead.
				// AunuBaileys (2.2.0, HB-2026-1112-22 addendum 2):
				// the HB-21/22 field guard below destructures FIRST —
				// an undefined/null inviteMessage threw a raw
				// TypeError before the guard could run. Guard the
				// object itself.
				if (!inviteMessage || typeof inviteMessage !== 'object') {
					throw new Boom('groupAcceptInviteV4: invite message is missing groupJid, inviteCode or inviteExpiration', {
						statusCode: 400
					})
				}

				const { groupJid, inviteCode, inviteExpiration } = inviteMessage
				if (!groupJid || !inviteCode || typeof inviteExpiration !== 'number') {
					throw new Boom('groupAcceptInviteV4: invite message is missing groupJid, inviteCode or inviteExpiration', {
						statusCode: 400
					})
				}

				// AunuBaileys (2.6.0, HB-2026-1112-22 addendum 4): a
				// key without remoteJid used to sail through as
				// `admin: undefined` and the encoder silently dropped
				// the attr, so the <accept> IQ went out without the
				// admin the server needs to attribute the accept.
				// A bare string key is normalised to { remoteJid }
				// above, so a missing remoteJid here means the caller
				// passed a key object without one — reject it like
				// the missing-field guard above.
				if (!key.remoteJid) {
					throw new Boom('groupAcceptInviteV4: invite key is missing remoteJid (admin)', {
						statusCode: 400
					})
				}

				const results = await groupQuery(groupJid, 'set', [
					{
						tag: 'accept',
						attrs: {
							code: inviteCode,
							expiration: inviteExpiration.toString(),
							admin: key.remoteJid!
						}
					}
				])

				// if we have the full message key
				// update the invite message to be expired
				if (key.id) {
					// create new invite message that is expired
					inviteMessage = waproto.Message.GroupInviteMessage.fromObject(inviteMessage)
					inviteMessage.inviteExpiration = 0
					inviteMessage.inviteCode = ''
					ev.emit('messages.update', [
						{
							key,
							update: {
								message: {
									groupInviteMessage: inviteMessage
								}
							}
						}
					])
				}

				// generate the group add message
				await upsertMessage(
					{
						key: {
							remoteJid: inviteMessage.groupJid,
							id: generateMessageIDV2(sock.user?.id),
							fromMe: false,
							participant: key.remoteJid
						},
						messageStubType: WAMessageStubType.GROUP_PARTICIPANT_ADD,
						messageStubParameters: [JSON.stringify(authState.creds.me)],
						participant: key.remoteJid,
						messageTimestamp: unixTimestampSeconds()
					},
					'notify'
				)

				return results.attrs.from
			}
		),
		groupGetInviteInfo: async (code: string) => {
			const results = await groupQuery('@g.us', 'get', [{ tag: 'invite', attrs: { code } }])
			return extractGroupMetadata(results)
		},
		groupToggleEphemeral: async (jid: string, ephemeralExpiration: number) => {
			const content: BinaryNode = ephemeralExpiration
				? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } }
				: { tag: 'not_ephemeral', attrs: {} }
			await groupQuery(jid, 'set', [content])
		},
		groupSettingUpdate: async (jid: string, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked') => {
			await groupQuery(jid, 'set', [{ tag: setting, attrs: {} }])
		},
		groupMemberAddMode: async (jid: string, mode: 'admin_add' | 'all_member_add') => {
			await groupQuery(jid, 'set', [{ tag: 'member_add_mode', attrs: {}, content: mode }])
		},
		groupJoinApprovalMode: async (jid: string, mode: 'on' | 'off') => {
			await groupQuery(jid, 'set', [
				{ tag: 'membership_approval_mode', attrs: {}, content: [{ tag: 'group_join', attrs: { state: mode } }] }
			])
		},
		groupFetchAllParticipating
	}
}

/**
 * AunuBaileys (2.8.0, D-1104-A): the LID<->PN pairs a group metadata
 * carries, in the shape storeLIDPNMappings consumes. Pure — the
 * store's own validation still applies to every pair.
 */
export const collectGroupLidPnPairs = (meta: GroupMetadata): { lid: string; pn: string }[] => {
	const pairs: { lid: string; pn: string }[] = []
	for (const participant of meta?.participants || []) {
		if (!participant || typeof participant !== 'object') {
			continue
		}

		if (isLidUser(participant.id) && isPnUser(participant.phoneNumber)) {
			pairs.push({ lid: participant.id, pn: participant.phoneNumber! })
		} else if (isPnUser(participant.id) && isLidUser(participant.lid)) {
			pairs.push({ lid: participant.lid!, pn: participant.id })
		}
	}

	return pairs
}

export const extractGroupMetadata = (result: BinaryNode) => {
	const group = getBinaryNodeChild(result, 'group')
	if (!group) {
		// Mirror WAWeb: surface server/client errors with their code+text instead of crashing.
		const errorNode = getBinaryNodeChild(result, 'error')
		if (errorNode) {
			// AunuBaileys (HB-42 class, re-applied P3): `+attrs.code`
			// is NaN for a non-numeric code and Boom throws on it \u2014
			// keep only a finite HTTP-range code, else 500.
			const rawCode = errorNode.attrs.code ? +errorNode.attrs.code : 500
			const code = Number.isInteger(rawCode) && rawCode >= 400 && rawCode <= 599 ? rawCode : 500
			const text = errorNode.attrs.text || 'group metadata query failed'
			throw new Boom(text, { statusCode: code, data: errorNode })
		}

		throw new Boom('Invalid group metadata response: missing <group> node', { data: result })
	}

	if (!group.attrs.id) {
		throw new Boom('Invalid group metadata response: missing group id', { data: group })
	}

	const descChild = getBinaryNodeChild(group, 'description')
	let desc: string | undefined
	let descId: string | undefined
	let descOwner: string | undefined
	let descOwnerPn: string | undefined
	let descOwnerUsername: string | undefined
	let descTime: number | undefined
	if (descChild) {
		desc = getBinaryNodeChildString(descChild, 'body')
		descOwner = descChild.attrs.participant ? jidNormalizedUser(descChild.attrs.participant) : undefined
		descOwnerPn = descChild.attrs.participant_pn ? jidNormalizedUser(descChild.attrs.participant_pn) : undefined
		descOwnerUsername = descChild.attrs.participant_username || undefined
		descTime = +descChild.attrs.t!
		descId = descChild.attrs.id
	}

	const groupId = group.attrs.id.includes('@') ? group.attrs.id : jidEncode(group.attrs.id, 'g.us')
	const eph = getBinaryNodeChild(group, 'ephemeral')?.attrs.expiration
	const memberAddMode = getBinaryNodeChildString(group, 'member_add_mode') === 'all_member_add'
	const metadata: GroupMetadata = {
		id: groupId,
		notify: group.attrs.notify,
		addressingMode: group.attrs.addressing_mode === 'lid' ? WAMessageAddressingMode.LID : WAMessageAddressingMode.PN,
		subject: group.attrs.subject!,
		subjectOwner: group.attrs.s_o,
		subjectOwnerPn: group.attrs.s_o_pn,
		subjectOwnerUsername: group.attrs.s_o_username,
		subjectTime: +group.attrs.s_t!,
		size: group.attrs.size ? +group.attrs.size : getBinaryNodeChildren(group, 'participant').length,
		creation: +group.attrs.creation!,
		owner: group.attrs.creator ? jidNormalizedUser(group.attrs.creator) : undefined,
		ownerPn: group.attrs.creator_pn ? jidNormalizedUser(group.attrs.creator_pn) : undefined,
		ownerUsername: group.attrs.creator_username || undefined,
		owner_country_code: group.attrs.creator_country_code,
		desc,
		descId,
		descOwner,
		descOwnerPn,
		descOwnerUsername,
		descTime,
		linkedParent: getBinaryNodeChild(group, 'linked_parent')?.attrs.jid || undefined,
		restrict: !!getBinaryNodeChild(group, 'locked'),
		announce: !!getBinaryNodeChild(group, 'announcement'),
		isCommunity: !!getBinaryNodeChild(group, 'parent'),
		isCommunityAnnounce: !!getBinaryNodeChild(group, 'default_sub_group'),
		joinApprovalMode: !!getBinaryNodeChild(group, 'membership_approval_mode'),
		memberAddMode,
		participants: getBinaryNodeChildren(group, 'participant').map(({ attrs }) => {
			// TODO: Store LID MAPPINGS
			return {
				// AunuBaileys (2.1.0, HB-282 facet e + HB-40 addendum): same id fallback as extractCommunityMetadata — a participant stanza carrying only phone_number (or only lid) produced id: undefined, a participant the host cannot address.
				id: (attrs.jid ||
					(attrs.phone_number
						? jidNormalizedUser(
								attrs.phone_number.includes('@')
									? attrs.phone_number
									: attrs.phone_number + '@s.whatsapp.net'
							)
						: attrs.lid) ||
					undefined) as unknown as string,
				phoneNumber: isLidUser(attrs.jid) && isPnUser(attrs.phone_number) ? attrs.phone_number : undefined,
				lid: isPnUser(attrs.jid) && isLidUser(attrs.lid) ? attrs.lid : undefined,
				username: attrs.participant_username || attrs.username || undefined,
				admin: (attrs.type || null) as GroupParticipant['admin']
			}
		}),
		ephemeralDuration: eph ? +eph : undefined
	}
	return metadata
}

export type GroupsSocket = ReturnType<typeof makeGroupsSocket>
