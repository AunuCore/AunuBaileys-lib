# Security Policy

AunuBaileys (`@aunucore/baileys`) is maintained by **AunuCore Creative Network**. This policy covers the library published on npm as `@aunucore/baileys` and this repository (`AunuCore/AunuBaileys-lib`).

## Reporting a Vulnerability

**Do not file security issues as public GitHub issues, posts, or PRs.** A public report is itself an exploit broadcast — downstream projects install this library from npm, so a vulnerable version is in the wild within minutes.

Use a private channel:

1. **Preferred:** [GitHub Security Advisories](https://github.com/AunuCore/AunuBaileys-lib/security/advisories/new) on this repository. This gives us a private workspace to coordinate the fix and prepare an advisory.
2. **Fallback:** a private message on X to [@AunuHost](https://x.com/AunuHost). Use this only if GitHub Advisories is unavailable.

We aim to acknowledge reports within **72 hours**. If you don't get an acknowledgement in that time, please re-send — filtering does occasionally swallow security reports.

## What to include

A useful report contains:

- **Affected versions** (release version or commit SHA)
- **Component**: socket, signal/crypto, auth state, message decoding, media handling, etc.
- **Impact**: what an attacker can do (read messages, hijack sessions, impersonate, DoS, etc.) and under what preconditions
- **Reproduction**: minimal code, captured stanza, or a deterministic test case. If repro requires a paired account or live connection, describe the setup instead — don't attach session state.
- **Suggested fix** (optional but appreciated)

If a fix touches the wire protocol or signal-protocol session state, please flag that explicitly — those changes need extra coordination because they affect persisted state on every downstream user.

## What we treat as a vulnerability

In scope:

- Auth state / key store leakage or downgrade
- Session, prekey, or sender-key handling that lets a remote party impersonate, replay, or decrypt outside the intended audience
- Memory corruption / RCE via crafted stanzas, media, or protobuf payloads
- Logic bugs that bypass intended access controls (e.g., reading messages from chats the local account isn't part of)
- Vulnerabilities in dependencies that are reachable through AunuBaileys' public API
- Information disclosure (PII, message content, JIDs/phone numbers, tokens) through logs or error messages on default configurations

Out of scope (please file as regular issues or PRs):

- Bugs that only affect availability of the local process (a malformed input that throws an exception in your handler is not a CVE; a malformed input that lets a remote party crash any AunuBaileys client is)
- Issues in third-party WhatsApp clones or in other forks
- Behavior of WhatsApp itself — we don't control the server; report those to Meta
- Missing rate limiting in *your* application — AunuBaileys doesn't add rate limiting on top of WhatsApp's
- Reports that boil down to "the library can be misused for spam." See `CODE_OF_CONDUCT.md` § Project-Specific Conduct; that's a contributions matter, not a vulnerability.

## Coordinated disclosure

Our default timeline:

| Day | Step |
|---|---|
| 0 | Report received, acknowledged within 72h |
| ≤ 7 | Initial assessment shared with reporter; severity and rough timeline agreed |
| ≤ 30 | Fix prepared; reporter invited to validate if they want |
| Coordinated date | Fix released on npm, advisory published |

If you need to disclose sooner (e.g., active exploitation in the wild), tell us — we'll prioritize accordingly. If a fix is taking longer than 30 days, we'll keep you updated and explain why.

We're happy to credit reporters in the advisory. Tell us how you'd like to be credited (name, handle, organization) or if you'd prefer to remain anonymous.

## Supported versions

Security fixes are applied to the **latest release line** and published on npm as `@aunucore/baileys`. Older lines are unmaintained — please upgrade.

| Version | Supported |
|---|---|
| `2.x` (current) | ✅ |
| `1.x` and older | ❌ |

## Operational security for users

A few notes for downstream users — these aren't vulnerabilities in AunuBaileys, but they are common ways production systems leak:

- **Your auth state folder is equivalent to a long-lived credential.** Store it like an SSH private key. Don't commit it. Don't put it in container images. Encrypt it at rest if you can.
- **Logs leak.** A verbose logger can emit JIDs and message metadata. Set `level: 'silent'` or filter aggressively in production.
- **Don't paste auth state into AI tools, screenshots, or support tickets.** It's not redactable — anyone with the folder contents can hijack the session.
- **Pin a release.** Install a tagged npm release of `@aunucore/baileys` in production rather than tracking a moving branch.
