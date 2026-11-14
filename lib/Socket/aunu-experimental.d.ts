/**
 * AunuBaileys EXPERIMENTAL socket features — these exist only in
 * AunuBaileys and may change or disappear in any release:
 *
 * 1. Invisible text watermark — `aunuWatermark` / `aunuReadWatermark` /
 *    `aunuStripWatermark`: hide a short tag (bot name, campaign, build)
 *    inside message text as zero-width characters for leak tracing and
 *    fingerprinting; the visible text is unchanged.
 * 2. Humanised send — `aunuHumanSend`: shows "composing" for a plausible
 *    typing duration derived from the text length, then sends.
 * 3. Scheduled send — `aunuSchedule` / `aunuCancelScheduled` /
 *    `aunuListScheduled`: in-memory delayed sends (lost on restart).
 * 4. Self-destructing send — `aunuSelfDestruct` /
 *    `aunuCancelSelfDestruct`: sends, then revokes the message for
 *    everyone after N seconds.
 * 5. Connection doctor — `aunuDoctor`: one structured health snapshot
 *    (registration, transport, bundled WA version, known LID pairs,
 *    pending experimental timers).
 * 6. Personalised tag-all — `aunuPersonalTagAll`: for EVERY group member,
 *    one message carrying that member's OWN profile picture and name,
 *    mentioning exactly them — each member sees themselves, not a
 *    generic tag-all. Paced sends + a member cap guard against spam
 *    limits.
 * 7. Photo card — `aunuCard`: an interactive card whose header photo does
 *    NOT open as a normal photo when tapped; a title/name and text sit
 *    fused below it in the same bubble, with divider-separated buttons
 *    (reply/url/copy/call) underneath.
 * 8. Fabricated quote — `aunuFakeQuote`: send any content carrying a
 *    made-up quoted message, as if replying to someone.
 * 9. Typewriter — `aunuTypewriter`: send a message in growing pieces by
 *    editing it on an interval until the full text stands.
 * 10. Reaction sequence — `aunuReactSequence`: cycle reactions on one
 *     message (an animation effect).
 * 11. Styled status — `aunuPostStatus`: post a text status with a
 *     background colour and font in one call.
 * 12. Personal card — `aunuPersonalCard`: the one-person form of
 *     aunuPersonalTagAll (own profile picture + name card for one target,
 *     into a chat or as a DM).
 * 13. Side-profile text — `aunuSideText`: text with a small picture at
 *     the side, a name beside it and the chat under the name; the
 *     picture can be a real profile picture, the built-in "deleted
 *     account" avatar, or absent entirely.
 * 14. Ghost mention — `aunuGhostMention`: mention every group member
 *     invisibly (notifications fire, no @ text shows).
 * 15. Fake forward — `aunuFakeForward`: the forwarded look with a high
 *     score and optional channel attribution.
 * 16. Vanish — `aunuVanish`: send with a custom per-message
 *     disappearing timer (native expiry, no tombstone).
 * 17. Trap image — `aunuTrapImage`: the preview thumbnail is a
 *     different picture from the one that opens.
 * 18. Fake voice note — `aunuFakeVN`: a voice note claiming a long
 *     duration with a full waveform, whatever the clip really is.
 * 19. Ghost message — `aunuGhostMessage`: a bubble that renders
 *     completely empty (optionally carrying a hidden watermark tag).
 * 20. Promo code — `aunuPromoCode`: a promo-code card whose button
 *     copies the code when tapped.
 * 21. Fake document — `aunuFakeDoc`: a document claiming a fake
 *     size and page count.
 * 22. Fake video — `aunuFakeVideo`: a video claiming a fake
 *     duration, with an optional decoy thumbnail.
 * 23. Fake location — `aunuFakeLocation`: a location card whose
 *     name, address, photo and coordinates are all invented.
 * 24. Fake album — `aunuFakeAlbum`: an album claiming more items
 *     than are actually sent.
 * 25. Word reaction — `aunuWordReact`: a reaction containing a
 *     word instead of an emoji.
 * 26. Bot steps — `aunuBotSteps`: an AI-bot step-progress message
 *     (steps list behind the client's "view details" affordance),
 *     updatable live via edits.
 * 27. Spoiler — `aunuSendSpoiler`: any content wrapped in
 *    spoilerMessage (Message field 118) with contextInfo.isSpoiler.
 * 28. Group status — `aunuSendGroupStatus`: any content wrapped in
 *    groupStatusMessageV2 (Message field 103) with
 *    contextInfo.isGroupStatus.
 * 29. A2UI widget — `aunuSendA2UI`: send a declarative A2UI widget
 *     (Text/Image/Video/Button/Card/Column/Row) as an interactive
 *     message carrying `bloksWidget`.
 */
export declare const attachAunuExperimental: (sock: any) => any;
//# sourceMappingURL=aunu-experimental.d.ts.map