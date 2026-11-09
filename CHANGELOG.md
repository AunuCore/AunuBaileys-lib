# Changelog

## 2026-11-09 — Ditemukan bug nyata: `NEWSLETTER_MEDIA_PATH_MAP` dan `BIZ_BOT_SUPPORT_PAYLOAD` diekspor dari `lib/Defaults/index.js` tetapi tidak dideklarasikan di `lib/Defaults/index.d.ts`. Ini menyebabkan TypeScript consumers mendapat error saat mengimpor kedua simbol tersebut. Perbaikan: menambahkan deklarasi tipe yang sesuai di file `.d.ts`.

- `lib/Defaults/index.d.ts`

