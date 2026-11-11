# Changelog

## 1.0.40 — 2026-11-11 — Empat opsi pembungkus pesan baru yang proaktif ke tipe pesan masa depan WhatsApp: **`viewOnceV2: true`** membungkus isi ke `viewOnceMessageV2`, **`viewOnceV2Extension: true`** ke `viewOnceMessageV2Extension`, **`ephemeral: true`** ke `ephemeralMessage`, dan **`interactiveAsTemplate: true`** membungkus pesan interaktif ke `templateMessage` (dengan `templateId` opsional; `messageContextInfo` berisi metadata daftar perangkat dipertahankan di sisinya, dan pemakaian pada pesan non-interaktif ditolak dengan error 400). Proto 6.7.24 sudah memuat keempat tipe pembungkus ini — yang belum ada hanya opsi booleannya. Diadaptasi dari @itsliaaa/baileys; perilaku `viewOnce` lama tidak berubah.

- `lib/Utils/messages.js`, `lib/Types/Message.d.ts`

## 1.0.39 — 2026-11-11 — Method baru `sock.newsletterSubscribed()`: mengambil daftar **semua newsletter yang diikuti** akun ini dalam satu panggilan — padanan `groupFetchAllParticipating()` untuk newsletter, yang selama ini belum ada (yang tersedia hanya `newsletterSubscribers(jid)` untuk menghitung pengikut satu newsletter). Diimplementasikan lewat jalur MEX yang sama dengan method newsletter lain: query id `6388546374527196` dan path `xwa2_newsletter_subscribed` (konstanta skema MEX WhatsApp sendiri), ditambahkan ke enum `QueryIds`/`XWAPaths`. Diadaptasi dari @itsliaaa/baileys.

- `lib/Socket/newsletter.js`, `lib/Socket/newsletter.d.ts`, `lib/Types/Newsletter.js`, `lib/Types/Newsletter.d.ts`

## 1.0.38 — 2026-11-11 — Kartu ad-reply / pratinjau link kini bisa ditulis sebagai opsi langsung. Sebelumnya, memasang `externalAdReply` (kartu judul + thumbnail yang menumpang di atas pesan) berarti merakit `contextInfo` utuh dengan tangan. Sekarang cukup `externalAdReply: { title, body, url, thumbnail, largeThumbnail }` pada konten pesan: `url` dipetakan ke `mediaUrl` sekaligus `sourceUrl`, `mediaType` bawaan 1 (gambar), dan hasilnya digabung rapi dengan `contextInfo` eksplisit maupun `mentions`/`mentionAll` bila sama-sama dipakai. Satu perbedaan sadar dari sumber adaptasinya (@itsliaaa/baileys): di sana `url` yang kosong diam-diam diganti link donasi mereka — di sini url kosong **tetap kosong**; library ini tidak pernah menyisipkan tautan pihak ketiga ke pesan pengguna. Thumbnail non-Buffer ditolak dengan error 400 yang jelas.

- `lib/Utils/messages.js`, `lib/Types/Message.d.ts`

## 1.0.37 — 2026-11-11 — Mention semua peserta grup kini bisa tanpa daftar JID. Sampai sekarang, menyebut semua anggota grup berarti menyusun sendiri daftar `mentions` berisi seluruh JID peserta — berat untuk grup besar dan mustahil tanpa metadata grup. Sekarang ada opsi `mentionAll: true` pada konten pesan: library menyetel flag native WhatsApp `nonJidMentions` pada contextInfo, dan klien penerima menampilkannya sebagai mention massal tanpa daftar JID sama sekali. Agar flag itu selamat sampai kabel, field `ContextInfo.nonJidMentions` (field 70, uint32 — sama seperti proto WhatsApp terkini) ditambahkan ke WAProto kita, lengkap encode/decode/verify/fromObject/toObject, dan terbukti roundtrip di level byte. `mentionAll` bisa digabung dengan `mentions` biasa; perilaku `mentions` lama tidak berubah. Diadaptasi dari @itsliaaa/baileys.

