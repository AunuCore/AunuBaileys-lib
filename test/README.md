# AunuBaileys 2.0.0 regression suite (P8)

Runner: `node --test` (Node ≥ 20), **zero new dependencies**. The suite
runs against the **built** `lib/` tree; `npm test` builds first, so it is
green from a clean checkout after install:

```
yarn install   # or npm install
npm test
```

The upstream jest suite still lives in `src/__tests__/` untouched. Jest
was removed from devDependencies in P9, so it is **not** part of this
gate; run it ad hoc with `npm run test:upstream` (fetches jest via npx).

## Layout

| File | Covers |
|---|---|
| `01-exports-surface.test.mjs` | (f) `messages.decrypt-failure` event surface, (g) USync protocol count = 12, (h) Tenka symbol audit (28 runtime names from `tenka_needs.json`, `AnyMessageContent` exempt as type-only; vendored copy of the list is used when the maintainer tree is absent) |
| `02-experimental-proto.test.mjs` | (c) 34 experimental methods callable on a constructed socket; proto round-trips incl. `pollCreationMessageV6` and PollCreationMessage fields 9/10/11 (`endTime`/`hideParticipantName`/`allowAddOption`) |
| `03-ban-sentinel.test.mjs` | (d) BanSentinel: keyword/code/burst triggers → cooldown → `assertCanConnect` Boom 503 → clean reset; persistence across instances; corrupt guard file; unwritable FS degrades to memory-only |
| `04-auth-state.test.mjs` | (e) v6 (1.0.89, BufferJSON) creds/key files load via `useMultiFileAuthState` with identity intact — no re-pairing; HB-116, HB-151, HB-143 |
| `05-event-buffer-store.test.mjs` | HB-264 family, HB-279, HB-130, HB-166, HB-274, HB-278, HB-177, KeyedDB-via-store |
| `06-caches-mutex.test.mjs` | (i) HB-199 InternalCache cap (filled 2×), bounded TTL cache caps, HB-145 NaN config, internal Mutex FIFO + release-on-throw, keyed mutex |
| `07-hardening-units.test.mjs` | HB-1, HB-69, HB-102, HB-111, HB-112, HB-114, HB-122, HB-124 family, HB-133, HB-165, HB-168, HB-175, HB-205/252, HB-271, HB-272, HB-273, HB-277, PTV delta |
| `08-socket-ports.test.mjs` | (j) newsletter.status emit + ack despite a throwing listener; 405 → `clientTooOld` emitted **before** close (fetch stubbed); sticker-pack proto round-trip; HB-42/64, HB-139/174, HB-276, HB-280 |
| `09-media-fallback.test.mjs` | (i) `music-metadata` absent → `getAudioDuration` resolves `undefined`, never crashes (direct call + subprocess with the specifier blocked at the resolver, so it is deterministic even where the peer is installed) |

Sockets in tests are real `makeWASocket` instances pointed at a dead
local WS URL (`ws://127.0.0.1:9`) with a fake open transport where a
stanza handler must run end-to-end. No test touches the real WhatsApp
network; the one `fetch` user (405 path) is stubbed.

## Coverage map — HB regressions

Sources: `p3-dispositions.md` (112 RE-APPLIED + 46 ALREADY-PRESENT),
`p4-dispositions.md` (17 rows), P9 diet, P2e/P2f ports.

### Covered by a test in this suite

- **P3 RE-APPLIED (33):** HB-1, HB-42, HB-64, HB-69, HB-102, HB-111,
  HB-112, HB-114, HB-116, HB-122, HB-124, HB-130, HB-133, HB-139,
  HB-143, HB-151, HB-162, HB-165, HB-166, HB-168, HB-174, HB-175,
  HB-180, HB-197, HB-199, HB-202, HB-205, HB-252, HB-264.
  Family closures: HB-223 (same sender-key sanitiser choke point as
  HB-124), HB-227/HB-228/HB-229 (same per-listener dispatcher patch as
  HB-264; the dispatch facet is exercised directly, the flush-timer
  facet shares the identical guarded path).
- **P3 ALREADY-PRESENT, spot-covered anyway (3):** HB-145 (NaN cache
  config), HB-177 (`loadMessages` count 0), HB-226 (undefined cache key
  does not disable the cap).
- **P4 (10 of 17):** HB-271, HB-272, HB-273, HB-274, HB-276, HB-277,
  HB-278, HB-279, HB-280, PTV farm delta.
- **P9 diet:** HB-199 (InternalCache + bounded cache), Mutex FIFO /
  release-on-throw, KeyedDB behaviour via the store (HB-274/HB-278
  above), music-metadata absence.
