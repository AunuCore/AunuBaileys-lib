# Changelog

## 1.0.12 — 2026-11-10 — Pairing tidak lagi menembak IQ ke socket yang belum terbuka. Laporan lapangan (deploy Tenka di VPS): `requestPairingCode` selalu melempar Boom 428 "Connection Closed" generik dari sendRawMessage — konsumen tidak bisa membedakan socket yang belum siap, koneksi yang ditolak server, atau handshake yang mati. Sekarang: (1) `requestPairingCode` menunggu kesiapan transport secara internal hingga 30 detik sebelum mengirim IQ pairing (fast-fail begitu koneksi mati, bukan menunggu timeout penuh); (2) setiap kegagalan pairing menyertakan alasan disconnect terakhir (status code + pesan, dilacak dari jalur `end()` socket) — bukan lagi "Connection Closed" polos; (3) single-flight 1.0.10 dipertahankan dan mencakup masa tunggu. Patch ini memperbaiki perilaku & diagnosabilitas library; penyebab socket tidak terbuka di host tertentu (reachability vs penolakan handshake) tetap urusan diagnostik host dan kini terlihat dari pesan errornya.

- `lib/Socket/socket.js`

## 1.0.11 — 2026-11-10 — HOTFIX: tarball 1.0.9 dan 1.0.10 rusak saat diterbitkan — `lib/index.js` mengekspor `./Utils/antiban.js`, tetapi file `lib/Utils/antiban.js` (dan `.d.ts`-nya) tidak pernah ter-commit ke repo sejak 1.0.5, sehingga paket yang terbit tidak konsisten internal dan semua installer kena `ERR_MODULE_NOT_FOUND` saat import. Kedua file kini ter-commit, dan tarball hasil publish diverifikasi dengan install bersih + uji import sebelum rilis ini dinyatakan selesai. Rilis ini juga membawa perbaikan tipe dari RafaelPivots (10 Nov): `INITIAL_PREKEY_COUNT` di `lib/Defaults/index.d.ts` dikoreksi 30 -> 812 agar sesuai nilai runtime, serta URL repository di package.json diperbarui ke rumah baru repo: `AunuCore/AunuBaileys-lib`.

- `lib/Utils/antiban.js`
- `lib/Utils/antiban.d.ts`
- `lib/Defaults/index.d.ts`
- `package.json`

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

