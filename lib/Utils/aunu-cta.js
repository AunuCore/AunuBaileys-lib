// AunuBaileys (1.0.71): named encoders for native-flow CTA buttons.
//
// Our interactive path passes a button's `name` / `buttonParamsJson`
// through verbatim (messages.js: withAunuButtonIcon), so a host could
// already hand-assemble these JSON blobs — these builders just make the
// shapes nameable and typo-proof. Button `name` values and
// buttonParamsJson keys follow baileys-rec 1.3.0's mapper
// (lib/Utils/messages.js) and ButtonBuilder
// (lib/Utils/cloud-api-utils.js); `cta_catalog` / `galaxy_message`
// are the button names the shanks farm notes under those names —
// shanks 0.1.2 (the only version on npm; 0.1.4 does not exist) lists
// `cta_catalog` only as a native-flow name with no params shape, so
// its params are our own minimal {display_text} + passthrough and the
// render is NOT guaranteed by any client (shanks' own caveat).
// No donor code is copied: every builder below is written from the
// observed name/param shapes, not pasted from the donor files.
//
// Usage: pass the returned {name, buttonParamsJson} entries as the
// `buttons` of an `interactive` message:
//   sock.sendMessage(jid, { interactive: { text: 'Pick one',
//     buttons: [buildAunuCTAReminder('Remind me', { title: 'Call',
//       timestamp: Date.now() / 1000 + 3600 })] } })
const asJson = (params) => JSON.stringify(params);

// AunuBaileys (1.0.71): reminder time may be a Date, a seconds number,
// a millisecond number, or a date string — normalised to epoch
// seconds the way the donor mapper does.
export const aunuCTAtoTimestampSeconds = (value) => {
    if (value instanceof Date) {
        return Math.floor(value.getTime() / 1000);
    }
    if (typeof value === 'number') {
        return value > 1e11 ? Math.floor(value / 1000) : value;
    }
    if (typeof value === 'string') {
        return Math.floor(new Date(value).getTime() / 1000);
    }
    return Math.floor(Date.now() / 1000) + 3600;
};

// AunuBaileys (1.0.71): the raw {name, buttonParamsJson} pair — the
// unit every builder below returns, matching what
// nativeFlowMessage.buttons carries on the wire.
export const buildAunuCTAButton = (name, params = {}) => ({
    name,
    buttonParamsJson: asJson(params)
});

// AunuBaileys (1.0.71): set-a-reminder button (cta_reminder).
export const buildAunuCTAReminder = (text, options = {}) => {
    const { title, timestamp, date, time, icon } = options;
    return buildAunuCTAButton('cta_reminder', {
        display_text: text || '⏰ Set Reminder',
        title: title || text || 'Reminder',
        timestamp: aunuCTAtoTimestampSeconds(timestamp ?? date ?? time),
        icon
    });
};

// AunuBaileys (1.0.71): cancel-a-reminder button (cta_cancel_reminder).
export const buildAunuCTACancelReminder = (text, reminderId = '1', icon) => buildAunuCTAButton('cta_cancel_reminder', {
    display_text: text || '❌ Cancel Reminder',
    reminder_id: typeof reminderId === 'string' ? reminderId : reminderId?.id || '1',
    icon
});

// AunuBaileys (1.0.71): native location-sharing request (send_location).
export const buildAunuCTALocation = (text = '📍 Share Location', icon) => buildAunuCTAButton('send_location', {
    display_text: text,
    icon
});

// AunuBaileys (1.0.71): in-app webview button (open_webview).
export const buildAunuCTAWebview = (text, url, options = {}) => buildAunuCTAButton('open_webview', {
    display_text: text || '🌐 Open',
    url,
    title: options.title || text || 'Web View',
    icon: options.icon
});

// AunuBaileys (1.0.71): payment checkout button (review_and_pay unless
// the payment config names another button).
export const buildAunuCTAPayment = (text, payment = {}) => buildAunuCTAButton(payment.name || 'review_and_pay', {
    currency: payment.currency || 'IDR',
    total_amount: payment.amount || { value: payment.value || 10000, offset: 100 },
    reference_id: payment.referenceId || payment.id || 'PAY_1',
    type: payment.type || 'physical-goods',
    payment_configuration: payment.config || 'merchant_config',
    payment_type: payment.paymentType || 'pix',
    pix_code: payment.pixCode,
    display_text: text || '💳 Pay Now',
    icon: payment.icon
});

// AunuBaileys (1.0.71): order-summary review button (review_order).
export const buildAunuCTAOrder = (text, order = {}) => buildAunuCTAButton('review_order', {
    order: {
        status: order.status || 'pending',
        items: order.items || [],
        subtotal: order.subtotal || 0,
        tax: order.tax || 0,
        order_id: order.id || 'ORD_1'
    },
    display_text: text || '🛍️ Review Order',
    icon: order.icon
});

// AunuBaileys (1.0.71): voice/video call permission request button.
export const buildAunuCTACallPermission = (text = '📞 Request Call', icon) => buildAunuCTAButton('call_permission_request', {
    display_text: text,
    icon
});

// AunuBaileys (1.0.71): address-collection button (address_message).
export const buildAunuCTAAddress = (text, options = {}) => buildAunuCTAButton('address_message', {
    display_text: text || '🏠 Provide Address',
    address_type: options.type || 'shipping',
    icon: options.icon
});

// AunuBaileys (1.0.71): WhatsApp Flow button (name 'flow'). No proto
// `flowMessage` field exists in our WAProto, so a flow travels as a
// nativeFlowMessage button — this encoder is the whole 'flow' support;
// no separate mapper branch is needed.
export const buildAunuCTAFlow = (flowId, text, options = {}) => buildAunuCTAButton('flow', {
    flow_message_version: String(options.version || '3'),
    flow_token: options.flowToken || '1',
    flow_id: flowId,
    flow_cta: text || 'View Flow',
    flow_action: options.action || 'navigate',
    flow_action_payload: options.payload || {},
    icon: options.icon
});

// AunuBaileys (1.0.71): catalog button (cta_catalog). The donor only
// establishes the name — params beyond display_text are a passthrough
// the host supplies; whether a client renders it is not guaranteed.
export const buildAunuCTACatalog = (text, options = {}) => {
    const { catalogId, icon, ...extra } = options;
    return buildAunuCTAButton('cta_catalog', {
        display_text: text || '🛍️ View Catalog',
        ...(catalogId ? { catalog_id: catalogId } : {}),
        icon,
        ...extra
    });
};

// AunuBaileys (1.0.71): galaxy flow button (galaxy_message) — the flow
// params shape of buildAunuCTAFlow under the shanks button name.
// The name is verified from the donor; the params shape is inferred
// from the flow-button family, not observed in the donor.
export const buildAunuCTAGalaxyMessage = (flowId, text, options = {}) => buildAunuCTAButton('galaxy_message', {
    flow_message_version: String(options.version || '3'),
    flow_token: options.flowToken || '1',
    flow_id: flowId,
    flow_cta: text || 'View',
    flow_action: options.action || 'navigate',
    flow_action_payload: options.payload || {},
    icon: options.icon
});
