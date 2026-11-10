# Changelog

## 1.0.15 — 2026-11-10 — Send-side session heal: pesan tidak terkirim karena sesi busuk di sisi kirim. Sisi terima sudah disembuhkan di 1.0.14; sisi kirim punya penyakit kembarnya: bila record sesi tersimpan untuk satu JID rusak/basi, `encryptMessage` melempar error sesi dan SETIAP pengiriman ke JID itu gagal permanen sampai restart / hapus auth manual. Sekarang kegagalan enkripsi yang berbau sesi (pesan error mengandung "session", mis. "No session found to encrypt") memicu penyembuhan otomatis: sesi dihapus, bundle segar diambil dari server (`assertSessions(jid, true)`), enkripsi dicoba tepat satu kali lagi. Error non-sesi diteruskan apa adanya; kegagalan pada percobaan kedua juga diteruskan — tidak ada loop.

- `lib/Socket/messages-send.js`

## 1.0.14 — 2026-11-10 — Bad MAC self-heal: sesi basi di-reset otomatis. Gejala lapangan: setelah rangkaian pairing ulang, sesi E2E dengan satu kontak membusuk — setiap pesan masuk dari kontak itu gagal dekripsi "Bad MAC" selamanya, karena upstream Baileys hanya mengirim retry receipt lalu mencoba dekripsi lagi melawan sesi basi yang sama, tanpa batas kesembuhan. Sekarang: kegagalan dekripsi per alamat sinyal dihitung; pada kegagalan ke-3 berturut-turut dari identitas yang sama, sesi basi itu DIHAPUS (`signalRepository.deleteSession`, metode baru) dan retry receipt berikutnya dipaksa membawa key bundle segar — persis tarian session-reset yang dipakai klien resmi agar lawan bicara membangun sesi baru (pkmsg) yang bisa didekripsi. Keberhasilan dekripsi meng-nol-kan penghitung. Grup dikecualikan (kelas sender-key ditangani terpisah). Penghapusan sesi terverifikasi unit-test menarget alamat yang tepat, termasuk alamat LID persis kasus lapangan (39772202483737.0).

- `lib/Socket/messages-recv.js`, `lib/Signal/libsignal.js`, `lib/Types/Signal.d.ts`

## 1.0.13 — 2026-11-10 — Koreksi versi WhatsApp bawaan: `[2, 3000, 1035194821]` DITOLAK server WhatsApp (koneksi ditutup dengan kode 405 saat login — terbukti lewat probe lapangan pada deploy Tenka di VPS: handshake selesai, node login terkirim, server langsung menutup 405; dengan versi endpoint resmi koneksi diterima dan pairing berhasil). Versi bawaan diganti ke `[2, 3000, 1043857760]`, versi yang saat ini diterima server menurut endpoint resmi yang sama dengan yang dipakai `fetchLatestBaileysVersion()`. Pelajaran yang tercatat: nomor versi lebih tinggi tidak berarti diterima server — build 1035194821 rupanya jalur beta yang sudah tidak diakui; nilai endpoint resmi adalah patokan kebenaran. Konsumen yang meng-override `version` di config socket tidak terpengaruh.

- `lib/Defaults/baileys-version.json`

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