- `WAProto/WAProto.proto`, `WAProto/index.js`, `WAProto/index.d.ts`, `lib/Utils/messages.js`, `lib/Types/Message.d.ts`

## 1.0.36 — 2026-11-11 — Lisensi kini memegang copyright AunuCore Creative Network. File LICENSE sebelumnya hanya mencantumkan copyright upstream (WhiskeySockets), padahal AunuBaileys dikembangkan dan dirawat oleh AunuCore Creative Network. Sekarang baris copyright utama adalah AunuCore Creative Network, dengan atribusi upstream dipertahankan di bawahnya persis seperti yang diwajibkan lisensi MIT, plus satu baris penjelasan asal-usul paket. Isi lisensinya tidak berubah: tetap MIT, field `license` di package.json tetap "MIT", dan hak-hak pengguna paket tidak berubah sama sekali. Tidak ada perubahan kode pada rilis ini.

- `LICENSE`

## 1.0.35 — 2026-11-11 — Kegagalan dekripsi kini memberi sinyal terstruktur, bukan banjir log. Satu sesi yang rusak bisa menggagalkan ratusan pesan dalam hitungan menit (B-01), dan setiap kegagalan dicatat di level ERROR — log tenggelam, sementara bot tidak punya cara terprogram untuk tahu sedang terjadi banjir Bad MAC. Sekarang: (1) log error dekripsi di-throttle per alamat pengirim — baris pertama langsung, lalu paling banyak satu baris per menit per pengirim dengan hitungan kegagalan yang disembunyikan; (2) event baru `messages.decrypt-failure` membawa remoteJid, pengirim, alamat sinyal, jumlah kegagalan beruntun, dan apakah kegagalan ini memicu reset sesi/sender-key — konsumen bisa memberi peringatan dan mengagregasi tanpa membaca log. Penanganan kegagalannya sendiri tidak berubah. Versi penutup rangkaian perbaikan 1.0.14–1.0.35.

- `lib/Utils/decode-wa-message.js`, `lib/Socket/messages-recv.js`, `lib/Types/Events.d.ts`

## 1.0.34 — 2026-11-11 — Satu orang tidak lagi dihitung dua pemilih karena beda bentuk LID/PN. Agregasi suara polling memakai identitas mentah dari kunci pesan — seseorang yang memilih dulu sebagai nomor telepon lalu sebagai LID (atau sebaliknya) tercatat sebagai dua pemilih berbeda, dan update polling dari bentuk identitas yang lain menumpuk sebagai entri kedua, bukan menggantikan yang lama. `getAggregateVotesInPollMessage` dan `updateMessageWithPollUpdate` kini menerima opsi `{ lidStore }` opsional: pemilih dikanonisasi ke nomor teleponnya dan didedup per opsi. Tanpa store, perilaku lama tidak berubah.

- `lib/Utils/messages.js`, `lib/Utils/messages.d.ts`

## 1.0.33 — 2026-11-11 — Koneksi tidak lagi diputus oleh satu pong yang hilang. Keep-alive upstream mematikan koneksi begitu selisih sejak trafik terakhir melewati satu interval + 5 detik — di koneksi sepi, balasan ping adalah satu-satunya trafik masuk, jadi satu pong yang hilang karena gangguan sesaat membunuh koneksi sehat dan memaksa reconnect penuh. Sekarang koneksi baru diputus setelah dua interval berturut-turut tanpa balasan; koneksi yang benar-benar mati tetap terdeteksi, hanya satu interval lebih lambat.

- `lib/Socket/socket.js`

## 1.0.32 — 2026-11-11 — Pengirim grup yang hanya ber-LID kini tetap teridentifikasi nomornya. Di grup, `key.participant` makin sering berupa LID, sementara `participantPn` (nomor telepon pengirim) hanya kadang disertakan server — tanpa itu, bot yang mengidentifikasi pengirim grup lewat nomor telepon tidak bisa mengenali siapa yang bicara. Sekarang, bila pasangan identitasnya dikenal LID store, `participantPn`/`participantLid` yang hilang dilengkapi di jalur upsert sebelum event diteruskan ke konsumen. `key.participant` sendiri TIDAK PERNAH ditulis ulang — ia adalah identitas addressing E2E yang dipakai state sesi/sender-key.

