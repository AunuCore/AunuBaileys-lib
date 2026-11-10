# Changelog

## 2026-11-10 — Ditemukan inkonsistensi nyata: `INITIAL_PREKEY_COUNT` dideklarasikan sebagai literal `30` di `lib/Defaults/index.d.ts` tetapi runtime JS mengekspor `812`. TypeScript consumers yang bergantung pada literal type akan mendapat nilai yang salah. Perbaikan: update deklarasi `.d.ts` agar sesuai dengan nilai runtime `812`.

- `lib/Defaults/index.d.ts`

## 1.0.10 — 2026-11-09 — Hardening keandalan melawan kelemahan klasik Baileys upstream: (1) retry receipt kini bisa dijawab tanpa `getMessage` kustom — cache pesan terkirim bawaan (FIFO 256 pesan per socket, pola whatsmeow) menjadi fallback saat store aplikasi kosong, mengakhiri kegagalan "message not available" yang membuat pesan macet tidak terbaca/tidak terkirim; nonaktifkan dengan `sentMessagesCacheSize: 0`. (2) `requestPairingCode` kini single-flight dan menolak dipanggil pada sesi yang sudah registered — dua penyebab klasik gagal pairing dari loop reconnect. (3) Default `connectTimeoutMs` naik 20000 -> 60000 ms agar handshake/pairing tidak timeout di jaringan lambat. Catatan jujur: tulis auth sebenarnya sudah atomik (tmp+rename) dan terkunci mutex per-file sejak 1.0.2, dan kirim saat koneksi tertutup sudah gagal keras (Boom Connection Closed) di basis — keduanya diaudit, bukan diperbaiki ulang.

- `lib/Utils/sent-message-cache.js`
- `lib/Utils/sent-message-cache.d.ts`
- `lib/Socket/messages-send.js`
- `lib/Socket/messages-recv.js`
- `lib/Socket/socket.js`
- `lib/Defaults/index.js`
- `lib/Types/Socket.d.ts`

## 1.0.9 — 2026-11-09 — Lapisan identitas LID: store PN <-> LID dua arah (`makeLIDStore`) yang belajar otomatis dari lalu lintas pesan masuk (stanza sudah membawa `sender_pn`/`sender_lid` dan `participant_pn`/`participant_lid`). Socket mengekspos instans auto-learning sebagai `sock.aunuLid` dengan lookup lokal `getLIDForPN` / `getPNForLID` tanpa query server tambahan; store standalone mendukung batas LRU (default 5000), persistensi JSON (`saveToFile`/`loadFromFile`), dan deklarasi TypeScript penuh.

- `lib/Utils/lid-store.js`
- `lib/Utils/lid-store.d.ts`
- `lib/Socket/index.js`
- `lib/index.js`
- `lib/index.d.ts`

## 2026-11-09 — Ditemukan bug nyata: `NEWSLETTER_MEDIA_PATH_MAP` dan `BIZ_BOT_SUPPORT_PAYLOAD` diekspor dari `lib/Defaults/index.js` tetapi tidak dideklarasikan di `lib/Defaults/index.d.ts`. Ini menyebabkan TypeScript consumers mendapat error saat mengimpor kedua simbol tersebut. Perbaikan: menambahkan deklarasi tipe yang sesuai di file `.d.ts`.

- `lib/Defaults/index.d.ts`

