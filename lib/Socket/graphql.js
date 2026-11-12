import { Boom } from '@hapi/boom';

// AunuBaileys (1.0.71): EXPERIMENTAL HTTPS GraphQL surface — see the
// header in the patch file for what is and is not ported, and why there
// is no default-token fallback.
const ENDPOINTS = {
    WWW: 'https://graph.whatsapp.com/graphql',
    ACS: 'https://acs.whatsapp.com/graphql',
    WAMO_PATH: '/api/wamo/graphql/'
};
const WAMO_APP_ID = '1015890928915437';
// Doc IDs used by this port, verbatim from the donor's WWW_GQL_IDS /
// CLIENT_PERSIST_GQL_IDS tables (whatsapp-android-www_client_persist_ids.json
// and whatsapp-android_client-persist.json).
const AUNU_GRAPHQL_IDS = {
    META_AI_MEMORY_QUERY: '24926755306989290',
    META_AI_UNIFIED_MEMORY_QUERY: '25207057475554616',
    META_AI_MEMORY_DELETE: '24675700195394532',
    META_AI_MEMORY_DELETE_ALL: '25139336568989424',
    META_AI_MEMORY_OPT_OUT_STATUS: '32233077506339604',
    META_AI_MEMORY_OPT_OUT_UPDATE: '24192448100382070',
    AI_STUDIO_MEMORY_QUERY: '31947510941561276',
    AI_STUDIO_MEMORY_DELETE: '9705428856224794',
    AI_STUDIO_MEMORY_DELETE_ALL: '30717961127818650',
    AI_HOME_FETCH_USER_CREATED_PERSONAS: '26593306827004416',
    AI_HOME_SEARCH: '27216563884595110',
    AI_CREATION_FETCH_CREATED_BOT: '25201089862855984',
    IMAGINE_EDIT: '26387089294279400',
    IMAGINE_EDIT_VIDEO: '34646600944984156',
    IMAGINE_VIDEO_STATUS: '34577682511875320',
    GEN_AI_IMAGINE_GENERATE: '25754106557586292',
    CREATE_EVENT: '27259582783645464',
    GET_EVENT: '26814174831581200',
    LIST_EVENTS: '35283909937920624',
    UPDATE_EVENT: '35415093074772810',
    DELETE_EVENT: '24671535952543812',
    UPDATE_EVENT_RSVP: '25954023907630800',
    GET_PAYMENT_KEY: '32245076985140016',
    GET_PIX_BANK_LIST: '23883352801362930',
    GET_ELIGIBILITY: '26212557348384404',
    PAYMENT_HEALTH_CHECKS: '26301245572841100'
};
const parseGraphQLResponse = (json, dataPath) => {
    if (json.errors?.length) {
        const msgs = json.errors.map(e => e.message || 'Unknown error').join(', ');
        const code = json.errors[0]?.extensions?.error_code || 400;
        throw new Boom(`GraphQL error: ${msgs}`, { statusCode: code, data: json.errors[0] });
    }
    const response = dataPath ? json?.data?.[dataPath] : json?.data;
    if (response === undefined) {
        throw new Boom('Unexpected GraphQL response structure', { statusCode: 400, data: json });
    }
    return response;
};
/**
 * Execute a www-schema GraphQL query over HTTPS.
 * Transport (donor, APX.java): POST https://graph.whatsapp.com/graphql,
 * Content-Type application/json, body { access_token, doc_id, variables, lang }.
 */
export const executeWWWGraphQL = async (docId, variables, accessToken, dataPath = null, lang = 'en', endpoint = ENDPOINTS.WWW) => {
    if (!accessToken) {
        throw new Boom('GraphQL needs an access token — call setAccessToken() or let acquireAccessToken() run the MEX nonce flow (no default token is shipped)', { statusCode: 401 });
    }
    const body = JSON.stringify({ access_token: accessToken, doc_id: String(docId), variables, lang });
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
    });
    if (!res.ok) {
        // AunuBaileys (1.0.76): Hunt-ronde-3 — drain the error body before
        // throwing. An unconsumed fetch body pins its keep-alive socket
        // out of the undici pool until GC; repeated GraphQL errors would
        // steadily starve the pool. The body text also improves the error.
        const errBody = await res.text().catch(() => '');
        throw new Boom(`GraphQL HTTP error ${res.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`, { statusCode: res.status });
    }
    const json = await res.json();
    return parseGraphQLResponse(json, dataPath);
};
/**
 * Execute a facebook-schema GraphQL query over HTTPS.
 * Transport (donor, WaFaConfigFetcher.java): POST https://acs.whatsapp.com/graphql.
 */