- `lib/Socket/chats.js`

## 1.0.31 — 2026-11-11 — Daftar riwayat history sync tidak lagi menumpuk tanpa batas di creds. Setiap notifikasi history sync menambahkan satu entri ke `creds.processedHistoryMessages` — dan tidak ada satu pun kode yang membaca entri-entri itu; satu-satunya pembacaan adalah pengecekan kosong untuk `isLatest`. Daftar ini tinggal di creds, jadi setiap entri menggelembungkan creds.json dan disalin-ulang (spread) plus diserialisasi ulang di setiap penyimpanan selama umur akun. Sekarang hanya 50 entri terakhir yang dipertahankan; semantik `isLatest` tidak berubah.

- `lib/Utils/process-message.js`

## 1.0.30 — 2026-11-11 — Presence tidak lagi hilang karena perbedaan bentuk LID/PN. Stanza presence makin sering datang dialamatkan ke LID, sementara konsumen mencatat partisipan dengan JID nomor telepon (atau sebaliknya) — lookup mereka meleset dan kontak terlihat selamanya offline / tidak pernah mengetik. Sekarang, bila store LID mengenal pasangan identitasnya, event `presence.update` juga memuat presence di bawah bentuk partisipan alternatifnya; entri asli tidak berubah.

- `lib/Socket/chats.js`

## 1.0.29 — 2026-11-11 — Penghitung kirim-ulang dibersihkan saat batas tercapai, bukan dibiarkan menumpuk. Setiap pesan yang diminta peer untuk dikirim ulang meninggalkan satu entri penghitung di cache retry — jalur ini tidak pernah menghapus entri, hanya TTL cache (1 jam pada cache bawaan; tidak ada sama sekali pada cache kustom konsumen tanpa TTL) yang membersihkannya. Pada bot yang hidup berminggu-minggu, entri menumpuk tanpa batas. Sekarang entri dihapus begitu hitungan mencapai batas, persis seperti yang sudah dilakukan `sendRetryRequest` pada jalur retry dekripsi.

- `lib/Socket/messages-recv.js`

## 1.0.28 — 2026-11-11 — Daftar perangkat tidak lagi basi setelah perangkat ditaut/dilepas. Saat daftar perangkat seorang pengguna berubah (WhatsApp Web ditautkan atau dilepas), server mengirim notifikasi `devices` — upstream hanya mencatat daftar perangkatnya sendiri dan mengabaikan semua pengguna lain, sehingga jalur kirim terus mengenkripsi untuk set perangkat lama sampai TTL cache 5 menit habis: perangkat baru tidak menerima apa-apa, perangkat yang dilepas terus menerima ciphertext sia-sia. Sekarang notifikasi itu menginvalidasi entri cache perangkat pengguna tersebut, jadi pengiriman berikutnya mengambil daftar segar lewat USync. Cache-nya sendiri kini diekspos sebagai `sock.userDevicesCache` agar lapisan lain (dan konsumen) bisa menginvalidasi secara eksplisit.

- `lib/Socket/messages-recv.js`, `lib/Socket/messages-send.js`

## 1.0.27 — 2026-11-11 — Helper `getReconnectDelay` untuk kebijakan reconnect. `classifyDisconnect` dari AunuAntiBan selama ini hanya mengembalikan kategori + tindakan (`stop`/`restart`/`reconnect`/`backoff`); setiap konsumen harus meracik sendiri berapa lama menunggu sebelum menyambung ulang — dan yang paling sering salah adalah reconnect terlalu cepat setelah 429 atau reconnect sama sekali setelah logout. Helper baru `getReconnectDelay(attempt, reason, options?)` menerima error Boom, kode status, atau hasil classifyDisconnect, lalu mengembalikan milidetik yang disarankan: `null` bila koneksi TIDAK boleh disambung ulang (logout, digantikan, sesi rusak, 403), `0` untuk restart yang diminta server, backoff eksponensial + jitter Gaussian untuk gangguan sementara (basis 1 dtk, plafon 60 dtk), dan backoff jauh lebih panjang untuk 429 (basis 30 dtk, plafon 15 mnt). Opsi `baseDelayMs`/`maxDelayMs` tersedia.

