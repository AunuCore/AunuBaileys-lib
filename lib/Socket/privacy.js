// @ts-nocheck
// AunuBaileys P2b port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; types are intentionally loose here
// and tighten in a later pass.
import { executeWMexQuery } from './mex.js';
// AunuBaileys (1.0.71): MEX privacy management — minimal subset ported
// from @violetix/baileys lib/Socket/privacy.js. Query IDs verbatim from
// the donor (source per the donor: whatsapp-android-mex_client_persist_ids.json).
// This is the MEX surface; the classic w:privacy IQ surface
// (fetchPrivacySettings / updateMessagesPrivacy in chats.js) is untouched.
const PRIVACY_MEX_IDS = {
    GET_SETTINGS: '32774292262215379', // GetPrivacySettingsQuery
    SET_SETTING: '26887749497493182', // SetPrivacySettingMutation
    UPDATE_CONTACT_LIST: '26375158178762799', // UpdatePrivacyContactListMutation
    GET_CONTACT_LIST: '25700444246275822', // GetPrivacyContactListQuery
    UPDATE_TEXT_STATUS: '25863197129975892', // UpdateTextStatus
    GET_TEXT_STATUS_LIST: '25741205615468935', // GetTextStatusList
    UPDATE_USER_STATUS: '7452341274886724' // UpdateUserStatus
};
export const makePrivacySocket = sock => {
    const { authState, query, generateMessageTag } = sock;
    const mexQuery = (variables, queryId, dataPath) => executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag);
    /**
     * Fetch privacy settings via MEX.
     * Donor: variables { users: [{ jid, privacy_features: [...] }] },
     * dataPath xwa2_fetch_wa_users.
     */
    const getPrivacySettings = (jid, features = null) => {
        jid = jid || authState.creds.me?.id;
        const users = [{ jid, ...(features ? { privacy_features: features } : {}) }];
        return mexQuery({ users }, PRIVACY_MEX_IDS.GET_SETTINGS, 'xwa2_fetch_wa_users');
    };
    /**
     * Set a privacy setting via MEX. Values are lowercase and
     * case-sensitive on the wire (donor, confirmed against
     * WASmaxInPrivacyEnums / WAWebPrivacySettings).
     * Known features: "last", "online", "profile", "status",
     * "readreceipts", "groupadd", "groupcreation", "calladd", "defense",
     * "messages" (plus business-only "linked_profiles", "cover_photo",
     * "dependentaccountmessages", "pix", "stickers").
     * Known settings: "all", "contacts", "contact_blacklist", "none";
     * "online" only "all" | "match_last_seen"; "calladd" only
     * "all" | "contacts" | "known"; "defense" only "off" | "on_standard".
     */
    const setPrivacySetting = (feature, setting) => mexQuery({ feature, setting }, PRIVACY_MEX_IDS.SET_SETTING, 'xwa2_privacy_feature_update');
    /**
     * Update the allow/deny contact list for a privacy setting (e.g.
     * feature "groupadd" with setting "contact_blacklist" denies the
     * listed JIDs; "contacts" allows them).
     */
    const updatePrivacyContactList = (feature, setting, jids) => mexQuery({ feature, setting, contacts: jids.map(jid => ({ jid })) }, PRIVACY_MEX_IDS.UPDATE_CONTACT_LIST, 'xwa2_privacy_contact_list_update');
    /** Fetch the allow/deny contact list for a privacy setting. */
    const getPrivacyContactList = (feature, setting) => mexQuery({ feature, setting }, PRIVACY_MEX_IDS.GET_CONTACT_LIST, 'xwa2_privacy_contact_list');
    /**
     * Update own text status (About) via MEX.
     * Donor: text_status_input { text, emoji: { content } }.
     */
    const updateTextStatus = (text, emoji = null) => {
        const input = { text };
        if (emoji) {
            input.emoji = { content: emoji };
        }
        return mexQuery({ text_status_input: input }, PRIVACY_MEX_IDS.UPDATE_TEXT_STATUS, 'xwa2_text_status_update');
    };
    /**
     * Fetch text statuses (About) for a list of JIDs via MEX.
     * Donor: input [{ jid, last_update_time: null }].
     */
    const getTextStatusList = (jids, lastUpdateTime = null) => {
        const input = jids.map(jid => ({ jid, last_update_time: lastUpdateTime }));
        return mexQuery({ input }, PRIVACY_MEX_IDS.GET_TEXT_STATUS_LIST, 'xwa2_text_status_list');
    };
    /** Update own user status string via MEX. */
    const updateUserStatus = status => mexQuery({ status }, PRIVACY_MEX_IDS.UPDATE_USER_STATUS, 'xwa2_update_user_status');
    return {
        ...sock,
        getPrivacySettings,
        setPrivacySetting,
        updatePrivacyContactList,
        getPrivacyContactList,
        updateTextStatus,
        getTextStatusList,
        updateUserStatus,
        PRIVACY_MEX_IDS
    };
};
//# sourceMappingURL=privacy.js.map