- **P2e/P2f ports:** `newsletter.status` emit + ack under a throwing
  listener; sticker-pack proto round-trip (+ Boom 400 on invalid
  packs); 405 → `clientTooOld` before `end()` with fetch stubbed.

### NOT covered — with reasons

- **P4 (7):**
  - HB-265a — disposition is ALREADY-PRESENT (upstream try/catch in the
    PDO branch); exercising it needs the full `processMessage`
    scaffolding (history-sync state + ev + creds). P4 spot-checked it.
  - HB-268 — the stanza dispatch only runs after a successful Noise
    decode; needs a valid Noise frame / mock WA server. The identical
    HB-264 dispatcher pattern is proven in the event-buffer tests.
  - HB-269 — `relayMessage` patch validation needs participant/session
    scaffolding for all three branches; the validator itself is an
    internal closure with no exported seam. P4 spot-checked newsletter.
  - HB-270 — the stanza `from` is built inside the `sendNode` closure,
    which cannot be intercepted from outside (P4 proved it by code
    read + encoder contrast).
  - HB-275 — `refreshMediaConn` is socket-internal with no exported
    seam; the fix is a pure boundary check (P4 code-read proof).
  - HB-201 addendum — needs the full retry-receipt flow (server
    receipt + keys transaction) against a live-ish socket.
  - HB-243 — pair-device handler only fires inside the pairing flow.
- **P3 RE-APPLIED (79)** — three recurring reasons:
  - *Needs a live WA server, a valid Noise frame, or full
    session/send/recv pipeline scaffolding:* HB-107, HB-118, HB-119,
    HB-121, HB-123, HB-125, HB-131, HB-132, HB-135, HB-141, HB-149,
    HB-154, HB-155, HB-156, HB-157, HB-160, HB-161, HB-172, HB-213,
    HB-240, HB-257, HB-259, HB-260, HB-261, HB-262, HB-266.
  - *Needs network/media fixtures (upload hosts, ffmpeg, CDN
    responses):* HB-89, HB-115, HB-127, HB-128, HB-150.
  - *Fix site is an internal closure with no exported seam in the v7
    tree (verified by P3/P4 code read + their spot-checks; no cheap
    unit surface exists):* HB-6, HB-22, HB-26, HB-40, HB-43, HB-61,
    HB-67, HB-68, HB-70, HB-71, HB-72, HB-74, HB-80, HB-83, HB-84,
    HB-85, HB-87, HB-88, HB-91, HB-94, HB-95, HB-96, HB-98, HB-158,
    HB-176, HB-178, HB-181, HB-182, HB-185, HB-186, HB-187, HB-189,
    HB-191, HB-206, HB-208, HB-211, HB-212, HB-216, HB-217, HB-219,
    HB-231, HB-236, HB-238, HB-239, HB-241, HB-253, HB-254.
- **P3 ALREADY-PRESENT (43 of 46)** were not re-tested: by disposition
  the behaviour is upstream's or was ported wholesale in P2 and
  verified then; re-testing them here would test upstream, not our
  fixes. (HB-145/HB-177/HB-226 above are the exceptions.)
- **Dropped harness adaptations:** the `extra10*.mjs` release harnesses
  and heartbeat `t01xx` scripts drive the v6 package through a mock
  Noise XX server and third-party deps (axios, ws servers); their
  socket-level scenarios were **not** ported. Every cheap-seam scenario
  in them that maps to a v7 fix became a test above; the rest are the
  "needs a Noise frame / live pipeline" entries in this map.

## Mutation proof (this suite is not a formality)

Each mutation was applied to the **built** `lib/` output, the named
test run, then the fix restored by rebuilding:

| Fix reverted | Test | Mutated | Restored |
|---|---|---|---|
| HB-274 per-entry isolation in store `fromJSON` (→ bulk upsert) | `05` HB-274 | **FAIL** (1/8) | PASS 8/8 |
| BanSentinel gate (`assertCanConnect` → no-op) | `03` keyword + unwritable-FS tests | **FAIL** (2/8) | PASS 8/8 |
| HB-199 InternalCache cap (→ unbounded) | `06` HB-199 cap test | **FAIL** (1/7) | PASS 7/7 |
| HB-276 fail-fast in `end()` (→ disabled) | `08` HB-276 test | **FAIL** (1/6) | PASS 6/6 |

## Tarball

`package.json` `files` is `lib/**`, `WAProto/**`,
`engine-requirements.js` — `test/` is not shipped (verified with
`npm pack --dry-run`: 0 `test/` entries).