- `lib/Utils/antiban.js` (+ `.d.ts`)

## 1.0.26 — 2026-11-11 — fetchLatestBaileysVersion: ingat versi terakhir yang berhasil diambil. Fungsi ini dipanggil di setiap koneksi ulang dan sebelumnya selalu menembak jaringan; bila fetch gagal di tengah sesi (GitHub tidak terjangkau / rate limit), ia langsung mundur ke versi bundled — padahal nilai endpoint adalah satu-satunya kebenaran yang diterima server (lihat 1.0.13: bundled bisa berupa build beta yang ditolak). Sekarang: hasil fetch yang sukses di-cache 10 menit (panggilan berikutnya tidak menembak jaringan) dan bila fetch gagal setelah pernah sukses, dikembalikan versi terakhir yang berhasil diambil, bukan bundled. Bila belum pernah sukses, tetap bundled seperti sebelumnya. Opsi baru `forceRefresh: true` dan `cacheTtlMs` untuk melewati/mengatur cache.

- `lib/Utils/generics.js`

## 1.0.25 — 2026-11-11 — Receipt DM: status pesan tidak lagi nyangkut gara-gara LID. Receipt DM makin sering datang dialamatkan ke LID penerima, sementara aplikasi konsumen menyimpan pesan terkirim dengan kunci JID nomor telepon (atau sebaliknya) — update status tidak pernah cocok dengan store mereka dan pesan terlihat selamanya "terkirim" padahal sudah dibaca. Sekarang, bila store LID mengenal pasangan identitasnya, event `messages.update` dari receipt DM membawa `key.remoteJidAlt` berisi bentuk identitas alternatifnya; `remoteJid` tidak berubah dan field ini murni tambahan. Prasyarat internalnya: store LID sekarang dibuat SEKALI di lapisan socket paling dasar (`lib/Socket/socket.js`) sehingga instance yang sama mengalir lewat semua lapisan — sebelumnya store dibuat di lapisan terluar, jadi lapisan dalam (receipt, presence, poll) tidak bisa membacanya sama sekali. Store publik `sock.aunuLid` berperilaku persis seperti sebelumnya. Helper baru `aunuLid.getAltJid(jid)` mengembalikan bentuk alternatif dari JID yang dikenal (PN untuk LID, LID untuk PN).

- `lib/Socket/messages-recv.js`, `lib/Socket/socket.js`, `lib/Socket/index.js`, `lib/Utils/lid-store.js` (+ `.d.ts`)

## 1.0.24 — 2026-11-11 — profilePictureUrl: "tidak ada foto" bukan lagi exception. Mengambil foto profil kontak yang tidak memasang foto / membatasi privasi membuat server menjawab error 401/404, dan upstream membiarkan Boom-nya meledak ke pemanggil — setiap fitur yang menampilkan avatar (menu, sambutan grup, perintah profil) wajib membungkus try/catch sendiri atau crash. Sekarang status 401/404 diselesaikan menjadi `undefined`, konsisten dengan kasus node picture kosong yang sudah ada; error sungguhan (timeout, 5xx, koneksi) tetap dilempar. Kode status dibaca mengikuti konvensi codebase (`err.data` numerik dari assertNodeErrorFree) dengan fallback bentuk lain.

- `lib/Socket/chats.js`

