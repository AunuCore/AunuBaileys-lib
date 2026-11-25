<div align="center">

# 🖤 AunuBaileys

### The self-healing WhatsApp Web API for Node.js — for bots that never sleep.

[![npm version](https://img.shields.io/npm/v/@aunucore/baileys?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@aunucore/baileys)
[![npm downloads/week](https://img.shields.io/npm/dw/@aunucore/baileys?style=for-the-badge&logo=npm&logoColor=white&color=blue)](https://www.npmjs.com/package/@aunucore/baileys)
[![npm downloads total](https://img.shields.io/npm/dt/@aunucore/baileys?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/@aunucore/baileys)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow?style=for-the-badge)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/AunuCore/AunuBaileys-lib?style=for-the-badge&logo=github)](https://github.com/AunuCore/AunuBaileys-lib/stargazers)
[![Docs](https://img.shields.io/badge/docs-docsjs.aunucore.eu.cc-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://docsjs.aunucore.eu.cc)

**Bad MAC repairs itself. "2000 messages into the future" repairs itself. LID and phone-number identities stay in sync.**
Plus **35 experimental message methods no other Baileys fork ships** — and the store everyone thought was gone forever.

📚 **[Full documentation — docsjs.aunucore.eu.cc](https://docsjs.aunucore.eu.cc)** · [Quick start](#-quick-start) · [Experimental API](#-the-experimental-api--35-socket-methods) · [BanSentinel](#-bansentinel)

> 📦 This package was previously published as `aunubaileys` — that name is frozen at v1.0.73. Same project, new canonical name: `@aunucore/baileys`.

</div>

---

## 🌍 English

**AunuBaileys** is a fork of [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) maintained by **AunuCore Creative Network**.

**2.0.0 is a new base, not a patch release.** The library is now built on a frozen snapshot of the WhiskeySockets Baileys **v7 master** — commit `bb0a87e0326ca8f882fe716c7ee42da362f73fc0` — in TypeScript / ESM, with the complete AunuBaileys patch layer re-applied and re-verified on that base: the self-healing session layer, the LID identity layer, the restored in-memory store, the anti-ban stack, and all 35 experimental socket methods. Auth state created by the 1.0.x (v6) line loads without re-pairing.

> ⚠️ Not affiliated with WhatsApp Inc. Use at your own risk — automated accounts can be banned. `AunuAntiBan` and BanSentinel reduce risk; they cannot eliminate it.

### 💎 Why AunuBaileys

- 🩹 **Self-healing sessions** — Bad MAC and unrecoverable session errors (including the *"Over 2000 messages into the future"* flood) trigger an immediate E2E session reset instead of failing forever. Group sender-key rot heals too, on both layers. A dedicated `messages.decrypt-failure` event surfaces what happened, with the self-heal outcome attached.
- 🪪 **LID identity layer** — WhatsApp is migrating from phone numbers to LIDs; AunuBaileys learns the PN⇄LID mapping from live traffic (`sock.aunuLid`), fills in missing group attribution, dedupes poll voters across the split, and migrates sessions PN→LID automatically.
- 🧠 **`makeInMemoryStore` is still here** — chats, contacts, messages, labels: the full in-memory store upstream removed, restored and typed, and carried forward onto the v7 base. Legacy exports (`processedMessages`, `initInMemoryKeyStore()`, `PHONENUMBER_MCC`) are back too.
- 🛡️ **AunuAntiBan built in** — per-chat & global rate limiting with Gaussian jitter, 7-day warmup ramp, group-operation guards, typing simulation, `classifyDisconnect()` + `getReconnectDelay()` recovery advice. No telemetry, no extra network calls.
- 🚨 **BanSentinel (new in 2.0.0)** — a persistent anti-ban guard, **on by default**. It watches for ban signals — ban keywords in errors, dangerous disconnect codes (401 / 403 / 440), and bursts of failures — and, once tripped, blocks new connections for a cooldown period with a `Boom` 503 from its gate. The guard state persists in a guard file (`.baileys-ban-guard.json` by default) so a restart does not silently reset a tripped guard; a corrupt or unwritable guard file degrades to in-memory-only mode and never crashes the host. Disable it with `banSentinel: false` in the socket config, or pass an options object to tune it. The active sentinel is exposed as `sock.aunuBanSentinel` and the `AunuBanSentinel` class, `createBanSentinel`, and its guard stores are exported for direct use.
- 🧨 **Crash-payload guard** — `attachAunuBugGuard(sock)` detects force-close payloads (invisible-char floods, nesting bombs, mention floods) in incoming and outgoing messages before they can kill a client.
- 🔑 **Pairing that just works** — custom pairing codes, single-flight requests, readiness waits, and failure messages that carry the real disconnect reason.
- 🧪 **A real test suite, in the repo** — a regression suite under `test/` (Node's built-in test runner, no extra test dependencies), now **834 tests**, covering the export surface, the 35 experimental methods, BanSentinel, auth-state compatibility, the event buffer and store, internal caches and mutexes, and the re-applied hardening fixes. Fixes ship with regression tests that are mutation-checked (revert the fix and its test fails). CI runs the build and the suite on every push and pull request, and both publish workflows (npm and GitHub Packages) run the suite as a test job that must pass before the publish job is allowed to run.
- 📦 **Dependency diet** — runtime dependencies are down from 12 to **6**: `@hapi/boom`, `libsignal`, `pino`, `protobufjs`, `whatsapp-rust-bridge`, and `ws`. The small utilities that used to be external packages — the keyed database, the bounded caches, and the mutexes — are now internal modules, covered by the test suite.
- ✅ **Every release is tarball-verified** — each published version passes a clean-room install + import + API-surface audit before it is announced. No exceptions, no skipped versions.

### 🧪 The experimental API — 35 socket methods

Message manipulations that are **impossible in stock WhatsApp**, attached automatically to every socket from `makeWASocket`: 35 methods in total, counting the companion helpers (`aunuReadWatermark` / `aunuStripWatermark`, `aunuCancelScheduled` / `aunuListScheduled`, `aunuCancelSelfDestruct`). All experimental: semantics may change in any release. Honest limit: *the display lies, the content doesn't* — opening a faked item still reveals the real file.

The 35 methods: `aunuWatermark`, `aunuReadWatermark`, `aunuStripWatermark`, `aunuHumanSend`, `aunuSchedule`, `aunuCancelScheduled`, `aunuListScheduled`, `aunuSelfDestruct`, `aunuCancelSelfDestruct`, `aunuVanish`, `aunuDoctor`, `aunuPersonalTagAll`, `aunuPersonalCard`, `aunuCard`, `aunuSideText`, `aunuGhostMention`, `aunuFakeQuote`, `aunuFakeForward`, `aunuFakeDoc`, `aunuFakeVideo`, `aunuFakeVN`, `aunuFakeLocation`, `aunuFakeAlbum`, `aunuTrapImage`, `aunuGhostMessage`, `aunuPromoCode`, `aunuWordReact`, `aunuReactSequence`, `aunuTypewriter`, `aunuPostStatus`, `aunuBotSteps`, `aunuSendSpoiler`, `aunuSendGroupStatus`, `aunuSendA2UI`, `aunuSendEmojiSticker`.

| Method | What it does |
|---|---|
| `aunuWatermark` (+ `aunuReadWatermark` / `aunuStripWatermark`) | Hide an invisible zero-width tag inside message text — leak tracing & fingerprinting |
| `aunuHumanSend` | Show "composing…" for a plausible, text-length-based duration, then send |
| `aunuSchedule` (+ cancel/list) | In-memory scheduled sends |
| `aunuSelfDestruct` (+ cancel) | Send, then auto-revoke for everyone after N seconds |
| `aunuVanish` | Any content with a **custom per-message disappearing timer** (native expiry — no tombstone) |
| `aunuDoctor` | One structured connection-health snapshot |
| `aunuPersonalTagAll` | Tag-all where **every member gets a card with their own photo + name** |
| `aunuPersonalCard` | The one-person form of the personalised tag-all card |
| `aunuCard` | Interactive photo card with fused title/text and divider buttons (reply/url/copy/call, optional like/dislike) |
| `aunuSideText` | Text with a profile picture **at the side** — the group-menu preview layout |
| `aunuGhostMention` | Mention every group member invisibly — notified, but no @ pile-up in the text |
| `aunuFakeQuote` | Send a message carrying a fabricated quote |
| `aunuFakeForward` | The forwarded look: high forwarding score, optional channel attribution |
| `aunuFakeDoc` | A document displaying a fake size (default 2 GB) and page count (default 9,999) |
| `aunuFakeVideo` | A video claiming a fake duration (default 3600s) with a decoy thumbnail |
| `aunuFakeVN` | A voice note claiming a fake duration, with a full generated waveform |
| `aunuFakeLocation` | A location card with invented name, address, photo and coordinates |
| `aunuFakeAlbum` | An album header claiming more items than are sent — even a phantom album with zero items |
| `aunuTrapImage` | The preview thumbnail is a decoy; the photo that opens on tap is a different one |
| `aunuGhostMessage` | A bubble that renders completely empty (zero-width characters), optionally watermark-tagged |
| `aunuPromoCode` | A promo-code card with a built-in tap-to-copy button |
| `aunuWordReact` | A reaction containing a **word** instead of an emoji |
| `aunuReactSequence` | Cycle reactions on one message |
| `aunuTypewriter` | The message grows piece by piece via edits until the full text stands |
| `aunuPostStatus` | A styled text status (background colour + font) in one call |
| `aunuBotSteps` | AI-bot step-progress message that updates in place ("view details" step list) |
| `aunuSendSpoiler` | Spoiler-blurred media/text (proto field 118) |
| `aunuSendGroupStatus` | Post a status inside a group (proto field 103) |
| `aunuSendA2UI` | Declarative Bloks/A2UI widget messages (Text/Image/Video/Button/Card layouts) |
| `aunuSendEmojiSticker` | An emoji rendered as a 512×512 WebP sticker (from its Twemoji asset) and sent as a sticker |

### 📦 Also in the core

- 🗳️ **Modern polls** — Poll V6 (`hideVoter` / `canAddOption`, proto `pollCreationMessageV6`), **image polls**, `sendPoll` / `sendQuiz` / `sendPollPlus`, vote aggregation with LID⇄PN dedupe.
- 📣 **Channel AutoJoin** — `makeWASocket({ autoJoinChannels: [...], autoJoinLimit: 2 })` or `sock.aunuAutoJoinChannels()`; hard ceiling of 3 channels, framed as creator support.
- 🚫 **`sock.ignoreKey(rule)`** — drop matching inbound stanzas before any handler (never drops `'peer'` traffic).
- 🎨 **Rich responses** — code highlighting (12 languages), tables, link lists, LaTeX, Meta AI-style rich messages — with **no injected donation links, ever**. URLs are strictly user-supplied.
- 📞 **VOIP call signalling** — incoming calls surface as `call` events (with missed-call notification messages), `rejectCall(callId, callFrom)` declines an incoming call, and the exported `Utils/call-utils` builders (`buildCallOfferContent`, `buildCallControlStanza`, `buildGroupCallStanza`, `buildGroupCallCancelStanza`, `createCallKey`, `newCallId`) construct call stanzas for hosts that drive the signalling themselves. There are no `offerCall` / `groupCall` / `acceptCall` / `terminateCall` socket methods.
- 🖼️ **Sticker packs, albums, newsletter media** — the full send surface, including sticker packs (`stickerPackMessage`), plus `addStickerExif()`.
- 📰 **Newsletters** — `newsletterSubscribed()`, pinned-message metadata, quoting inside channels, `statusPrivacy` on status sends, and a dedicated `newsletter.status` event.

### 🚨 BanSentinel

BanSentinel is **enabled by default** in 2.0.0:

```ts
const sock = makeWASocket({
  auth: state,
  // BanSentinel is on by default — no configuration needed.
  // Turn it off completely:
  // banSentinel: false,
  // …or tune it with an options object:
  // banSentinel: { cooldownMs: 30 * 60 * 1000 },
})
```

When it trips — on a ban keyword, a dangerous disconnect code, or a burst of failures — new connection attempts are rejected with a `Boom` error carrying status code **503** until the cooldown expires. The trip state is persisted to its guard file so it survives restarts; inspect it at any time via `sock.aunuBanSentinel.status()`, and clear it deliberately with `sock.aunuBanSentinel.reset()`.

### 🚀 Quick start

```bash
npm i @aunucore/baileys
```

```ts
import makeWASocket, { useMultiFileAuthState, makeInMemoryStore } from '@aunucore/baileys'

const store = makeInMemoryStore({})
const { state, saveCreds } = await useMultiFileAuthState('auth')
const sock = makeWASocket({ auth: state })
store.bind(sock.ev)
sock.ev.on('creds.update', saveCreds)

// experimental API is already attached:
await sock.aunuGhostMention(groupJid, { text: 'meeting in 5' })
```

**Requirements:** Node.js ≥ 20. **ESM only** — the 2.x line is an ESM package with complete TypeScript types; there is no CommonJS entry point on the v7 base.

### 🛠️ The patch layer

| Piece | Where |
|---|---|
| In-memory store | `src/Store/` (built to `lib/Store/`) |
| Experimental socket API (35 methods) | `src/Socket/aunu-experimental.ts` |
| LID identity store (`sock.aunuLid`, `makeLIDStore()`) | `src/Utils/lid-store.ts` |
| AunuAntiBan | `src/Utils/antiban.ts` |
| BanSentinel | `src/Utils/ban-sentinel.ts` |
| Crash-payload guard | `src/Utils/aunu-bug-guard.ts` |
| Channel AutoJoin | `src/Utils/aunu-autojoin.ts` |
| Internal keyed-db / caches / mutexes | `src/Utils/` (internal modules, no external packages) |
| Compat exports (`processedMessages`, `initInMemoryKeyStore`) | `src/Utils/fork-compat.ts` |
| `PHONENUMBER_MCC` table | `src/Utils/phonenumber-mcc.ts` |

Everything else is the upstream v7 core, frozen at the snapshot commit above. The patch layer stays small and deliberate — that discipline is the whole point of this fork.

### 📰 Recent releases

- **2.7.0 — Post-marathon queue drained: 13 fixes, the queued addenda, and new send helpers.** The companion-registration flow no longer writes `creds.advSecretKey` before the `companion_finish` IQ succeeds (HB-480); a message is no longer marked acked before its receipt/ack send, so a throw no longer loses the upsert without a NACK (HB-481, including six more ack sites); `getMediaKeys` now strips any `data:<mediatype>;base64,` prefix, not only the literal empty-mediatype form (HB-482); ignored MESSAGE stanzas get a plain ack instead of a 500 NACK that caused a redelivery loop (HB-483); an empty cached device list is no longer treated as a cache hit that silently drops group members (HB-484); a throwing host `shouldSyncHistoryMessage` can no longer lock history sync in `AwaitingInitialSync` or silently drop a history-sync payload — at the `connection.update` gate, the `upsertMessage` gate, and the socket-construction site (HB-485, HB-486); host-supplied profile-picture and thumbnail dimensions are validated at the boundary and rejected with Boom 400 instead of surfacing raw image-library errors (HB-487); the product-image "already on WhatsApp" check now parses the URL hostname instead of matching a `.whatsapp.net` substring anywhere in the URL (HB-488); the device cache is keyed by the normalised JID (user + server), so `@hosted` and `@s.whatsapp.net` no longer share an entry (HB-489); and a pending chat update merged during absorption now wins over the snapshot, so archive/mute/pin are no longer silently discarded (HB-490). Restored regression: the `pollResult` builder is back — `sendMessage({ pollResult })` again builds a `pollResultSnapshotMessage` (field 88), or `pollResultSnapshotMessageV3` (field 115) for `pollType === 1`, instead of throwing "Invalid media type" (HB-491). The queued addenda land with it, including strict validation of encrypted session-backup envelopes and backup payloads before any file is touched (HB-478 facets 3–4), a default 10-second timeout for `fetchLatestWaWebVersion` (HB-450), exact key-length guards for identity and pre-key material (HB-2026-1112-26 facet 1, HB-98, HB-410 addendum), descriptive Boom errors instead of raw crypto/protobuf errors on the handshake and pairing paths (HB-238 addendum 2, HB-239), and Boom 408 instead of fabricated empty success on timed-out order/group/community fetches (HB-435 facets 1–2). New feature deltas: `sendSoundSticker` — a sound sticker whose WebP EXIF carries the audio's `"sound-sha256"` (StickerMessage field 26, no proto patching); the `renderWhatsApp` formatted-text renderer (bold/italic/code/link/mention AST to WhatsApp text, with a mention collector); `sender_drop` placeholders classified as their own kind and excluded from resends; a structured pending result for group joins that need approval; `syncSignalSession` with `force` / `reasonIdentity` options; and a streaming `history.sink` callback for history sync. Call-signalling, deferred from 2.6.0, is implemented clean-room from spec in this batch. Latency work from Aunu's audit: `assertSessions` now validates cold sessions in parallel instead of one by one (LAT-1), the fixed retry delay moved out of the global retry mutex so one slow retry no longer stalls the rest (LAT-2), and unmapped phone numbers now get a 60-second negative LID cache so repeat lookups skip the USync fetch until a mapping arrives (LAT-3). Sticker packs convert at most 4 stickers at a time instead of all 60 at once, bounding peak memory on small hosts (HB-492).
- **2.6.0 — Media, messages & auth hardening: 23 fixes, full-queue sweep.** Signed pre-key signatures are now verified against the identity key before a session is created (HB-410, MEDIUM — note: this verifies the signature only; it does not decide TOFU / `isTrustedIdentity`, which remains open). Ranged downloads validate 206 / `Content-Range` and reject 200-instead-of-206 (HB-417, HB-466); redirect `Location` parsing can no longer crash the process (HB-451); relative redirects keep `?auth=` / `?token=` (HB-457); frames over 16 MiB are rejected instead of silently truncated (HB-463); cross-host redirects are same-origin only (HB-465); padding errors no longer surface as raw Node crypto errors before the MAC check (HB-474). Media-retry success without `directPath` is a Boom 502, not a raw TypeError (HB-427); non-object message content is Boom 400 (HB-452); empty-object content branches (location, react, listReply, aiRich, groupInvite, buttonReply) are rejected with Boom 400 at the source (HB-253 addendum); the `CB:status` `<enc>` route now applies both ignore filters (HB-476); and the pair-success handler emits `creds.update` only after the pair-device-sign reply has gone out (HB-479). New opt-in `useNyxAuthState` (atomic writes, `.bak` auto-restore, corrupt-file quarantine, session backup export/import), a rewritten-from-spec presence tracker, Kage favicon link-preview and `clearChat` `deleteStarred`. Call-signaling is deferred to 2.7.0. 23 fixes + full addendum sweep; suite now **648 tests**.
- **2.5.0 — Retry hardening, poll-vote send & peer-triggered session throttle.** A throwing host device cache no longer aborts the send (HB-475: `getUSyncDevices` degrades to the USync fallback), poll votes can now be sent (`sendPollVote` + `encryptPollVote`, AES-GCM over the sha256 of each option, round-tripping against the existing receiver), encrypted status stanzas are routed to the message handler instead of the newsletter path, and the own participant is now resolved in the destination's addressing namespace (Kage LID addressing: `getMeParticipant` / `getQuotedParticipant`). Peer-triggered session recreation is throttled to once per peer per hour while MAC errors still recreate immediately (HB-405, revised split contract — the ledger's SPEC 1 as written would have broken HB-380 and was superseded), a failed placeholder-resend request no longer blocks re-requests for an hour (HB-418), and the store no longer clobbers a good message with a redelivered ciphertext stub (HB-2026-1113-223 addendum 7, store facet). 30 fixes + 3 feature deltas; suite now **441 tests**.
- **2.4.0 — Signal/LID/auth-state hardening.** A MEDIUM trial-decryption corruption is fixed (HB-446: the `msg` decrypt path advanced every candidate session's ratchet, silently corrupting the ones that did not win — it now snapshots the records first and restores the non-winners afterwards), LID learning finally reads the fields the decoder actually produces (HB-470, via the new exported `extractLIDPairsFromKey` helper), session commits no longer hold their per-key lock across the whole retry loop (HB-473), store merges no longer erase stored values with `undefined` stub fields (HB-411), permanent commit errors fail fast instead of burning every retry (HB-438), and one failed write inside a multi-key commit can no longer cascade into deleting pre-key files for sessions that were never saved. 18 queue numbers and 37 addenda closed; the suite grew 275 → 329.
- **2.3.0 — WAProto regenerated; self-SKDM healed; emoji stickers.** Protocol types rebuilt from `@wppconnect/wa-proto@2.3000.1055258835` (832 types, +191 new; the namespace is renamed to `waproto`, with `proto` kept as a compatibility alias), new experimental `aunuSendEmojiSticker` (an emoji sent as a 512×512 WebP sticker), and the accumulated queue drained again — 35 fixes + 34 addenda, including the HB-398 self-SKDM collision in LID groups, whose already-poisoned sender-key records now heal automatically on the first group send after upgrade (no manual auth-state cleanup needed).
- **2.2.0 — CRITICAL signature verification restored; the open queue drained.** `Curve.verify` discarded libsignal's `verifySignature` verdict and returned `true` unconditionally, silently disabling ADV account-signature validation and the Noise certificate-chain checks (HB-361, CRITICAL) — forged signatures are now rejected, proven by a regression probe against the published tarball. Also in this batch: an SSRF guard on peer-controlled media `directPath`s, `end()` no longer stalls ~30 s when a peer black-holes the close frame, peer identity is saved only after a successful decrypt, timed-out `set` IQs throw Boom 408 on eight paths instead of silently returning `undefined`, and all three file writers fsync before rename. 33 queue numbers and 44 addenda closed; the suite grew 143 → 163. One known-open item is disclosed, not hidden: HB-338 — libsignal's `SessionRecord` prints session key material to stdout on rotation; it is rooted inside the dependency and its mitigation is a maintainer design decision.
- **2.1.0 — whole-tree robustness hardening + leaner tarball.** Every file in `src/` was re-read against the guardrail standard; the release closed the entire open queue — 36 numbers and 25 addenda — with no public-API or protocol-semantics changes. The tarball shrank from 590 files / 9,554,314 B to 442 files / 7,918,739 B (the yarn-era `resolutions` block, sourcemaps and build-only scripts no longer ship), and the suite grew 111 → 143.
- **2.0.6 — dependency security updates.** protobufjs `^7.6.5` (four advisories, one HIGH), ws `^8.21.0` (one HIGH memory-exhaustion DoS, one MEDIUM), link-preview-js `^4.0.4` as an optional peer (two HIGH SSRF advisories) — all eight Dependabot alerts closed. No library code changed.
- **2.0.5 — group sender keys repaired (HB-327, CRITICAL) + nine more fixes.** In 2.0.0–2.0.4, sender-key records were written in a serialisation the loader could not restore, so every state was dropped on load and all group message encryption and decryption failed. Records now round-trip, and files written by the broken versions heal automatically on first load — no re-pairing. Also: media re-upload on a CDN 404/410 works again, the streaming sidecar is restored, forwarding and event messages validate their input, and the retry budget is counted once.
- **2.0.4 — nine v6 hardening fixes restored on the v7 base.** A batch of verified regressions from the rebase — each re-verified against the tree before patching, and locked in with a mutation-checked regression test (the suite is now 94 tests):
  - The three `CB:ib,,dirty` sync listeners (groups, communities, chats) can no longer crash the process with an unhandled rejection when the socket drops mid-sync — a failed dirty-bits sync is logged and life goes on.
  - Creating a newsletter channel without a picture or description no longer throws a raw `TypeError`; the missing fields come back as `undefined`.
  - A CDN drop in the middle of a media download now surfaces as a stream error to the consumer, instead of an uncaught exception in the process plus a download that hangs forever.
  - An empty download (a 200 response with no body) fails with a typed `Boom` 502 instead of a bare `TypeError`.
  - A media-retry receipt without its `<rmr>` node is skipped quietly instead of throwing and losing the `messages.media-update` event.
  - A malformed data URL with no comma separator is rejected with `Boom` 400, like every other unusable media shape.
  - `extensionForMediaMessage` returns `undefined` for missing or empty content instead of throwing.
  - `updateMediaMessage` gives up after 120 seconds when the companion device never answers, instead of waiting forever and leaking two listeners per call.
  - A malformed verified-name certificate riding on a message is ignored, so the message itself still decrypts and is delivered — previously the whole message was thrown away and the server kept redelivering it into the same failure.
- **2.0.3 — repository cleanup (metadata only).** The inherited upstream leftovers that are not part of AunuBaileys (demo media, the upstream example, dead Jest tooling, proto-extract, Yarn leftovers, archived upstream docs) were removed, the changelog became AunuBaileys' own, and the `whiskeysockets` package keyword was dropped. Library code identical to 2.0.2.
- **2.0.2 — three v6 hardening fixes restored.** The `CB:ib,,offline_preview` handler can no longer crash the process when the socket closes mid-send (HB-283); a malformed pre-key count from the server no longer silently skips the pre-key upload (HB-284); a malformed stream-error code can no longer make the `CB:stream:error` handler throw instead of disconnecting cleanly (HB-285).
- **2.0.1 — metadata release.** The npm tarball ships the canonical AunuCore LICENSE (AunuCore Creative Network first, upstream attribution retained). Library code identical to 2.0.0.
- **2.0.0 — the v7 base.** AunuBaileys rebased onto a frozen snapshot of WhiskeySockets Baileys v7 master (`bb0a87e0326ca8f882fe716c7ee42da362f73fc0`), TypeScript / ESM only. The full hardening programme from the 1.0.x line was re-applied and re-verified on the new base, together with the remaining queue. New: BanSentinel (on by default), the in-repo test suite with CI gating both publish workflows, and the dependency diet (runtime 12 → 6, with keyed-db / cache / mutex now internal). Also restored on the new base: recovery from `405` / `clientTooOld`, the `newsletter.status` event, and sticker packs. Existing v6 auth state loads with no re-pairing.
- **1.0.89 — README refresh; the v6 line closes.** README-only release — no library code changes. The 1.0.x line on the 6.7.24 base ends there; 2.0.0 is the next step.
- **1.0.74–1.0.88 — the hardening programme.** Fifteen themed fix releases that closed the entire verified bug queue on the v6 base. Every finding was re-verified against the tree before it was patched; claims that did not reproduce were recorded as disproven, not patched. **The verified bug queue reached zero on v6 — and was then re-verified on the v7 base for 2.0.0.**

Full changelog for every version since 1.0.2: **[docs](https://docsjs.aunucore.eu.cc)** · **[GitHub Releases](https://github.com/AunuCore/AunuBaileys-lib/releases)**.

### 🙏 Credits

Built on [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) (MIT). Individual features were adapted — with gratitude, and always re-implemented or verified against our tree — from community work including [@itsliaaa/baileys](https://www.npmjs.com/package/@itsliaaa/baileys), [@violetix/baileys](https://www.npmjs.com/package/@violetix/baileys) and the wider fork ecosystem our heartbeat audits every day. One standing rule: **silent monetization fallbacks are never ported** — this library never injects a third-party link into your messages.

### 📄 License

MIT — primary copyright **AunuCore Creative Network**, upstream WhiskeySockets attribution retained in [LICENSE](./LICENSE).

