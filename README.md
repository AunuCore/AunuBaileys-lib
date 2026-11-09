<div align="center">

# 🖤 AunuBaileys

### The WhatsApp Web API for bots that never sleep.

[![npm version](https://img.shields.io/npm/v/aunubaileys?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/aunubaileys)
[![npm downloads](https://img.shields.io/npm/dt/aunubaileys?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/aunubaileys)
[![Fork of WhiskeySockets/Baileys](https://img.shields.io/badge/fork%20of-WhiskeySockets%2FBaileys-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://github.com/WhiskeySockets/Baileys)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow?style=for-the-badge)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/AunuHost/AunuBaileys?style=for-the-badge&logo=github)](https://github.com/AunuHost/AunuBaileys/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/AunuHost/AunuBaileys?style=for-the-badge&logo=github)](https://github.com/AunuHost/AunuBaileys/forks)

**Full upstream power — with the soul that community forks used to have.**
The in-memory store is back, legacy exports are back, and every upstream update flows straight in.

[English](#-english) · [Bahasa Indonesia](#-bahasa-indonesia)

</div>

---

## 🌍 English

**AunuBaileys** is a fork of the legendary [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) WhatsApp Web API, maintained by **AunuCore Creative Network**. Upstream removed pieces that thousands of long-running bot scripts were built on — so we brought them back, cleanly, and keep this fork permanently in sync with upstream.

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
