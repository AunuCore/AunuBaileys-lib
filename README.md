<div align="center">

# 🖤 AunuBaileys

### The self-healing WhatsApp Web API for Node.js — for bots that never sleep.

[![npm version](https://img.shields.io/npm/v/aunubaileys?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/aunubaileys)
[![npm downloads/week](https://img.shields.io/npm/dw/aunubaileys?style=for-the-badge&logo=npm&logoColor=white&color=blue)](https://www.npmjs.com/package/aunubaileys)
[![npm downloads total](https://img.shields.io/npm/dt/aunubaileys?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/aunubaileys)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow?style=for-the-badge)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/AunuCore/AunuBaileys-lib?style=for-the-badge&logo=github)](https://github.com/AunuCore/AunuBaileys-lib/stargazers)
[![Docs](https://img.shields.io/badge/docs-docsjs.aunucore.eu.cc-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://docsjs.aunucore.eu.cc)

**Bad MAC repairs itself. "2000 messages into the future" repairs itself. LID and phone-number identities stay in sync.**
Plus **29 experimental message tricks no other Baileys fork ships** — and the store everyone thought was gone forever.

📚 **[Full documentation — docsjs.aunucore.eu.cc](https://docsjs.aunucore.eu.cc)** · [Quick start](#-quick-start) · [Experimental API](#-the-experimental-api--29-socket-methods) · [Bahasa Indonesia](#-bahasa-indonesia)

</div>

---

## 🌍 English

**AunuBaileys** is a fork of [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) maintained by **AunuCore Creative Network**. It keeps the battle-tested 6.7.24 core and adds a small, auditable patch layer: the pieces upstream removed, the self-healing upstream never built, and an experimental API for message manipulations that are impossible in stock WhatsApp.

> ⚠️ Not affiliated with WhatsApp Inc. Use at your own risk — automated accounts can be banned. `AunuAntiBan` reduces risk; it cannot eliminate it.

### 💎 Why AunuBaileys

- 🩹 **Self-healing sessions** — Bad MAC and unrecoverable session errors (including the *"Over 2000 messages into the future"* flood) trigger an immediate E2E session reset instead of failing forever. Group sender-key rot heals too, on both layers.
- 🪪 **LID identity layer** — WhatsApp is migrating from phone numbers to LIDs; AunuBaileys learns the PN⇄LID mapping from live traffic (`sock.aunuLid`), fills in missing group attribution, dedupes poll voters across the split, and migrates sessions PN→LID automatically.
- 🧠 **`makeInMemoryStore` is back** — chats, contacts, messages, labels: the full in-memory store upstream removed, restored and typed. Legacy exports (`processedMessages`, `initInMemoryKeyStore()`, `PHONENUMBER_MCC`) are back too.
- 🛡️ **AunuAntiBan built in** — per-chat & global rate limiting with Gaussian jitter, 7-day warmup ramp, group-operation guards, typing simulation, `classifyDisconnect()` + `getReconnectDelay()` recovery advice. No telemetry, no extra network calls.
- 🧨 **Crash-payload guard** — `attachAunuBugGuard(sock)` detects force-close payloads (invisible-char floods, nesting bombs, mention floods) in incoming and outgoing messages before they can kill a client.
- 🔑 **Pairing that just works** — custom pairing codes, single-flight requests, readiness waits, and failure messages that carry the real disconnect reason.
- ✅ **Every release is tarball-verified** — each published version passes a clean-room install + import + API-surface audit before it is announced. No exceptions, no skipped versions.

### 🧪 The experimental API — 29 socket methods

Message manipulations that are **impossible in stock WhatsApp**, attached automatically to every socket from `makeWASocket`. All experimental: semantics may change in any release. Honest limit: *the display lies, the content doesn't* — opening a faked item still reveals the real file.

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

### 📦 Also in the core

- 🗳️ **Modern polls** — Poll V6 (`hideVoter` / `canAddOption`), **image polls**, `sendPoll` / `sendQuiz` / `sendPollPlus`, vote aggregation with LID⇄PN dedupe.
- 📣 **Channel AutoJoin** — `makeWASocket({ autoJoinChannels: [...], autoJoinLimit: 2 })` or `sock.aunuAutoJoinChannels()`; hard ceiling of 3 channels, framed as creator support.
- 🚫 **`sock.ignoreKey(rule)`** — drop matching inbound stanzas before any handler (never drops `'peer'` traffic).
- 🎨 **Rich responses** — code highlighting (12 languages), tables, link lists, LaTeX, Meta AI-style rich messages — with **no injected donation links, ever**. URLs are strictly user-supplied.
- 📞 **VOIP call signalling** — `offerCall` / `groupCall` / `acceptCall` / `terminateCall` with per-device encrypted call-key envelopes.
- 🖼️ **Sticker packs, albums, newsletter media** — the full send surface, plus `addStickerExif()`.
- 📰 **Newsletters** — `newsletterSubscribed()`, pinned-message metadata, quoting inside channels, `statusPrivacy` on status sends.

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

// experimental API is already attached:
await sock.aunuGhostMention(groupJid, { text: 'meeting in 5' })
```

CommonJS works too (Node ≥ 20.19):

```js
const { default: makeWASocket, useMultiFileAuthState } = require('aunubaileys')
```

**Requirements:** Node.js ≥ 20. ESM-native with complete TypeScript types.

### 🛠️ The patch layer

| Piece | Where |
|---|---|
| In-memory store | `lib/Store/` |
| Experimental socket API (29 methods) | `lib/Socket/aunu-experimental.js` |
| LID identity store (`sock.aunuLid`, `makeLIDStore()`) | `lib/Utils/lid-store.js` |
| AunuAntiBan | `lib/Utils/antiban.js` |
| Crash-payload guard | `lib/Utils/aunu-bug-guard.js` |
| Channel AutoJoin | `lib/Utils/aunu-autojoin.js` |
| Compat exports (`processedMessages`, `initInMemoryKeyStore`) | `lib/Utils/fork-compat.js` |
| `PHONENUMBER_MCC` table | `lib/Utils/phonenumber-mcc.js` |

Everything else is the upstream core. The patch layer stays small and deliberate — that discipline is the whole point of this fork.

### 📰 Recent releases

- **1.0.73 — Heartbeat queue + a new README.** Three verified heartbeat fixes: a corrupt frame header can no longer wedge `decodeFrame` (zero-length headers are skipped, frames over 10 MiB fail loudly instead of buffering forever), `botRecentSecretsByChat` is capped at 1,000 chats FIFO, and bare key-store writes are serialized through the transaction mutex so a `migrateSession` commit can't overwrite a fresher session record. Plus a fully rewritten README and 46 curated npm keywords.
- **1.0.72 — Send integrity.** Fixes a critical regression in 1.0.71 that made `sendMessage` relay an empty message, plus auditor-verified fixes: media-cache contamination, sent-message cache LID/PN resolution, newsletter media stanza typing, USync backoff wired with a 60s clamp, and a 30-item heartbeat sweep (HB-61…HB-90).
- **1.0.71 — The farm batch.** Polls V6 + image polls, spoiler & group-status proto fields, A2UI widgets, the crash-payload detector, MEX username management, six USync protocols, msmsg decryption, heartbeat fixes HB-49…HB-59 — every viable harvest from a 2,500-package ecosystem sweep, in one release.

Full changelog for every version since 1.0.2: **[docs](https://docsjs.aunucore.eu.cc)** · **[GitHub Releases](https://github.com/AunuCore/AunuBaileys-lib/releases)**.

### 🙏 Credits

Built on [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) (MIT). Individual features were adapted — with gratitude, and always re-implemented or verified against our tree — from community work including [@itsliaaa/baileys](https://www.npmjs.com/package/@itsliaaa/baileys), [@violetix/baileys](https://www.npmjs.com/package/@violetix/baileys) and the wider fork ecosystem our heartbeat audits every day. One standing rule: **silent monetization fallbacks are never ported** — this library never injects a third-party link into your messages.

### 📄 License

MIT — primary copyright **AunuCore Creative Network**, upstream WhiskeySockets attribution retained in [LICENSE](./LICENSE).

---

## 🇮🇩 Bahasa Indonesia

**AunuBaileys** adalah fork dari [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) yang dirawat oleh **AunuCore Creative Network**: inti 6.7.24 yang sudah teruji, ditambah lapisan patch kecil yang bisa diaudit.

### 💎 Kenapa AunuBaileys

- 🩹 **Sesi sembuh sendiri** — Bad MAC dan error sesi tak-terpulihkan (termasuk banjir *"Over 2000 messages into the future"*) langsung memicu reset sesi E2E, bukan gagal selamanya.
- 🪪 **Lapisan identitas LID** — memetakan nomor telepon ⇄ LID dari trafik langsung (`sock.aunuLid`), melengkapi atribusi grup, dan memigrasi sesi secara otomatis.
- 🧠 **`makeInMemoryStore` kembali** — store in-memory lengkap yang dihapus upstream, plus ekspor legacy (`processedMessages`, `initInMemoryKeyStore()`, `PHONENUMBER_MCC`).
- 🛡️ **AunuAntiBan bawaan** — rate limit per-chat & global dengan jitter Gaussian, ramp warmup 7 hari, guard operasi grup, simulasi mengetik, dan saran pemulihan disconnect. Tanpa telemetri.
- 🧨 **Guard payload crash** — `attachAunuBugGuard(sock)` mendeteksi pesan force-close sebelum sempat membunuh client.
- 🧪 **29 metode eksperimental** — manipulasi pesan yang mustahil di WhatsApp biasa: watermark tak terlihat, tag-all personal (setiap anggota melihat foto + namanya sendiri), fake doc/video/VN/location/album, ghost mention, pesan hantu, spoiler, status grup, widget A2UI, dan lainnya. Batas jujurnya: *tampilannya yang berbohong, isinya tidak*.
- ✅ **Setiap rilis terverifikasi tarball** — install bersih + import + audit permukaan API sebelum diumumkan. Tanpa lompat versi.

### 🚀 Mulai cepat

```bash
npm i aunubaileys
```

```ts
import makeWASocket, { useMultiFileAuthState, makeInMemoryStore } from 'aunubaileys'

const { state, saveCreds } = await useMultiFileAuthState('auth')
const sock = makeWASocket({ auth: state })
sock.ev.on('creds.update', saveCreds)
```

Dokumentasi lengkap: **[docsjs.aunucore.eu.cc](https://docsjs.aunucore.eu.cc)** — panduan mulai, koneksi & pairing, builders, AunuAntiBan, peta event lengkap, resep, dan tabel troubleshooting kode disconnect.

> ⚠️ Tidak berafiliasi dengan WhatsApp Inc. Gunakan dengan risiko sendiri — akun otomatis bisa diblokir. `AunuAntiBan` mengurangi risiko, bukan menghilangkannya.

📄 **Lisensi:** MIT — copyright utama **AunuCore Creative Network**, atribusi upstream WhiskeySockets dipertahankan.
