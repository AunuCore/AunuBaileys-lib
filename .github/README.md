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
Plus **34 experimental message methods no other Baileys fork ships** — and the store everyone thought was gone forever.

📚 **[Full documentation — docsjs.aunucore.eu.cc](https://docsjs.aunucore.eu.cc)** · [Quick start](#-quick-start) · [Experimental API](#-the-experimental-api--34-socket-methods) · [BanSentinel](#-bansentinel)

> 📦 This package was previously published as `aunubaileys` — that name is frozen at v1.0.73. Same project, new canonical name: `@aunucore/baileys`.

</div>

---

## 🌍 English

**AunuBaileys** is a fork of [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) maintained by **AunuCore Creative Network**.

**2.0.0 is a new base, not a patch release.** The library is now built on a frozen snapshot of the WhiskeySockets Baileys **v7 master** — commit `bb0a87e0326ca8f882fe716c7ee42da362f73fc0` — in TypeScript / ESM, with the complete AunuBaileys patch layer re-applied and re-verified on that base: the self-healing session layer, the LID identity layer, the restored in-memory store, the anti-ban stack, and all 34 experimental socket methods. Auth state created by the 1.0.x (v6) line loads without re-pairing.

> ⚠️ Not affiliated with WhatsApp Inc. Use at your own risk — automated accounts can be banned. `AunuAntiBan` and BanSentinel reduce risk; they cannot eliminate it.

### 💎 Why AunuBaileys

- 🩹 **Self-healing sessions** — Bad MAC and unrecoverable session errors (including the *"Over 2000 messages into the future"* flood) trigger an immediate E2E session reset instead of failing forever. Group sender-key rot heals too, on both layers. A dedicated `messages.decrypt-failure` event surfaces what happened, with the self-heal outcome attached.
- 🪪 **LID identity layer** — WhatsApp is migrating from phone numbers to LIDs; AunuBaileys learns the PN⇄LID mapping from live traffic (`sock.aunuLid`), fills in missing group attribution, dedupes poll voters across the split, and migrates sessions PN→LID automatically.
- 🧠 **`makeInMemoryStore` is still here** — chats, contacts, messages, labels: the full in-memory store upstream removed, restored and typed, and carried forward onto the v7 base. Legacy exports (`processedMessages`, `initInMemoryKeyStore()`, `PHONENUMBER_MCC`) are back too.
- 🛡️ **AunuAntiBan built in** — per-chat & global rate limiting with Gaussian jitter, 7-day warmup ramp, group-operation guards, typing simulation, `classifyDisconnect()` + `getReconnectDelay()` recovery advice. No telemetry, no extra network calls.
- 🚨 **BanSentinel (new in 2.0.0)** — a persistent anti-ban guard, **on by default**. It watches for ban signals — ban keywords in errors, dangerous disconnect codes (401 / 403 / 440), and bursts of failures — and, once tripped, blocks new connections for a cooldown period with a `Boom` 503 from its gate. The guard state persists in a guard file (`.baileys-ban-guard.json` by default) so a restart does not silently reset a tripped guard; a corrupt or unwritable guard file degrades to in-memory-only mode and never crashes the host. Disable it with `banSentinel: false` in the socket config, or pass an options object to tune it. The active sentinel is exposed as `sock.aunuBanSentinel` and the `AunuBanSentinel` class, `createBanSentinel`, and its guard stores are exported for direct use.
- 🧨 **Crash-payload guard** — `attachAunuBugGuard(sock)` detects force-close payloads (invisible-char floods, nesting bombs, mention floods) in incoming and outgoing messages before they can kill a client.
- 🔑 **Pairing that just works** — custom pairing codes, single-flight requests, readiness waits, and failure messages that carry the real disconnect reason.
- 🧪 **A real test suite, in the repo** — 2.0.0 ships a regression suite under `test/` (Node's built-in test runner, no extra test dependencies) covering the export surface, the 34 experimental methods, BanSentinel, auth-state compatibility, the event buffer and store, internal caches and mutexes, and the re-applied hardening fixes. CI runs the build and the suite on every push and pull request, and both publish workflows (npm and GitHub Packages) run the suite as a test job that must pass before the publish job is allowed to run.
- 📦 **Dependency diet** — runtime dependencies are down from 12 to **6**: `@hapi/boom`, `libsignal`, `pino`, `protobufjs`, `whatsapp-rust-bridge`, and `ws`. The small utilities that used to be external packages — the keyed database, the bounded caches, and the mutexes — are now internal modules, covered by the test suite.
- ✅ **Every release is tarball-verified** — each published version passes a clean-room install + import + API-surface audit before it is announced. No exceptions, no skipped versions.

### 🧪 The experimental API — 34 socket methods

Message manipulations that are **impossible in stock WhatsApp**, attached automatically to every socket from `makeWASocket`: 34 methods in total, counting the companion helpers (`aunuReadWatermark` / `aunuStripWatermark`, `aunuCancelScheduled` / `aunuListScheduled`, `aunuCancelSelfDestruct`). All experimental: semantics may change in any release. Honest limit: *the display lies, the content doesn't* — opening a faked item still reveals the real file.

The 34 methods: `aunuWatermark`, `aunuReadWatermark`, `aunuStripWatermark`, `aunuHumanSend`, `aunuSchedule`, `aunuCancelScheduled`, `aunuListScheduled`, `aunuSelfDestruct`, `aunuCancelSelfDestruct`, `aunuVanish`, `aunuDoctor`, `aunuPersonalTagAll`, `aunuPersonalCard`, `aunuCard`, `aunuSideText`, `aunuGhostMention`, `aunuFakeQuote`, `aunuFakeForward`, `aunuFakeDoc`, `aunuFakeVideo`, `aunuFakeVN`, `aunuFakeLocation`, `aunuFakeAlbum`, `aunuTrapImage`, `aunuGhostMessage`, `aunuPromoCode`, `aunuWordReact`, `aunuReactSequence`, `aunuTypewriter`, `aunuPostStatus`, `aunuBotSteps`, `aunuSendSpoiler`, `aunuSendGroupStatus`, `aunuSendA2UI`.

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

- 🗳️ **Modern polls** — Poll V6 (`hideVoter` / `canAddOption`, proto `pollCreationMessageV6`), **image polls**, `sendPoll` / `sendQuiz` / `sendPollPlus`, vote aggregation with LID⇄PN dedupe.
- 📣 **Channel AutoJoin** — `makeWASocket({ autoJoinChannels: [...], autoJoinLimit: 2 })` or `sock.aunuAutoJoinChannels()`; hard ceiling of 3 channels, framed as creator support.
- 🚫 **`sock.ignoreKey(rule)`** — drop matching inbound stanzas before any handler (never drops `'peer'` traffic).
- 🎨 **Rich responses** — code highlighting (12 languages), tables, link lists, LaTeX, Meta AI-style rich messages — with **no injected donation links, ever**. URLs are strictly user-supplied.
- 📞 **VOIP call signalling** — `offerCall` / `groupCall` / `acceptCall` / `terminateCall` with per-device encrypted call-key envelopes.
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

**Requirements:** Node.js ≥ 20. **ESM only** — 2.0.0 is an ESM package with complete TypeScript types; there is no CommonJS entry point on the v7 base.

### 🛠️ The patch layer

| Piece | Where |
|---|---|
| In-memory store | `src/Store/` (built to `lib/Store/`) |
| Experimental socket API (34 methods) | `src/Socket/aunu-experimental.ts` |
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

- **2.0.0 — the v7 base.** AunuBaileys rebased onto a frozen snapshot of WhiskeySockets Baileys v7 master (`bb0a87e0326ca8f882fe716c7ee42da362f73fc0`), TypeScript / ESM only. The full hardening programme from the 1.0.x line was re-applied and re-verified on the new base, together with the remaining queue. New: BanSentinel (on by default), the in-repo test suite with CI gating both publish workflows, and the dependency diet (runtime 12 → 6, with keyed-db / cache / mutex now internal). Also restored on the new base: recovery from `405` / `clientTooOld`, the `newsletter.status` event, and sticker packs. Existing v6 auth state loads with no re-pairing.
- **1.0.89 — README refresh; the v6 line closes.** README-only release — no library code changes. The 1.0.x line on the 6.7.24 base ends there; 2.0.0 is the next step.
- **1.0.74–1.0.88 — the hardening programme.** Fifteen themed fix releases that closed the entire verified bug queue on the v6 base. Every finding was re-verified against the tree before it was patched; claims that did not reproduce were recorded as disproven, not patched. **The verified bug queue reached zero on v6 — and was then re-verified on the v7 base for 2.0.0.**

Full changelog for every version since 1.0.2: **[docs](https://docsjs.aunucore.eu.cc)** · **[GitHub Releases](https://github.com/AunuCore/AunuBaileys-lib/releases)**.

### 🙏 Credits

Built on [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) (MIT). Individual features were adapted — with gratitude, and always re-implemented or verified against our tree — from community work including [@itsliaaa/baileys](https://www.npmjs.com/package/@itsliaaa/baileys), [@violetix/baileys](https://www.npmjs.com/package/@violetix/baileys) and the wider fork ecosystem our heartbeat audits every day. One standing rule: **silent monetization fallbacks are never ported** — this library never injects a third-party link into your messages.

### 📄 License

MIT — primary copyright **AunuCore Creative Network**, upstream WhiskeySockets attribution retained in [LICENSE](./LICENSE).
