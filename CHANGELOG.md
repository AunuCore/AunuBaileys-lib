# Changelog

All notable changes to AunuBaileys (`@aunucore/baileys`) are recorded here. The full, detailed changelog lives in the documentation at https://docsjs.aunucore.eu.cc/changelog and in the [GitHub Releases](https://github.com/AunuCore/AunuBaileys-lib/releases) of this repository.

## 2.0.4

- Nine hardening fixes from the v6 line restored on the v7 base, each verified against the tree and locked in with a mutation-checked regression test (suite 72 → 94): HB-287 (the three `CB:ib,,dirty` listeners in groups/communities/chats could crash the process through an unhandled rejection when the socket dropped mid-sync), HB-288 (`newsletterCreate` threw a raw TypeError when the created channel had no picture or description), HB-289 (a CDN drop mid-download left the source stream error unhandled — an uncaught exception plus a consumer hanging forever), HB-290 (an empty download threw a bare TypeError instead of Boom 502), HB-291 (a media-retry receipt without an `<rmr>` node threw and lost the `messages.media-update` event), HB-292 (a data URL without a comma threw a bare TypeError instead of Boom 400), HB-293 (`extensionForMediaMessage` threw on missing content instead of returning undefined), HB-294 (`updateMediaMessage` waited forever for a media update that never comes — the 120-second timeout is restored), and HB-314 (a malformed verified-name certificate made decryption throw, discarding a decryptable message and looping the server's redelivery).

## 2.0.3

- Repository cleanup — metadata only, the library code is identical to 2.0.2. Removed inherited upstream leftovers that are not part of AunuBaileys: the upstream demo media (`Media/`), the upstream example (`Example/`), the dead Jest tooling (`jest.config.ts` plus the `test:e2e` / `test:upstream` scripts — the suite runs on Node's built-in test runner), the upstream `proto-extract/` tooling, the Yarn leftovers (`yarn.lock`, `.yarnrc.yml`), `CLAUDE.md`, the archived upstream README (`README-UPSTREAM.md`), and the upstream fork-assembly script (`scripts/assemble-fork.py`). This changelog is now AunuBaileys' own, and the `whiskeysockets` package keyword was dropped.

## 2.0.2

- Three hardening fixes from the v6 line restored on the v7 base: HB-283 (the `CB:ib,,offline_preview` handler could crash the process through an unhandled rejection when the socket closed mid-send), HB-284 (a malformed pre-key `<count>` from the server silently skipped the pre-key upload), and HB-285 (a malformed stream-error code could make the `CB:stream:error` handler throw instead of disconnecting cleanly). The regression suite grows to 72 tests; each fix is mutation-checked.

## 2.0.1

- Metadata release: the npm tarball now ships the canonical AunuCore LICENSE — Copyright (c) 2026 AunuCore Creative Network first, the original upstream copyright retained directly below it, an origin note, and the full MIT text. Library code identical to 2.0.0.

## 2.0.0

- New v7 base: a frozen snapshot of upstream master `bb0a87e0326ca8f882fe716c7ee42da362f73fc0`, TypeScript / ESM only, with the complete AunuBaileys patch layer re-applied and re-verified. BanSentinel ships (on by default), a regression suite in `test/` gates both publish workflows in CI, dependencies were slimmed (runtime 12 → 6), all 34 experimental `aunu*` methods are present, and v6 auth state loads without re-pairing.