## 1.0.23 — 2026-11-11 — Unduhan media lama: 403 kini memicu re-upload dari HP. Jalur pemulihan unduhan media (minta HP pengirim mengunggah ulang salinan segar) hanya terpicu pada HTTP 404/410, padahal CDN media WhatsApp menjawab **403** ketika otorisasi directPath/URL sebuah pesan sudah kedaluwarsa — kasus media lama yang paling umum. Akibatnya unduhan media lama gagal permanen walau HP pengirim bisa menyembuhkannya. 403 kini masuk daftar status pemicu re-upload (`REUPLOAD_REQUIRED_STATUS`); bila media memang sudah musnah, permintaan re-upload ikut gagal dan error asli diteruskan apa adanya — tidak ada perilaku menyembunyikan error. Cakupan verifikasi dicatat jujur: perubahan ini pada konstanta keputusan retry di jalur yang sudah ada (jalur re-upload-nya sendiri bawaan upstream dan tidak diubah); tidak ada uji CDN live yang diklaim.

- `lib/Utils/messages.js`

## 1.0.22 — 2026-11-11 — Cacheable key store: penghapusan tidak lagi di-cache sebagai null hantu. `makeCacheableSignalKeyStore.set()` menyimpan nilai apa adanya ke cache — termasuk `null`, padahal null berarti PENGHAPUSAN. Akibatnya terbukti empiris: (1) get berikutnya mengembalikan key yang HADIR tapi null (bentuk data yang salah), dan (2) nilai yang dibuat ulang di store di balik wrapper tetap tertutup null cache sampai TTL 5 menit habis. Sekarang nilai null/undefined MENGHAPUS entri cache (cache.del), sehingga get berikutnya membaca keadaan otoritatif store: key yang dihapus benar-benar absen, nilai baru langsung terlihat. Inilah yang membuat deleteSession (1.0.14) dan deleteSenderKey (1.0.17) berperilaku benar lewat wiring cacheable yang direkomendasikan — jalur yang dipakai Tenka. Kedua cacat direproduksi sebelum perbaikan dan lolos sesudahnya lewat uji terhadap store sungguhan.

- `lib/Utils/auth-utils.js`

## 1.0.21 — 2026-11-11 — saveCreds tidak lagi menulis disk puluhan kali per burst. Selama pairing, `creds.update` menyala berkali-kali per detik (registrasi, unggah pre-key, dorongan identitas) dan setiap event memicu satu penulisan atomik penuh creds.json yang mengantre di mutex file — pairing yang sibuk berarti puluhan penulisan file identik. Sekarang panggilan saveCreds yang bersamaan berbagi SATU penulisan yang sedang berjalan, dan panggilan yang tiba di tengah penulisan menjadwalkan tepat satu penulisan lanjutan, sehingga file selalu berakhir berisi creds TERBARU tanpa pekerjaan redundan. Terverifikasi: burst 30 panggilan serentak menghasilkan hanya ~2-3 penulisan nyata (dihitung dari event file tmp) dan isi akhir persis creds terakhir; penulisan sekuensial normal tidak berubah.

- `lib/Utils/use-multi-file-auth-state.js`

## 1.0.20 — 2026-11-11 — Kirim pesan saat reconnect tidak lagi langsung gagal. `relayMessage` yang dipanggil tepat ketika koneksi sedang menyambung ulang dulu langsung mati dengan Boom 428 dari query internal pertamanya — pesan hilang kecuali konsumen mengulang sendiri; inilah salah satu wajah "pesan tidak terkirim" yang paling sering dilaporkan bot di VPS yang koneksinya berkedip. Sekarang, bila transport belum terbuka, pengiriman MENUNGGU transport terbuka kembali, dibatasi `connectTimeoutMs` (default 60 detik, timeout menghasilkan Boom 408 yang jelas); koneksi yang tertutup permanen tetap gagal cepat lewat waitForSocketOpen itu sendiri. Saat koneksi terbuka normal, perilaku tidak berubah sama sekali (tanpa overhead).

- `lib/Socket/messages-send.js`

## 1.0.19 — 2026-11-10 — Retry request tidak bisa lagi mematikan proses. Jalur pengiriman retry receipt setelah kegagalan dekripsi berjalan fire-and-forget lewat retryMutex (sengaja, agar tidak memblokir pemrosesan pesan) — tetapi panggilannya tidak memiliki penangkap error sama sekali, tidak seperti pola-pola tetangganya yang semuanya mengarah ke onUnexpectedError. Satu kegagalan di dalamnya (socket mati di tengah jalan, pengambilan pre-key gagal) menjadi unhandled rejection, dan kebijakan default Node mematikan SELURUH proses bot karenanya. Sekarang penolakan itu dirutekan ke onUnexpectedError standar: tercatat rapi, proses tetap hidup, pesan berikutnya tetap diproses.

