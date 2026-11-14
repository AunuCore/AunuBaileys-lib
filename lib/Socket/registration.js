// @ts-nocheck
// AunuBaileys P2b port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; types are intentionally loose here
// and tighten in a later pass.
import { executeWMexQuery } from './mex.js';
// AunuBaileys (1.0.71): account security (password + passkey/FIDO2),
// ported from @violetix/baileys lib/Socket/registration.js. Query IDs
// verbatim from the donor file.
// NOTE on passkeys: these are entry points — requestChallenge returns
// the server challenge, and verify/finish take the WebAuthn assertion
// the HOST collects from the owner's own authenticator. There is no
// headless completion path: when the server demands a passkey to link
// the account it sends a passkey_prologue_request notification, and
// messages-recv.js surfaces it as connection.update { passkeyRequired: true }.
const REGISTRATION_MEX_IDS = {
    HAS_PASSWORD: '25379221318423478', // HasPasswordQuery
    SET_PASSWORD: '33855141324134176', // SetPasswordMutation
    CHECK_PASSWORD: '26881928138061632', // CheckPasswordMutation
    DELETE_PASSWORD: '27247058691550586', // DeletePasswordMutation
    PASSKEY_EXIST: '25188064727509430', // PasskeyExistResponseQuery
    PASSKEY_LIST_EXIST: '26930537423220681', // PasskeyListExistResponseQuery
    PASSKEY_REQUEST_CHALLENGE: '26311497405176139', // PasskeyRequestChallengeMutation
    PASSKEY_VERIFY_CHALLENGE: '26876394218624479', // PasskeyVerifyChallengeMutation
    PASSKEY_DELETE: '25225683640428243', // PasskeyDeleteMutation
    REG_PASSKEY_START: '25415371271434748', // RegistrationPasskeyStartRegisterMutation
    REG_PASSKEY_FINISH: '24611221275218156', // RegistrationPasskeyFinishRegisterMutation
    REG_PASSKEY_ENABLE: '25147880151540247', // RegistrationPasskeyEnableMutation
    REG_PASSKEY_DISABLE: '27775237998742831', // RegistrationPasskeyDisableMutation
    REG_PASSKEY_CLEAR: '25111972538494859', // RegistrationPasskeyClear
    REG_PASSKEY_UPDATE_ENCRYPTION_STATUS: '24866837389649930', // RegistrationPasskeyUpdateClientEncryptionStatusMutation
    WWW_GET_NONCE: '24635485196143064', // WWWGetNonceForCompanionDevice
    WWW_EXCHANGE_NONCE: '25727187160203620', // WWWExchangeNonceForAccessToken
    WWW_CREATE_ACCESS_TOKEN: '7956082757804344', // WWWCreateAccessToken
    GET_WA_ME_LINK: '25001183556215266', // GetWaMeLinkQuery
    USER_COUNTRY_CODE: '25292528387076991' // UserCountryCodeGet
};
export const makeRegistrationSocket = sock => {
    const { query, generateMessageTag } = sock;
    const mexQuery = (variables, queryId, dataPath) => executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag);
    // ── Password ────────────────────────────────────────────────────
    const hasPassword = () => mexQuery({}, REGISTRATION_MEX_IDS.HAS_PASSWORD, 'xwa2_has_password');
    const setPassword = (password, oldPassword = null) => {
        const input = { password };
        if (oldPassword) {
            input.old_password = oldPassword;
        }
        return mexQuery({ input }, REGISTRATION_MEX_IDS.SET_PASSWORD, 'xwa2_set_password');
    };
    const checkPassword = password => mexQuery({ input: { password } }, REGISTRATION_MEX_IDS.CHECK_PASSWORD, 'xwa2_check_password');
    const deletePassword = password => mexQuery({ input: { password } }, REGISTRATION_MEX_IDS.DELETE_PASSWORD, 'xwa2_delete_password');
    // ── Passkey (account-level) ─────────────────────────────────────
    const passkeyExists = () => mexQuery({}, REGISTRATION_MEX_IDS.PASSKEY_EXIST, 'xwa2_passkey_exist_response');
    const passkeyListExists = () => mexQuery({}, REGISTRATION_MEX_IDS.PASSKEY_LIST_EXIST, 'xwa2_passkey_list_exist_response');
    const passkeyRequestChallenge = () => mexQuery({}, REGISTRATION_MEX_IDS.PASSKEY_REQUEST_CHALLENGE, 'xwa2_passkey_request_challenge');
    const passkeyVerifyChallenge = (credentialId, authenticatorData, clientDataJson, signature) => mexQuery({
        credential_id: credentialId,
        authenticator_data: authenticatorData,
        client_data_json: clientDataJson,
        signature
    }, REGISTRATION_MEX_IDS.PASSKEY_VERIFY_CHALLENGE, 'xwa2_passkey_verify_challenge');
    const passkeyDelete = credentialId => mexQuery({ credential_id: credentialId }, REGISTRATION_MEX_IDS.PASSKEY_DELETE, 'xwa2_passkey_delete');
    // ── Passkey (registration flow) ─────────────────────────────────
    const regPasskeyStart = () => mexQuery({}, REGISTRATION_MEX_IDS.REG_PASSKEY_START, 'xwa2_reg_passkey_start_register');
    const regPasskeyFinish = (credentialId, attestationObject, clientDataJson) => mexQuery({ credential_id: credentialId, attestation_object: attestationObject, client_data_json: clientDataJson }, REGISTRATION_MEX_IDS.REG_PASSKEY_FINISH, 'xwa2_reg_passkey_finish_register');
    const regPasskeyEnable = () => mexQuery({}, REGISTRATION_MEX_IDS.REG_PASSKEY_ENABLE, 'xwa2_reg_passkey_enable');
    const regPasskeyDisable = () => mexQuery({}, REGISTRATION_MEX_IDS.REG_PASSKEY_DISABLE, 'xwa2_reg_passkey_disable');
    const regPasskeyClear = () => mexQuery({}, REGISTRATION_MEX_IDS.REG_PASSKEY_CLEAR, 'xwa2_reg_passkey_clear');
    const regPasskeyUpdateEncryptionStatus = encryptionEnabled => mexQuery({ encryption_enabled: encryptionEnabled }, REGISTRATION_MEX_IDS.REG_PASSKEY_UPDATE_ENCRYPTION_STATUS, 'xwa2_reg_passkey_update_encryption_status');
    // ── WWW / web companion (nonce flow for the GraphQL token) ──────
    const wwwGetNonce = () => mexQuery({}, REGISTRATION_MEX_IDS.WWW_GET_NONCE, 'xwa2_ent_get_canonical_ent_device_nonce');
    const wwwExchangeNonce = nonce => mexQuery({ nonce }, REGISTRATION_MEX_IDS.WWW_EXCHANGE_NONCE, 'xwa2_www_exchange_nonce_for_access_token');
    const wwwCreateAccessToken = (nonce, userId) => mexQuery({ nonce, user_id: userId }, REGISTRATION_MEX_IDS.WWW_CREATE_ACCESS_TOKEN, 'xwa2_www_create_access_token');
    const getWaMeLink = () => mexQuery({}, REGISTRATION_MEX_IDS.GET_WA_ME_LINK, 'xwa2_get_wa_me_link');
    const userCountryCodeGet = () => mexQuery({}, REGISTRATION_MEX_IDS.USER_COUNTRY_CODE, 'xwa2_user_country_code');
    return {
        ...sock,
        hasPassword,
        setPassword,
        checkPassword,
        deletePassword,
        passkeyExists,
        passkeyListExists,
        passkeyRequestChallenge,
        passkeyVerifyChallenge,
        passkeyDelete,
        regPasskeyStart,
        regPasskeyFinish,
        regPasskeyEnable,
        regPasskeyDisable,
        regPasskeyClear,
        regPasskeyUpdateEncryptionStatus,
        wwwGetNonce,
        wwwExchangeNonce,
        wwwCreateAccessToken,
        getWaMeLink,
        userCountryCodeGet,
        REGISTRATION_MEX_IDS
    };
};
//# sourceMappingURL=registration.js.map