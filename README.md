<div align="center">

# 🖤 AunuBaileys

### The WhatsApp Web API for bots that never sleep.

[![npm version](https://img.shields.io/npm/v/aunubaileys?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/aunubaileys)
[![npm downloads](https://img.shields.io/npm/dt/aunubaileys?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/aunubaileys)
[![Fork of WhiskeySockets/Baileys](https://img.shields.io/badge/fork%20of-WhiskeySockets%2FBaileys-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://github.com/WhiskeySockets/Baileys)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow?style=for-the-badge)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/AunuCore/AunuBaileys-lib?style=for-the-badge&logo=github)](https://github.com/AunuCore/AunuBaileys-lib/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/AunuCore/AunuBaileys-lib?style=for-the-badge&logo=github)](https://github.com/AunuCore/AunuBaileys-lib/forks)

**Full upstream power — with the soul that community forks used to have.**
The in-memory store is back, legacy exports are back, and every upstream update flows straight in.

📚 **[Full documentation — docsjs.aunucore.eu.cc](https://docsjs.aunucore.eu.cc)** · [English](#-english) · [Bahasa Indonesia](#-bahasa-indonesia)

</div>

---

## 🌍 English

**AunuBaileys** is a fork of the legendary [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) WhatsApp Web API, maintained by **AunuCore Creative Network**. Upstream removed pieces that thousands of long-running bot scripts were built on — so we brought them back, cleanly, and keep this fork permanently in sync with upstream.

📚 **Documentation:** the complete guide lives at **[docsjs.aunucore.eu.cc](https://docsjs.aunucore.eu.cc)** — getting started, connection & pairing, builders, AunuAntiBan, the full event map, socket configuration, recipes, and a disconnect-code troubleshooting table.

### ✨ What makes it different

- 🧠 **`makeInMemoryStore` is back** — chats, contacts, messages, labels: the full in-memory store, restored and typed.
- 🔑 **Legacy exports restored** — `processedMessages`, `initInMemoryKeyStore()`, and `PHONENUMBER_MCC`, the symbols older scripts reach for.
- 🔄 **Always in sync** — this is a true GitHub fork: upstream fixes and features land here continuously, with the AunuCore patch layer kept small and auditable.
- 📱 **Pairing that just works** — custom pairing codes and the modern connection flow, out of the box.
- 🧼 **Clean-room, transparent** — no obfuscation, no funny business. Read every line; the diff against upstream is tiny and deliberate.

### 🚀 Quick start

```bash
npm i aunubaileys
```

```ts
import makeWASocket, { useMultiFileAuthState, makeInMemoryStore } from 'aunubaileys'

const store = makeInMemoryStore({})
const { state, saveCreds } = await useMultiFileAuthState('auth')
const sock = makeWASocket({ auth: state })
store.bind(sock.ev)
sock.ev.on('creds.update', saveCreds)
```

### 🛠️ The AunuCore patch layer

| Piece | Where |
|---|---|
| In-memory store | `lib/Store/` |
| Compat exports (`processedMessages`, `initInMemoryKeyStore`) | `lib/Utils/fork-compat.js` |
| `PHONENUMBER_MCC` table | `lib/Utils/phonenumber-mcc.js` |

Everything else is pure upstream. When upstream moves, we rebase the patch layer — that discipline is the whole point of this fork.





### 🧪 What's new in 1.0.57 / Baru di 1.0.57 — EXPERIMENTAL

- 🎭 **Five message-manipulation features (25 methods total).** Every WhatsApp display is a sender claim inside the protocol; the official app always writes honest values — AunuBaileys now lets you write your own. **`aunuFakeDoc`** — a document displaying a fake size (default 2 GB) and page count (default 9,999). **`aunuFakeVideo`** — a video claiming a fake duration (default 3600s) with a decoy thumbnail. **`aunuFakeLocation`** — a location card whose name, address, photo and coordinates are all invented (defaults to Monas, Jakarta). **`aunuFakeAlbum`** — an album header claiming more items than are sent — even a phantom album with zero items. **`aunuWordReact`** — a reaction containing a word instead of an emoji. The display lies; opening the content still reveals the real file.

### 🧪 What's new in 1.0.56 / Baru di 1.0.56 — EXPERIMENTAL

- 🪤 **Four rare experimental features (20 methods total).** **`aunuTrapImage`** — the preview thumbnail your recipient sees is a decoy picture; the photo that opens on tap is a different one (hand-built message, relayed so the two fields stay independent). **`aunuFakeVN`** — a voice note claiming a fake duration (default 3600s) with a full generated waveform (`buildFakeWaveform()`), whatever the clip really lasts. **`aunuGhostMessage`** — a bubble that renders completely empty (zero-width characters only), optionally hiding a watermark tag. **`aunuPromoCode`** — a promo-code card with a built-in tap-to-copy button carrying the code, on top of `aunuCard`.

### 🧪 What's new in 1.0.55 / Baru di 1.0.55 — EXPERIMENTAL

- 👻 **`aunuVanish`** — send any content with a **custom per-message disappearing timer**: `sock.aunuVanish(jid, content, '5m')` (raw seconds or `'30s'`/`'5m'`/`'2h'`/`'7d'`; the parser is exported as `parseVanishDuration`). This is WhatsApp's native expiry — the receiving client removes the message **without a trace** when the timer ends. It is NOT delete-for-everyone: no "this message was deleted" tombstone. Enforcement is by the receiving client, exactly like built-in disappearing messages. The experimental API is now 16 methods. This release also ships the rewritten npm description + keywords.

### ✂️ What's new in 1.0.54 / Baru di 1.0.54

- **Pruning.** `aunuCountdown` and `aunuSplitText` (added in 1.0.53) are **removed**: the AunuBaileys experimental line keeps only the rare features, and those two were generic utilities. The experimental API is back to **15 methods**; `aunuSideText`, `aunuGhostMention` and `aunuFakeForward` stay.

### 🧪 What's new in 1.0.53 / Baru di 1.0.53 — EXPERIMENTAL

- 📇 **Three new experimental features.** **`aunuSideText`** — text with a small picture **at the side**: a name/title beside the picture and the chat under the name (the preview layout group menus use); the picture can be someone's real profile picture (`profileOf`), your own image, the built-in grey **"deleted account"** avatar (`deletedProfile: true`), or no picture at all. **`aunuGhostMention`** — mention every group member invisibly: everyone is notified, the text shows no @ pile-up. **`aunuFakeForward`** — the forwarded look (high forwarding score, optional channel attribution). New exported utils: `getDeletedProfileImage()` (the embedded deleted-account avatar PNG) and `buildSideTextAdReply()`. (This release also briefly carried `aunuCountdown`/`aunuSplitText`, removed again in 1.0.54.)

### 🧪 What's new in 1.0.52 / Baru di 1.0.52 — EXPERIMENTAL

- 👍 **`aunuCard` gains like/dislike buttons.** The new `likeDislike: true` option appends two quick-reply buttons under the card — **👍 Suka** (id `aunu_like`) and **👎 Tidak Suka** (id `aunu_dislike`) — after any custom buttons. The ids are overridable via `likeId`/`dislikeId`; taps return to the bot as button replies carrying those ids, so votes can be counted. Without the option, card behaviour is exactly as in 1.0.50.

### 🩹 What's new in 1.0.51 / Baru di 1.0.51

- 🔐 **Three audited gaps, closed.** (1) **Key-store commit failures are no longer swallowed** (`auth-utils.js`): transaction commits still retry as before, but when every retry fails the error is now **thrown** — previously the mutations were silently discarded while the in-memory ratchet had already advanced, so every later message failed against the stale on-disk record. (2) **Hosted device :99 guard** (`signal.js`): `extractDeviceJids` now skips device 99 — hosted / Cloud-API companion devices are not E2E targets and libsignal rejects them when the device list is built. (3) **PN → LID session migration** (`libsignal.js`, `Socket/index.js`): the new repository method `migrateSession(fromJid, toJid)` moves the raw session record onto the LID address when the target has none (never overwrites). It fires automatically and best-effort when live traffic teaches a new PN↔LID pair, and for the account's own session when the connection opens with both `me.id` and `me.lid` known. The 1.0.14–1.0.48 decrypt heals remain the safety net.

### 🧪 What's new in 1.0.50 / Baru di 1.0.50 — EXPERIMENTAL

- 🃏 **Six more experimental features.** (1) `sock.aunuCard(jid, options)` — an interactive photo card: the header photo **does not open as a normal photo** when tapped, a title/name and text sit fused below it in the same bubble, and divider-separated buttons (`reply`/`url`/`copy`/`call`) sit underneath; the photo is uploaded from a Buffer/URL and embedded as the header, or supplied prebuilt as `imageMessage`. (2) `sock.aunuFakeQuote(jid, content, quote)` — send a message carrying a fabricated quote, as if replying to someone. (3) `sock.aunuTypewriter(jid, text, options)` — a typing effect: the message is sent in growing pieces by editing it on an interval until the full text stands. (4) `sock.aunuReactSequence(jid, key, emojis, options)` — cycle reactions on one message. (5) `sock.aunuPostStatus(text, options)` — a styled text status (background colour + font) in one call. (6) `sock.aunuPersonalCard(jid, targetJid, options)` — the one-person form of 1.0.49's personalised tag-all: an own-profile-picture + name card for a single target, into a chat or as a DM. All experimental, like the features of 1.0.47/1.0.49.

### 🧪 What's new in 1.0.49 / Baru di 1.0.49 — EXPERIMENTAL

- 🪪 **Personalised tag-all: every member sees themselves.** New socket method `sock.aunuPersonalTagAll(groupJid, options)`: for EVERY group member the bot sends one card carrying **that member's own profile picture** and their own name, mentioning exactly them — not one generic tag-all message. Pictures come from `profilePictureUrl` (the PN form is used when a member is LID-addressed and the LID store knows the pair); the caption is built from a template with `{name}`, `{number}`, `{mention}`, `{jid}` placeholders; names come from a consumer-supplied `getName` resolver when provided, falling back to the number. Members without a profile picture get a text card, or the `fallbackImage` when set. Built-in anti-spam pacing: a delay between sends (`delayMs`, default 1500) and a member cap (`maxMembers`, default 30); `dm: true` delivers each card to the member's private chat instead. Returns a `{ total, sent, failed, skipped }` summary. Experimental, like the five features of 1.0.47.

### 🆕 What's new in 1.0.48 / Baru di 1.0.48

- 🩹 **Group Bad MAC now heals both layers.** The "Bad MAC" error (from Tenka's live log on 11 Nov 2026, the same LID address as the B-01 finding and the 1.0.46 flood) is thrown by `SessionCipher` — the whisper/E2E session layer — and in groups it can equally come from the sender-key layer. The old strike-limit path (1.0.14) for groups deleted only the sender key, so a rotten E2E session of the author was never touched and the failures repeated forever: the same wrong-layer class that 1.0.46 closed for session failures, now closed on the strike path. At the 3-failure limit, groups now reset the author's E2E session (including the alternate PN↔LID address record) AND drop the sender key, with the retry receipt carrying fresh keys. DM behaviour and the 3-strike threshold are unchanged. The `messages.decrypt-failure` event now distinguishes `errorClass: 'bad-mac'` from `'session'`/`'other'` (new exported predicate: `isBadMacError(text)`).

### 🧪 What's new in 1.0.47 / Baru di 1.0.47 — EXPERIMENTAL

- 🧪 **Five experimental features that exist only in AunuBaileys**, in a single version. All are attached automatically to the socket returned by `makeWASocket` and are explicitly experimental — semantics may change in any release: (1) **Invisible text watermark** — `sock.aunuWatermark(text, tag)` hides a short tag (bot name, campaign, build) inside message text as zero-width characters for leak tracing and fingerprinting; the visible text is unchanged; companions `aunuReadWatermark(text)` and `aunuStripWatermark(text)`, plus root utils `encodeWatermark`/`appendWatermark`/`extractWatermark`/`stripWatermark`. (2) **Human send** — `sock.aunuHumanSend(jid, content)`: shows "composing" for a plausible typing duration derived from the text length (util `computeTypingDuration`, clamped 700–8000 ms, ±20% jitter), then sends. (3) **Scheduled send** — `sock.aunuSchedule(jid, content, when)` (ms delay or Date) with `aunuCancelScheduled(id)` and `aunuListScheduled()`; in-memory, lost on restart. (4) **Self-destruct** — `sock.aunuSelfDestruct(jid, content, seconds)`: sends, then revokes the message for everyone after N seconds; `aunuCancelSelfDestruct(messageId)` cancels. (5) **Connection doctor** — `sock.aunuDoctor()`: one structured health snapshot (bundled WA version, registration state, open transport, known LID pair count, pending experimental timers).

### 🆕 What's new in 1.0.46 / Baru di 1.0.46

- 🩹 **The "Over 2000 messages into the future" flood now heals itself.** Session-layer decrypt failures — libsignal's aggregate "No matching sessions found for message" / "No session record" / "No sessions available", which includes the unfillable counter gap left by regressed session state (e.g. sessions restored from a backup while the sender kept sending; observed live in the Tenka deployment on 11 Nov 2026, on the same LID address as the old B-01 finding) — are now recognised from `messageStubParameters` and trigger an **immediate E2E session reset** instead of waiting for 3 failures: for DMs and groups alike (groups also drop the author's sender key), including the session record under its alternate PN↔LID address form, with the retry receipt carrying fresh keys. The old self-heal missed this flood because it waited 3 strikes, in groups only touched the sender key while the broken layer is the E2E session, and deletion could miss the aliased record. Other error classes (ordinary Bad MAC) keep the exact 1.0.14/1.0.17 3-strike behaviour. New exported classifier: `isUnrecoverableSessionError(text)`; the `messages.decrypt-failure` event gains an `errorClass` field (`'session'`/`'other'`) and `healed` now reflects a reset that actually happened on that message.

### 🆕 What's new in 1.0.45 / Baru di 1.0.45

- 📞 **VOIP call support (from plogme, original implementation)** — one combined release from an 8-package sweep (raiden-baileys, @neoxr/wb, @zervonex/baileys, @itsliaaa/starseal, alya-baileys, @ryuu-reinzz/baileys, @cogitator-ai/channels, plogme — all audited clean). New socket methods: `offerCall(jid, isVideo?)` and `groupCall(groupJid, participants, isVideo?)` build the `<offer>` with a per-device encrypted call-key envelope, `cancelGroupCall(groupJid, callId)`, and `acceptCall(callId, callFrom)` / `terminateCall(callId, callFrom, reason?)` join the existing `rejectCall`. Pure stanza builders are exported from `lib/Utils/call-utils.js` so the wire shapes are unit-testable. The stanza shapes follow the WhatsApp call protocol; the code is an original AunuBaileys implementation (plogme's license forbids copying its code). This is the signalling layer — two-way VOIP media is out of scope. plogme's voip-rekey decoder was **not** ported: the 6.7.24 proto has no `E2eRekeyPayload`.
- 🌐 **HTML messages — EXPERIMENTAL (Aunu's call):** content `{ html, trustedSources }` adds an `FOAHtmlPrimitiveDemoDONOTUSE` section to the unified response (or use `prepareHtmlMessage(...)`), and `{ richHtml: { html, title, tabs, ... } }` / `prepareRichHtmlMessage(...)` builds an interactive screen as an embedded screen (`GenAIaeacdsnwHtmlPrimitive` inside `FOAIDNixelButtonSheets` tabs) — the surface interactive HTML+JS lives on. The library transports the payload intact; whether the receiving WhatsApp client renders/executes it depends on the client version and is not guaranteed.
- 🏷️ **`addStickerExif(webpBuffer, { packId?, packname?, author?, emojis?, categories? })`** (the @itsliaaa/starseal idea): writes sticker EXIF metadata into a WebP buffer — an existing EXIF chunk is replaced, not stacked; non-WebP input is rejected.

### 🆕 What's new in 1.0.44 / Baru di 1.0.44

- 🖼️ **A third image backend: `@napi-rs/image`** in `getImageProcessingLibrary`, between sharp and jimp (priority: sharp → @napi-rs/image → jimp). `extractImageThumb` and `generateProfilePicture` gain a napi branch (Transformer: metadata + resize + quality-50 JPEG, matching the existing branches), and the package now declares `@napi-rs/image ^1.12.0` as an optional peer dependency. Consumers without sharp get a fast native path instead of falling back to jimp. Follows @itsliaaa/baileys.

### 🆕 What's new in 1.0.43 / Baru di 1.0.43

- 🎬 **Video thumbnails now invoke FFmpeg via `spawn` with an argument array** instead of a shell-executed command string (`exec`). `extractVideoThumb` builds the invocation as data rather than shell text, so a file path can no longer smuggle shell commands into it; the function signature and behaviour are unchanged (file output, same caller in `generateThumbnail`). The pattern follows @itsliaaa/baileys; their pipe-to-buffer redesign was **not** adopted because it would change this function's public behaviour.

### 🆕 What's new in 1.0.42 / Baru di 1.0.42

- 🧑‍💻 **Full rich responses: highlighted code blocks + tables** — completing the simple `aiRich` branch that has existed since the 1.0.2–1.0.4 era. Send `{ code, language }`, `{ table, title }`, `{ links }`, or prebuilt `{ richResponse }` submessages and the message routes to the new rich response builder (`lib/Utils/rich-message-utils.js`, exported: `tokenizeCode`, `prepareRichResponseMessage`, `toUnified`): code is tokenized per language (keyword tables for 12 languages + a lexer) into highlight blocks, tables become header + body rows, and the `unifiedResponse` rendering payload is assembled automatically. Two adaptations from the source (@itsliaaa/baileys), recorded plainly: **(1)** the source's donation-link fallbacks are removed — a link without a `url` is skipped and no third-party label/URL is ever injected; **(2)** the 6.7.24 proto has **no** `botForwardedMessage` field and no `BotMetadata.verificationMetadata`/`botResponseId`, so on this base the rich response is sent as the Message's own `richResponseMessage` field (the same shape as the existing `aiRich` branch) and the v7 bot-proof apparatus is not fabricated; the enums follow this proto's nested layout.

### 🆕 What's new in 1.0.41 / Baru di 1.0.41

- 🏷️ **The biz binary node machinery, plus the `secureMetaServiceLabel` option** — the 6.7.24 base never had the `biz` companion node that official clients attach to business/interactive message stanzas. This release ports it in full from @itsliaaa/baileys: `getBizBinaryNode()` (`actual_actors`/`host_storage`/`privacy_mode_ts` attributes + a `quality_control` child, with `native_flow` variants for known flow buttons and a `list` variant for list messages) and the `shouldIncludeBizBinaryNode()` decider. `relayMessage` now attaches the node **automatically** for buttons/list/template/native-flow messages, and the content option `secureMetaServiceLabel: true` forces it onto any message (the secure Meta service label). Both functions are exported for consumers who need to inspect or build the node themselves.

### 🆕 What's new in 1.0.40 / Baru di 1.0.40

- 🎁 **Four future-proof message wrapper options** — **`viewOnceV2: true`** wraps content into `viewOnceMessageV2`, **`viewOnceV2Extension: true`** into `viewOnceMessageV2Extension`, **`ephemeral: true`** into `ephemeralMessage`, and **`interactiveAsTemplate: true`** wraps an interactive message into a `templateMessage` (optional `templateId`; the `messageContextInfo` device-list metadata is preserved alongside, and using it on a non-interactive message throws a clear 400). The 6.7.24 proto already carries all four wrapper types — only the boolean options were missing. Adapted from @itsliaaa/baileys; classic `viewOnce` behaviour is unchanged.

### 🆕 What's new in 1.0.39 / Baru di 1.0.39

- 📰 **New `sock.newsletterSubscribed()`** — fetch **every newsletter this account follows** in one call, the newsletter analogue of `groupFetchAllParticipating()` that was missing until now (only `newsletterSubscribers(jid)`, the follower count of one newsletter, existed). Implemented over the same MEX path as the other newsletter methods: query id `6388546374527196`, path `xwa2_newsletter_subscribed` (WhatsApp's own MEX schema constants), added to the `QueryIds`/`XWAPaths` enums. Adapted from @itsliaaa/baileys.

### 🆕 What's new in 1.0.38 / Baru di 1.0.38

- 📰 **Ad-reply / link-preview cards as a direct message option** — attaching an `externalAdReply` card (title + thumbnail riding on top of a message) used to mean hand-assembling a full `contextInfo`. Now just pass `externalAdReply: { title, body, url, thumbnail, largeThumbnail }` in the message content: `url` maps to both `mediaUrl` and `sourceUrl`, `mediaType` defaults to 1 (image), and the result merges cleanly with an explicit `contextInfo` and with `mentions`/`mentionAll` when combined. One deliberate difference from the adaptation source (@itsliaaa/baileys): there, a missing `url` is silently replaced with the maintainer's donation link — here a missing url **stays empty**; this library never injects a third-party link into your messages. A non-Buffer thumbnail is rejected with a clear 400 error.

### 🆕 What's new in 1.0.37 / Baru di 1.0.37

- 📣 **Mention everyone in a group without listing a single JID** — until now, mentioning all group members meant building a `mentions` array of every participant JID yourself: heavy for large groups and impossible without group metadata. The new `mentionAll: true` message option sets WhatsApp's native `nonJidMentions` contextInfo flag, and receiving clients render it as a mass mention with no JID list at all. To carry the flag on the wire, `ContextInfo.nonJidMentions` (field 70, uint32 — matching the current WhatsApp proto) was added to this package's WAProto with full encode/decode/verify/fromObject/toObject support, proven by a byte-level roundtrip test. `mentionAll` combines freely with ordinary `mentions`; existing `mentions` behaviour is unchanged. Adapted from @itsliaaa/baileys.

### 🆕 What's new in 1.0.36 / Baru di 1.0.36

- 📜 **The license now carries the AunuCore Creative Network copyright** — the LICENSE file previously listed only the upstream (WhiskeySockets) copyright, even though AunuBaileys is developed and maintained by AunuCore Creative Network. The primary copyright line is now AunuCore Creative Network, with the upstream attribution retained directly below it exactly as the MIT License requires, plus one line explaining the package's origin. The license itself is unchanged: still MIT, the package.json `license` field is still "MIT", and package users' rights are exactly as before. No code changes in this release.

### 🆕 What's new in 1.0.35 / Baru di 1.0.35

- 📡 **Decrypt failures now emit a structured signal instead of a log flood** — one rotten session can fail hundreds of messages in minutes (B-01), and every failure was logged at ERROR level, drowning the logs while the bot had no programmatic way to know a Bad MAC flood was happening. Now: (1) the decrypt error log is throttled per sender address — first line immediately, then at most one line per minute per sender carrying the suppressed-failure count; (2) a new `messages.decrypt-failure` event carries the chat, sender, signal address, consecutive failure count, and whether this failure tripped the session/sender-key reset — consumers can alert and aggregate without parsing logs. The failure handling itself is unchanged. Closing release of the 1.0.14–1.0.35 fix train.

### 🆕 What's new in 1.0.34 / Baru di 1.0.34

- 🗳️ **One person no longer counts as two poll voters across the LID/PN split** — poll aggregation keyed voters by their raw message-key identity, so someone voting first as a phone number and later as a LID (or the reverse) counted as two different voters, and a poll update arriving in the other identity form piled up as a second entry instead of replacing the old one. `getAggregateVotesInPollMessage` and `updateMessageWithPollUpdate` now accept an optional `{ lidStore }` option: voters are canonicalized to their phone-number JID and deduped per option. Without a store, legacy behaviour is unchanged.

### 🆕 What's new in 1.0.33 / Baru di 1.0.33

- 💓 **One lost keep-alive pong no longer kills the connection** — upstream ended the connection as soon as the gap since last inbound traffic exceeded one interval + 5s; on a quiet connection the ping response is the only inbound traffic, so a single lost pong killed a healthy connection and forced a full reconnect. The connection is now ended only after two consecutive intervals without a reply; genuinely dead connections are still detected, one interval later.

### 🆕 What's new in 1.0.32 / Baru di 1.0.32

- 👥 **Group senders that arrive LID-only are now identifiable by phone number** — in groups, `key.participant` is increasingly a LID while `participantPn` is only sometimes included by the server, leaving phone-number-based sender identification blind. When the LID store knows the pair, the missing `participantPn` / `participantLid` is now filled in on the upsert path before the event reaches consumers. `key.participant` itself is NEVER rewritten — it is the E2E addressing identity the session/sender-key state is keyed by.

### 🆕 What's new in 1.0.31 / Baru di 1.0.31

- 📜 **History-sync record list no longer grows without bound in creds** — every history-sync notification appended an entry to `creds.processedHistoryMessages`, yet nothing anywhere reads those entries (the single read is an emptiness check for `isLatest`). The list lives in creds, so each entry bloated creds.json and was spread-copied and re-serialized on every save for the life of the account. Only the most recent 50 entries are now kept; `isLatest` semantics are unchanged.

### 🆕 What's new in 1.0.30 / Baru di 1.0.30

- 🟢 **Presence no longer vanishes across the LID/PN identity split** — presence stanzas increasingly arrive LID-addressed while consumers keyed the participant by phone-number JID (or the reverse), so their lookup missed and the contact looked permanently offline / never typing. When the LID store knows the pair, `presence.update` now also carries the presence under the alternate participant form; the original entry is unchanged.

### 🆕 What's new in 1.0.29 / Baru di 1.0.29

- 🧹 **Resend counters are now cleared when the retry limit is reached** — every message a peer asked us to resend left a permanent counter entry in the retry cache, removed only by the cache TTL (1h on the default cache — nothing at all on a consumer store without TTL), so entries accumulated without bound in a long-lived bot. The entry is now deleted when its count hits the limit, exactly like `sendRetryRequest` already does on the decrypt-retry path.

### 🆕 What's new in 1.0.28 / Baru di 1.0.28

- 📱 **Device lists no longer go stale after a device is linked or unlinked** — the server pushes a `devices` notification on such changes, but upstream only logged its own list and ignored everyone else's, so sends kept encrypting for the cached device set until the 5-minute TTL expired: a newly linked device received nothing and a removed device kept getting ciphertext. The notification now invalidates that user's cached entry, so the next send re-queries USync for the fresh list. The cache is also exposed as `sock.userDevicesCache` for explicit invalidation.

### 🆕 What's new in 1.0.27 / Baru di 1.0.27

- ⏱️ **New `getReconnectDelay(attempt, reason)` helper** — the companion to AunuAntiBan's `classifyDisconnect`: it turns a disconnect reason (Boom error, status code, or a classification result) into a suggested wait in milliseconds, or `null` when the connection must NOT be re-established automatically (logged out, replaced, bad session, 403). Server-requested restarts return 0; transient failures back off exponentially with Gaussian jitter (1s base, 60s cap); rate limits back off much longer (30s base, 15 min cap). `baseDelayMs` / `maxDelayMs` overrides available.

### 🆕 What's new in 1.0.26 / Baru di 1.0.26

- 📡 **`fetchLatestBaileysVersion` now remembers the last-good fetched version** — it is called on every reconnect and used to hit the network every time; a mid-session fetch failure silently downgraded to the bundled version, even though the endpoint value is the only server-accepted truth (see 1.0.13). Successful fetches are now cached for 10 minutes, and a later failure returns the last fetched version instead of the bundled one. New `forceRefresh` / `cacheTtlMs` options.

### 🆕 What's new in 1.0.25 / Baru di 1.0.25

- 🪪 **DM receipt status no longer gets stuck on LID addressing** — receipts increasingly arrive addressed to the peer's LID while consumers keyed the sent message by its phone-number JID (or the reverse), so the status update never matched and the message looked forever "sent". When the LID store knows the pair, DM `messages.update` events now carry the alternate form as `key.remoteJidAlt` (purely additive; `remoteJid` unchanged). Under the hood the LID store is now created once in the base socket layer, so the single instance the public `sock.aunuLid` learns into is the same one inner layers read — and the store gains a `getAltJid(jid)` helper.

### 🆕 What's new in 1.0.24 / Baru di 1.0.24

- 🖼️ **`profilePictureUrl` no longer throws for “no picture”** — a contact with no photo (or one hidden by privacy settings) made the server answer 401/404 and upstream let the Boom crash every caller that forgot a try/catch. Those statuses now resolve to `undefined`, consistent with the existing empty-picture-node case; real failures (timeouts, 5xx) still throw.

### 🆕 What's new in 1.0.23 / Baru di 1.0.23

- 🖼️ **Old-media downloads recover from 403** — the phone re-upload recovery path for failed media downloads only triggered on HTTP 404/410, but WhatsApp's media CDN answers **403** when a message's directPath/url auth has expired — the common case for older media. Downloads of old media therefore failed permanently even though the sender's phone could heal them. 403 now triggers the re-upload request; if the media is truly gone, the re-upload fails as well and the original error propagates unchanged.

### 🆕 What's new in 1.0.22 / Baru di 1.0.22

- 🗑️ **Cacheable key store honours deletions** — `makeCacheableSignalKeyStore` cached `null` values verbatim, but null means *deleted*: later gets returned a phantom present-but-null entry, and a value re-created in the store stayed hidden behind the cached null until the 5-minute TTL expired. Deletions now evict the cache entry, so the next get reads the store's authoritative state — which is exactly what makes `deleteSession`/`deleteSenderKey` (1.0.14/1.0.17) behave correctly through the recommended cacheable wiring. Both defects were reproduced before the fix and pass after it.

### 🆕 What's new in 1.0.21 / Baru di 1.0.21

- 💾 **saveCreds writes are coalesced** — during pairing, `creds.update` fires many times per second and every event used to queue a full atomic creds.json write. Concurrent `saveCreds()` calls now share one in-flight write, and a call landing mid-write schedules exactly one follow-up, so the file always ends with the latest creds — verified: a 30-call burst produced only ~2–3 real writes instead of 30.

### 🆕 What's new in 1.0.20 / Baru di 1.0.20

- ⏳ **Sends survive reconnect blips** — calling `sendMessage` while the connection is re-establishing used to fail instantly with a 428 from the first internal query, and the message was simply lost. `relayMessage` now waits for the transport to reopen (bounded by `connectTimeoutMs`; a permanently closed connection still fails fast, and a wait that expires raises a clear 408). When the connection is open, behaviour is unchanged.

### 🆕 What's new in 1.0.19 / Baru di 1.0.19

- 🛟 **A failed retry request can no longer kill your bot** — the retry-receipt path after a decrypt failure runs fire-and-forget (by design), but its promise had no error handler at all: one failure inside it became an unhandled rejection, and Node's default policy terminates the whole process. It now routes to the standard error handler — logged, contained, and the bot keeps processing messages.

### 🆕 What's new in 1.0.18 / Baru di 1.0.18

- 🔁 **Retry receipts: the peer's own key bundle is finally used** — when a recipient device asks for a resend, its retry receipt often embeds that device's own current key bundle. Upstream ignored it and always re-fetched a bundle from the server (extra round trip, and JID→bundle mapping is fragile for LID participants). AunuBaileys now parses the bundle (new exported `parseRetryReceiptSession`, unit-verified) and injects it as the fresh session for the resend, skipping the server fetch for that resend. Receipts without a bundle behave exactly as before.

### 🆕 What's new in 1.0.17 / Baru di 1.0.17

- 👥 **Group sender-key heal** — the 1.0.14 failure counter now covers group messages too: after 3 consecutive group decrypt failures from the same author in the same group, the stale sender-key record is deleted (new `signalRepository.deleteSenderKey`), so the next retry makes the author resend with a fresh distribution message and the group cipher rebuilds from scratch. One rotten sender-key record can no longer mute a group member forever.

### 🆕 What's new in 1.0.16 / Baru di 1.0.16

- 🪪 **Identity changes are handled, not just logged** — when WhatsApp notifies that a contact's identity changed (new phone / reinstall / recycled number), upstream Baileys logs “identity changed” and does nothing, leaving your stored session bound to the old identity so that contact's messages keep failing. AunuBaileys now deletes the stored session for that JID on the spot, so the next exchange re-initiates cleanly against the new identity.

### 🆕 What's new in 1.0.15 / Baru di 1.0.15

- 📤 **Send-side session heal** — the twin of 1.0.14 for outgoing messages: when the stored session for a JID is corrupt, `encryptMessage` throws and every send to that contact fails permanently. Now a session-flavoured encrypt error triggers an automatic heal — drop the session, fetch a fresh bundle from the server, encrypt once more. Non-session errors pass through untouched, and a second failure propagates (no retry loop).

### 🆕 What's new in 1.0.14 / Baru di 1.0.14

- 💊 **Bad MAC self-heal** — when a contact's E2E session rots (classic after re-pairing: every message from that one contact fails with “Bad MAC” forever), upstream Baileys just retries against the same stale session endlessly. AunuBaileys now counts consecutive decrypt failures per identity; at the 3rd, it **deletes the stale session** (new `signalRepository.deleteSession`) and forces the next retry receipt to carry fresh keys, so the peer re-initiates a clean session — the same reset dance official clients use. A successful decrypt zeroes the counter. Groups are excluded (sender-key class, handled separately).

### 🆕 What's new in 1.0.13 / Baru di 1.0.13

- 📵 **Bundled WhatsApp version corrected** — the previously bundled version `2.3000.1035194821` is now **rejected by WhatsApp's servers** (connection closed with code 405 at login; proven by a field probe on a real VPS deploy — handshake completes, the login node is sent, the server closes 405). The bundled default is now `2.3000.1043857760`, the version the official version endpoint currently reports as accepted — and the same deploy paired successfully with it. If your pairing suddenly fails with a 405 while your network is fine, this was it. Consumers who override `version` in their socket config are unaffected.

### 🆕 What's new in 1.0.12 / Baru di 1.0.12

- 🔑 **Pairing waits for the socket — and explains itself when it can't.** Field report from a real VPS deploy: `requestPairingCode` threw a bare Boom 428 "Connection Closed" every time, leaving consumers unable to tell an unready socket from a server rejection. Now `requestPairingCode` **waits internally (up to 30s) for the transport to open** before sending the pairing IQ, fails fast if the connection dies while waiting, and **every pairing failure carries the last disconnect reason** (status code + message) instead of the generic text. The 1.0.10 single-flight guard is kept and covers the wait.

### 🆕 What's new in 1.0.11 / Baru di 1.0.11

- 🚑 **Hotfix for broken 1.0.9 / 1.0.10 tarballs** — the published packages exported `./Utils/antiban.js` from `lib/index.js` but the file itself was never committed to the repository, so every install crashed on import with `ERR_MODULE_NOT_FOUND`. The AntiBan module (and its types) is now in the repo, and this release's tarball was verified with a clean install + import test. Also in: RafaelPivots' `INITIAL_PREKEY_COUNT` type correction (30 → 812, matching the runtime) and repository URLs updated to the repo's new home, **AunuCore/AunuBaileys-lib**. If you are on 1.0.9 or 1.0.10, upgrade to 1.0.11.

### 🆕 What's new in 1.0.10 / Baru di 1.0.10

- 🛠️ **Reliability hardening against classic upstream weaknesses** — (1) **Retry receipts now get answered even without a custom `getMessage` store:** a built-in per-socket sent-message cache (last 256 relayed messages, whatsmeow-style) backs up your store, ending the silent "message not available" failures behind stuck unreadable/undelivered messages. Disable with `sentMessagesCacheSize: 0`. (2) **Pairing is now single-flight:** `requestPairingCode` refuses to double-fire (double requests invalidate the first code) and refuses outright on already-registered sessions, with clear errors instead of silent corruption. (3) **Handshake timeout raised:** default `connectTimeoutMs` goes 20s → 60s so pairing no longer times out on slow networks.

### 🆕 What's new in 1.0.9 / Baru di 1.0.9

- 🪪 **LID identity layer** — WhatsApp is migrating identities from phone numbers to LIDs, and incoming stanzas already carry both forms. AunuBaileys now learns the mapping from live traffic: every socket exposes `sock.aunuLid`, a bidirectional PN <-> LID store with local `getLIDForPN()` / `getPNForLID()` lookups (no extra server queries), LRU capping, and optional JSON persistence. Prefer a standalone store? `makeLIDStore()` is exported from the package root, fully typed.

### 🆕 What's new in 1.0.8 / Baru di 1.0.8

- 🩹 **TypeScript declaration fix** — `NEWSLETTER_MEDIA_PATH_MAP` and `BIZ_BOT_SUPPORT_PAYLOAD` were exported from the runtime but missing from `lib/Defaults/index.d.ts`, so TypeScript consumers got compile errors importing them. Both are now properly declared. Found by the RafaelPivots automation, verified against source, no runtime changes.

### 🆕 What's new in 1.0.7 / Baru di 1.0.7

- 🧭 **One canonical repository** — the separate upstream-fork repo was retired (archived by the maintainers); `AunuHost/AunuBaileys-lib` is now the single public home of AunuBaileys, and this README — with badges pointing at the right repo — is the one npm ships.
- 📦 Metadata-only release: no code changes.

### 🆕 What's new in 1.0.6 / Baru di 1.0.6

- 📚 **Documentation site launched** — full docs (guides, complete API reference, recipes, troubleshooting) now live at **[docsjs.aunucore.eu.cc](https://docsjs.aunucore.eu.cc)**; it is also this package's npm homepage.
- 🚀 **Automated releases** — npm publishing now runs through GitHub Actions: every GitHub Release of this repo is published to npm automatically.
- 🧭 **One canonical home** — package `repository`/`bugs` and this README's badges now point at `AunuHost/AunuBaileys-lib`, the single source for the stable package.

### 🆕 What's new in 1.0.5 / Baru di 1.0.5

- 🛡️ **AunuAntiBan built in** — account-protection layer inspired by [baileys-antiban](https://github.com/kobie3717/baileys-antiban), reimplemented cleanly in-package: per-chat & global rate limiting with Gaussian jitter, 7-day warmup ramp for new accounts, group add/create guards, typing simulation, and `classifyDisconnect()` recovery advice. No telemetry, no extra network calls. Usage: `wrapAntiBan(sock)` or `new AunuAntiBan(opts).wrap(sock)`.

### 🆕 What's new in 1.0.4 / Baru di 1.0.4

- 🎨 **Rich builders** — `AIRich`, `Button`, `ButtonV2`, `Carousel`, `Toolkit` (+ aliases) for Meta AI-style rich responses, native-flow buttons and carousels; `aunuHandler.sendInteractive()` with automatic plain-text fallback on iOS-paired devices.
- 🖼️ **Profile pictures fixed** — center crop (was top-left) and jimp v1 compatibility restored.
- 🛡️ **Hardening** — undecodable app-state patches are skipped with a warning instead of killing sync, media downloads honour the message's own host, `getChatId` fails loudly, real `ev.destroy()` cleanup, group presence carries `groupOnlineCount`, `Browsers.android` added.
- ✅ Already verified in this codebase: PBKDF2 pairing derivation and the anti-spoof protocol-message guard (GHSA-qvv5-jq5g-4cgg class) match the reference implementations.

### 🆕 What's new in 1.0.3 / Baru di 1.0.3

- ⚡ **Modern core** — latest WA version `2.3000.1035194821`, 812 pre-keys, tuned WebSocket (no per-message deflate, 100 MB payload).
- 🧩 **More message types** — quiz polls (newsletter), poll result snapshots, poll updates, payment invites, order messages.
- 🛠️ **Developer API** — `sock.aunuHandler` (send/reply/react helpers), `fetchAccountReachoutTimelock()`, `fetchNewChatMessageCap()`, `registerSocketEndHandler()`, `newsletterId()` helper.

### 🆕 What's new in 1.0.2 / Baru di 1.0.2

- 📦 **Sticker packs** — send full sticker packs with `stickerPack` (cover + up to 60 stickers).
- 🖼️ **Album messages** — send grouped photos/videos with `album`.
- 📣 **Newsletter media fixed** — media uploads to channels use the proper newsletter paths.
- 🤖 **AI label** — mark bot replies with `ai: true` in private chats.
- 🔐 **Sturdier connections & sessions** — pre-key upload timeout + atomic session file writes.

**Credits:** features adapted from the community — [@itsliaaa/baileys](https://www.npmjs.com/package/@itsliaaa/baileys) (sticker pack, album, newsletter media, AI label, atomic auth writes), [MichelleBot/baileys](https://github.com/MichelleBot/baileys) (connection fix), [neoxr/baileys](https://github.com/neoxr/baileys) (sticker pack) — merged into AunuBaileys with gratitude. 🙏

---

## 🇮🇩 Bahasa Indonesia

**AunuBaileys** adalah fork dari library WhatsApp Web legendaris [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys), dirawat oleh **AunuCore Creative Network**. Upstream menghapus beberapa bagian yang menjadi fondasi ribuan script bot yang sudah berjalan lama — kami mengembalikannya dengan bersih, dan menjaga fork ini selalu sinkron dengan upstream.

📚 **Dokumentasi:** panduan lengkapnya ada di **[docsjs.aunucore.eu.cc](https://docsjs.aunucore.eu.cc)** — mulai cepat, koneksi & pairing, builders, AunuAntiBan, peta event lengkap, konfigurasi socket, resep, dan tabel troubleshooting kode disconnect.

### ✨ Yang membuatnya berbeda

- 🧠 **`makeInMemoryStore` kembali** — store in-memory lengkap: chat, kontak, pesan, label. Utuh dan bertipe.
- 🔑 **Ekspor lama dipulihkan** — `processedMessages`, `initInMemoryKeyStore()`, dan `PHONENUMBER_MCC`, simbol-simbol yang dicari script lama.
- 🔄 **Selalu sinkron** — ini fork GitHub sungguhan: perbaikan dan fitur upstream mengalir masuk terus-menerus, dengan lapisan patch AunuCore yang kecil dan bisa diaudit.
- 📱 **Pairing tanpa drama** — kode pairing custom dan alur koneksi modern, langsung dari kotaknya.
- 🧼 **Bersih dan transparan** — tanpa obfuscation, tanpa main belakang. Baca setiap barisnya; bedanya dari upstream kecil dan disengaja.

### 🚀 Mulai cepat

```bash
npm i aunubaileys
```

```ts
import makeWASocket, { useMultiFileAuthState, makeInMemoryStore } from 'aunubaileys'

const store = makeInMemoryStore({})
const { state, saveCreds } = await useMultiFileAuthState('auth')
const sock = makeWASocket({ auth: state })
store.bind(sock.ev)
sock.ev.on('creds.update', saveCreds)
```

### 🛠️ Lapisan patch AunuCore

| Bagian | Lokasi |
|---|---|
| Store in-memory | `lib/Store/` |
| Ekspor compat (`processedMessages`, `initInMemoryKeyStore`) | `lib/Utils/fork-compat.js` |
| Tabel `PHONENUMBER_MCC` | `lib/Utils/phonenumber-mcc.js` |

Selebihnya murni upstream. Setiap upstream bergerak, lapisan patch ini kami rebase — disiplin itu adalah alasan fork ini ada.

---

<div align="center">

Forged with 🖤 by **AunuCore Creative Network** · Fork of [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) · MIT License

</div>
