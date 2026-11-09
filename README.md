# AunuBaileys

Fork resmi **@whiskeysockets/baileys 6.7.24** yang dirawat AunuCore (AunuXdev) —
mengembalikan fitur yang dihapus Baileys 6.7 dan diandalkan script bot lama
(gaya lilys/canta), dengan implementasi bersih. Lisensi MIT (sama seperti upstream,
atribusi WhiskeySockets dipertahankan — lihat LICENSE dan README-UPSTREAM.md).

## Yang berbeda dari Baileys resmi 6.7.24

1. **`makeInMemoryStore` kembali** — di-backport dari Baileys 6.6.0 dan dikonversi
   ke ESM (`lib/Store/`), lengkap dengan `waChatKey`, `waMessageID`,
   `waLabelAssociationKey`. Dependency `@adiwajshing/keyed-db` ditambahkan lagi.
2. **Ekspor compat fork** (`lib/Utils/fork-compat.js`):
   - `processedMessages` — Map registry pesan terproses (dedup).
   - `initInMemoryKeyStore()` — Signal key store murni in-memory yang kompatibel
     dengan kontrak resmi (get/set/clear), pasangan `makeCacheableSignalKeyStore`.
3. **`PHONENUMBER_MCC` kembali** (`lib/Utils/phonenumber-mcc.js`) — tabel MCC
   dari 6.6.0 yang dihapus di 6.7.
4. Skrip build upstream dibuang dari package.json (paket ini distribusi lib-only).

Selebihnya identik dengan upstream 6.7.24, termasuk versi WhatsApp bawaan
(2.3000.1043857760) dan dukungan pairing code custom
`requestPairingCode(nomor, "KODEMU")`.

## Pakai

```bash
npm i aunubaileys
# atau sebagai pengganti drop-in fork lama di bot yang mengimpor 'lilys-baileys':
npm i "lilys-baileys@npm:aunubaileys"
```

```js
const { default: makeWASocket, useMultiFileAuthState, makeInMemoryStore } = require('aunubaileys');
const store = makeInMemoryStore({});
```

## Uji yang sudah lolos

- Semua ekspor yang dibutuhkan script Tenka Izumo (20 simbol) tersedia.
- Store: bind, contacts, loadMessage, writeToFile/readFromFile berfungsi.
- initInMemoryKeyStore: set/get/delete sesuai kontrak.
- Socket mencapai status `connecting` ke server WhatsApp.
- Bot Tenka Izumo boot sampai prompt pairing memakai paket ini.

## Sinkronisasi upstream (penting — jangan jadi fork mati)

Paket ini disusun dari dua tarball resmi oleh `scripts/assemble-fork.py`:

```bash
python3 scripts/assemble-fork.py 6.7.24 6.6.0   # <versi basis baru> <versi sumber store>
npm i --legacy-peer-deps
```

Jalankan setiap ada rilis 6.7.x baru dari WhiskeySockets, uji, lalu naikkan
versi fork (`6.7.25-aunu.1`, dst). Kode patch AunuCore hanya di: `lib/Store/`,
`lib/Utils/fork-compat.js`, `lib/Utils/phonenumber-mcc.js`, dua baris ekspor di
`lib/index.js`, dan package.json — sisanya murni upstream.