export const executeFacebookGraphQL = (docId, variables, accessToken, dataPath = null, lang = 'en') => executeWWWGraphQL(docId, variables, accessToken, dataPath, lang, ENDPOINTS.ACS);
/**
 * Execute a wamo-schema GraphQL query over HTTPS.
 * Transport (donor, WamoGraphQLExecutor.java): POST https://<wamoHost>/api/wamo/graphql/,
 * Content-Type application/x-www-form-urlencoded, body
 * access_token=<token>&credential=<cred>&user_id=<uid>&app_id=1015890928915437&doc_id=<id>&variables=<json>.
 */
export const executeWamoGraphQL = async (docId, variables, wamoAuth = {}, dataPath = null, wamoHost = 'wamo.whatsapp.net') => {
    const { accessToken, credential = '', userId = '' } = wamoAuth;
    if (!accessToken) {
        throw new Boom('Wamo GraphQL needs an access token in wamoAuth (no default token is shipped)', { statusCode: 401 });
    }
    const params = new URLSearchParams({
        access_token: accessToken,
        credential,
        user_id: String(userId),
        app_id: WAMO_APP_ID,
        doc_id: String(docId),
        variables: JSON.stringify(variables)
    });
    const url = `https://${wamoHost}${ENDPOINTS.WAMO_PATH}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });
    if (!res.ok) {
        // AunuBaileys (1.0.76): drain the error body (see executeWWWGraphQL).
        const errBody = await res.text().catch(() => '');
        throw new Boom(`Wamo GraphQL HTTP error ${res.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`, { statusCode: res.status });
    }
    const json = await res.json();
    return parseGraphQLResponse(json, dataPath);
};
export const makeGraphQLSocket = (sock) => {
    let _accessToken = null;
    let _tokenPromise = null;
    let _wamoAuth = {};
    let _wamoHost = 'wamo.whatsapp.net';
    const setAccessToken = (token) => {
        _accessToken = token;
        _tokenPromise = null;
    };
    const setWamoAuth = (auth, host = null) => {
        _wamoAuth = auth;
        if (host) {
            _wamoHost = host;
        }
    };
    /**
     * Ensure a valid ACS access token is available. On first call (or
     * after invalidation), runs the MEX nonce flow via the registration
     * layer: wwwGetNonce() → wwwExchangeNonce(nonce) → caches the
     * resulting token. Concurrent callers share a single in-flight request.
     */
    const acquireAccessToken = () => {
        if (_accessToken) {
            return Promise.resolve(_accessToken);
        }
        if (_tokenPromise) {
            return _tokenPromise;
        }
        if (typeof sock.wwwGetNonce !== 'function' || typeof sock.wwwExchangeNonce !== 'function') {
            return Promise.reject(new Boom('GraphQL token acquisition needs the registration layer (wwwGetNonce/wwwExchangeNonce)', { statusCode: 500 }));
        }
        const pending = (async () => {
            const nonceData = await sock.wwwGetNonce();
            const nonce = nonceData?.nonce ?? nonceData;
            const tokenData = await sock.wwwExchangeNonce(nonce);
            const token = tokenData?.access_token ?? tokenData;
            if (_tokenPromise === pending) {
                _accessToken = token;
            }
            return token;
        })();
        _tokenPromise = pending;
        const clearPending = () => {
            if (_tokenPromise === pending) {
                _tokenPromise = null;
            }
        };
        pending.then(clearPending, clearPending);
        return _tokenPromise;
    };
    const www = async (docId, variables, dataPath = null) => {
        const token = await acquireAccessToken();
        return executeWWWGraphQL(docId, variables, token, dataPath);
    };
    const wamo = (docId, variables, dataPath = null) => executeWamoGraphQL(docId, variables, _wamoAuth, dataPath, _wamoHost);
    // AunuBaileys (1.0.71): EXPERIMENTAL — everything under aunuGraphql,
    // nothing spread onto the socket root.
    const aunuGraphql = {
        setAccessToken,
        setWamoAuth,
        acquireAccessToken,
        executeWWWGraphQL,
        executeFacebookGraphQL,
        executeWamoGraphQL,
        // Meta AI memory
        metaAiMemoryQuery: () => www(AUNU_GRAPHQL_IDS.META_AI_MEMORY_QUERY, {}, 'xwa2_meta_ai_memory'),
        metaAiUnifiedMemoryQuery: () => www(AUNU_GRAPHQL_IDS.META_AI_UNIFIED_MEMORY_QUERY, {}, 'xwa2_meta_ai_unified_memory'),
        metaAiMemoryDelete: (id) => www(AUNU_GRAPHQL_IDS.META_AI_MEMORY_DELETE, { id }, 'xwa2_meta_ai_memory_delete'),
        metaAiMemoryDeleteAll: () => www(AUNU_GRAPHQL_IDS.META_AI_MEMORY_DELETE_ALL, {}, 'xwa2_meta_ai_memory_delete_all'),
        metaAiMemoryOptOutStatus: () => www(AUNU_GRAPHQL_IDS.META_AI_MEMORY_OPT_OUT_STATUS, {}, 'xwa2_meta_ai_wa_memory_opt_out_status'),
        metaAiMemoryOptOutUpdate: (optOut) => www(AUNU_GRAPHQL_IDS.META_AI_MEMORY_OPT_OUT_UPDATE, { opt_out: optOut }, 'xwa2_meta_ai_wa_memory_opt_out_update'),
        aiStudioMemoryQuery: () => www(AUNU_GRAPHQL_IDS.AI_STUDIO_MEMORY_QUERY, {}, 'xwa2_ai_studio_wa_memory_query'),
        aiStudioMemoryDelete: (id) => www(AUNU_GRAPHQL_IDS.AI_STUDIO_MEMORY_DELETE, { id }, 'xwa2_ai_studio_wa_memory_delete'),
        aiStudioMemoryDeleteAll: () => www(AUNU_GRAPHQL_IDS.AI_STUDIO_MEMORY_DELETE_ALL, {}, 'xwa2_ai_studio_wa_memory_delete_all'),
        // AI personas
        aiHomeFetchUserCreatedPersonas: () => www(AUNU_GRAPHQL_IDS.AI_HOME_FETCH_USER_CREATED_PERSONAS, {}, 'xwa2_ai_home_fetch_user_created_personas'),
        aiHomeSearch: (query) => www(AUNU_GRAPHQL_IDS.AI_HOME_SEARCH, { query }, 'xwa2_ai_home_search'),
        aiCreationFetchCreatedBot: (botId) => www(AUNU_GRAPHQL_IDS.AI_CREATION_FETCH_CREATED_BOT, { bot_id: botId }, 'xwa2_ai_creation_fetch_created_bot'),
        // Imagine / GenAI (image generate via client-persist, edit + video via www)
        genAiImagineGenerate: (prompt, options = {}) => www(AUNU_GRAPHQL_IDS.GEN_AI_IMAGINE_GENERATE, { prompt, ...options }, null),
        imagineEdit: (imageId, prompt) => www(AUNU_GRAPHQL_IDS.IMAGINE_EDIT, { image_id: imageId, prompt }, 'xwa2_imagine_edit'),
        imagineEditVideo: (videoId, styleId) => www(AUNU_GRAPHQL_IDS.IMAGINE_EDIT_VIDEO, { video_id: videoId, style_id: styleId }, 'xwa2_imagine_edit_video'),
        imagineVideoStatus: (jobId) => www(AUNU_GRAPHQL_IDS.IMAGINE_VIDEO_STATUS, { job_id: jobId }, 'xwa2_imagine_video_status'),
        // Events
        createEvent: (input) => www(AUNU_GRAPHQL_IDS.CREATE_EVENT, { input }, 'xwa2_create_event'),
        getEvent: (eventId) => www(AUNU_GRAPHQL_IDS.GET_EVENT, { event_id: eventId }, 'xwa2_get_event'),
        listEvents: (options = {}) => www(AUNU_GRAPHQL_IDS.LIST_EVENTS, options, 'xwa2_list_events'),
        updateEvent: (eventId, updates) => www(AUNU_GRAPHQL_IDS.UPDATE_EVENT, { event_id: eventId, ...updates }, 'xwa2_update_event'),
        deleteEvent: (eventId) => www(AUNU_GRAPHQL_IDS.DELETE_EVENT, { event_id: eventId }, 'xwa2_delete_event'),
        updateEventRsvp: (eventId, rsvp) => www(AUNU_GRAPHQL_IDS.UPDATE_EVENT_RSVP, { event_id: eventId, rsvp }, 'xwa2_update_event_rsvp'),
        // Payments — READ-ONLY lookups only (see header)
        getPaymentKey: () => www(AUNU_GRAPHQL_IDS.GET_PAYMENT_KEY, {}, 'xwa2_get_payment_key'),
        getPixBankList: () => www(AUNU_GRAPHQL_IDS.GET_PIX_BANK_LIST, {}, 'xwa2_get_pix_bank_list'),
        getEligibility: (feature = null) => www(AUNU_GRAPHQL_IDS.GET_ELIGIBILITY, feature ? { feature } : {}, 'xwa2_get_eligibility'),
        paymentHealthChecks: () => www(AUNU_GRAPHQL_IDS.PAYMENT_HEALTH_CHECKS, {}, 'xwa2_payment_health_checks'),
        AUNU_GRAPHQL_IDS,
        ENDPOINTS
    };
    return {
        ...sock,
        aunuGraphql
    };
};
