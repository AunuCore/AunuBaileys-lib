<div align="center">

# 🖤 AunuBaileys

### The WhatsApp Web API for bots that never sleep.

[![npm version](https://img.shields.io/npm/v/aunubaileys?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/aunubaileys)
[![npm downloads](https://img.shields.io/npm/dt/aunubaileys?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/aunubaileys)
[![Fork of WhiskeySockets/Baileys](https://img.shields.io/badge/fork%20of-WhiskeySockets%2FBaileys-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://github.com/WhiskeySockets/Baileys)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow?style=for-the-badge)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/AunuHost/AunuBaileys-lib?style=for-the-badge&logo=github)](https://github.com/AunuHost/AunuBaileys-lib/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/AunuHost/AunuBaileys-lib?style=for-the-badge&logo=github)](https://github.com/AunuHost/AunuBaileys-lib/forks)

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