- `lib/Socket/messages-recv.js`

## 2026-11-10 — (RafaelPivots auto-fix, dibawa ulang setelah tertimpa rilis 1.0.18) Pemindaian otomatis menemukan satu masalah minor: file WAProto/fix-imports.js mengimpor `argv` dari modul `process` tetapi tidak pernah menggunakannya — dead import dibersihkan.

- `WAProto/fix-imports.js`


## 1.0.18 — 2026-11-10 — Retry receipt: bundle sesi dari peer kini dipakai. Saat perangkat penerima gagal mendekripsi pesan kita dan meminta kirim ulang, receipt retry-nya sering membawa key bundle MILIK perangkat itu sendiri (`<keys>` + `<registration>`) — pernyataan otoritatif "bangun sesimu ke aku dari sini". Upstream mengabaikannya dan selalu mengambil bundle dari server lewat IQ paksa: satu round-trip ekstra, dan untuk partisipan LID pemetaan JID->bundle di server rapuh. Sekarang bundle dari receipt diparsing (`parseRetryReceiptSession`, diekspor — terverifikasi unit-test round-trip dengan key asli: registration id, identity key, pre-key, signed pre-key) dan diinjeksikan sebagai sesi baru (`injectE2ESession`); pengambilan dari server dilewati tepat untuk pengiriman ulang itu. Receipt tanpa bundle berperilaku persis seperti sebelumnya. Komentar TODO basi di sendMessagesAgain (cache pesan terkirim, sudah ada sejak 1.0.10) dibersihkan.

- `lib/Utils/signal.js`, `lib/Utils/signal.d.ts`, `lib/Socket/messages-recv.js`

## 1.0.17 — 2026-11-10 — Grup: sender-key basi ikut disembuhkan. Mesin penghitung kegagalan dekripsi dari 1.0.14 kini mencakup pesan grup (sebelumnya dikecualikan): kegagalan dekripsi grup dihitung per (grup, penulis); pada kegagalan ke-3 berturut-turut, record sender-key basi milik penulis itu di grup tersebut dihapus (`signalRepository.deleteSenderKey`, metode baru — terverifikasi unit-test menarget string record yang tepat), sehingga retry request berikutnya meminta pengiriman ulang yang membawa distribution message segar dan cipher grup dibangun ulang dari nol. Tanpa ini, satu record sender-key busuk membuat semua pesan grup dari penulis itu tidak terbaca permanen. Keberhasilan dekripsi meng-nol-kan kedua penghitung (sesi 1:1 dan sender-key).

- `lib/Socket/messages-recv.js`, `lib/Signal/libsignal.js`, `lib/Types/Signal.d.ts`

## 1.0.16 — 2026-11-10 — Identity change tidak lagi diabaikan. Notifikasi `encrypt` dari server membawa kabar "identitas kontak ini berubah" (HP baru / install ulang / nomor didaur ulang) — upstream Baileys hanya menulis log 'identity changed' lalu TIDAK melakukan apa-apa ("not handling right now"), sehingga sesi tersimpan tetap terikat ke identitas lama dan pesan-pesan berikutnya dari kontak itu gagal melawan sesi arsip (kelas Bad MAC) sampai lawan kebetulan mengirim pesan pre-key. Sekarang sesi tersimpan untuk JID itu langsung dihapus saat notifikasi diterima (mesin deleteSession dari 1.0.14), sehingga pertukaran berikutnya membangun sesi segar terhadap identitas baru. Pemeriksaan pre-key saat koneksi terbuka diaudit dan ternyata sudah benar di upstream (query jumlah di server pada CB:success + upload bila <= ambang), jadi tidak diubah.

- `lib/Socket/messages-recv.js`

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

