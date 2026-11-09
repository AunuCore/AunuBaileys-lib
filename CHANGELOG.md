# Changelog

## 1.0.9 — 2026-11-09 — Lapisan identitas LID: store PN <-> LID dua arah (`makeLIDStore`) yang belajar otomatis dari lalu lintas pesan masuk (stanza sudah membawa `sender_pn`/`sender_lid` dan `participant_pn`/`participant_lid`). Socket mengekspos instans auto-learning sebagai `sock.aunuLid` dengan lookup lokal `getLIDForPN` / `getPNForLID` tanpa query server tambahan; store standalone mendukung batas LRU (default 5000), persistensi JSON (`saveToFile`/`loadFromFile`), dan deklarasi TypeScript penuh.

- `lib/Utils/lid-store.js`
- `lib/Utils/lid-store.d.ts`
- `lib/Socket/index.js`
- `lib/index.js`
- `lib/index.d.ts`

## 2026-11-09 — Ditemukan bug nyata: `NEWSLETTER_MEDIA_PATH_MAP` dan `BIZ_BOT_SUPPORT_PAYLOAD` diekspor dari `lib/Defaults/index.js` tetapi tidak dideklarasikan di `lib/Defaults/index.d.ts`. Ini menyebabkan TypeScript consumers mendapat error saat mengimpor kedua simbol tersebut. Perbaikan: menambahkan deklarasi tipe yang sesuai di file `.d.ts`.

- `lib/Defaults/index.d.ts`

