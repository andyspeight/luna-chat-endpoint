# Security & Abuse-Resistance Checklist

The catalogue for **Sweep 1**. Work it against the project's actual attack surface (from `PROJECT_CONTEXT.md`), not in the abstract. For each item: look for the pattern, confirm with evidence, write a finding, then fix in Sweep 3.

This is a defensive checklist. Model how something could be abused so you can harden it. Do not write working exploits.

If a project-specific `*-security` skill is installed, its rules win where they overlap. This file is the portable baseline.

## Contents
1. Secrets & the client/server boundary
2. AuthN & AuthZ (access control)
3. Injection (SQL/NoSQL/query/command/path/template)
4. XSS & output handling
5. CSRF, CORS & clickjacking
6. SSRF & outbound requests
7. Rate limiting, cost-drain & DoS
8. Input validation & deserialization
9. Webhooks & third-party callbacks
10. LLM / AI-specific (prompt injection, cost)
11. File uploads
12. Transport, headers & cookies
13. Dependencies & supply chain
14. Error handling, logging & information disclosure
15. Secrets-in-history & repo hygiene

---

## 1. Secrets & the client/server boundary
The highest-impact category. **Anything that ships to the browser is public** — client bundles, `public/`, inlined config, IIFE widgets, mobile apps.

- **No secret in client-shipped code, ever.** Not API keys, tokens, DB creds, webhook signing secrets, private keys, SMTP passwords. Not base64'd, not obfuscated, not "temporarily". Grep the *built* output (`dist/`, `.next/`, bundle) for key-shaped strings and known prefixes (`sk-`, `pat`, `AKIA`, `ghp_`, `xox`, `-----BEGIN`).
- **Secrets live in environment variables**, never in source. Confirm `.env*` is gitignored.
- **Public-prefixed env vars** (e.g. `NEXT_PUBLIC_*`, `VITE_*`, `PUBLIC_*`) must hold only genuinely public values. A secret behind a public prefix is exposed — finding.
- **Paid/authenticated third-party calls go through a server proxy.** Client → our backend → third party (server-held key). If the client calls a paid API directly with a key, that key is public — P0.
- **No secret in logs** or in error responses returned to the client.
- Fix: move the value server-side, route the call through a backend handler, rotate any key that was ever client-side or committed.

## 2. AuthN & AuthZ (access control)
- **Every non-public route checks authentication.** Look for handlers that read/write user or tenant data with no auth check. An accidentally-public `admin`/`export`/`internal` route is P0.
- **Authorization, not just authentication.** A logged-in user must not access another user's/tenant's data. Check that record lookups are scoped to the caller's id/tenant — not just "is logged in". This is IDOR/BOLA: `/api/orders/123` must verify order 123 belongs to the caller. Very common, often P0.
- **Object-level checks on every mutate.** Update/delete must verify ownership before acting.
- **No security decisions made client-side only.** Hiding a button is not access control; the endpoint must enforce it.
- **Least privilege on tokens/keys.** DB and API tokens scoped to the minimum needed; no admin/root scope used for read paths; capability-scoped tokens over root keys.
- **Server-side enforcement of roles.** Role/permission comes from a trusted server-side source, not from a client-supplied field.
- Fix: add the auth guard; scope the query to the caller; deny by default.

## 3. Injection
User input must never be concatenated into an interpreter string.

- **SQL/NoSQL:** use parameterised queries / prepared statements / the ORM's safe API. Flag any string-built query containing input. For Supabase/PostgREST, ensure filters use the client builder, not interpolated raw SQL; confirm **Row Level Security** is on for tables exposed via the API.
- **Query-language filters** (e.g. Airtable `filterByFormula`, search DSLs): user input must be escaped/quoted, never raw-concatenated into the formula/query string.
- **Command injection:** no user input in shell commands / `exec` / `child_process` without strict allow-listing; prefer argument arrays over a shell string.
- **Path traversal:** user-supplied filenames/paths must be normalised and confined to an intended directory; reject `..`. Never join untrusted input straight into a filesystem path.
- **Template/SSTI & eval:** no `eval`, `new Function`, string-form `setTimeout/setInterval`, or user input rendered through a server-side template engine unsanitised.
- Fix: parameterise, escape, allow-list, or replace the dynamic interpreter with a safe API.

## 4. XSS & output handling
- **No untrusted data into `innerHTML` / `dangerouslySetInnerHTML` / `v-html`** without sanitisation (e.g. DOMPurify). This includes data fetched from a DB/CMS/Airtable and rendered into the DOM — stored XSS is real.
- **Escape on output by context** (HTML body vs attribute vs URL vs JS). React/Vue/Svelte escape text by default — flag the places that opt out.
- **No building DOM via string concatenation** with user/stored values.
- **`javascript:`/`data:` URLs** from user input in `href`/`src` — block.
- Fix: render as text, sanitise HTML with an allow-list, or escape for the right context.

## 5. CSRF, CORS & clickjacking
- **CORS:** no `Access-Control-Allow-Origin: *` on any authenticated or state-changing endpoint. Allow-list specific origins. `*` + credentials is invalid and dangerous.
- **CSRF:** state-changing requests authenticated by cookie need CSRF protection (token or strict `SameSite` cookies). Token-auth (Authorization header) endpoints are generally CSRF-safe — confirm which model is in use.
- **Clickjacking:** admin/sensitive UIs need `X-Frame-Options: DENY` (or CSP `frame-ancestors`). Note: legitimately-embeddable widgets are the deliberate exception — don't "fix" an embed into uselessness; confirm intent from `PROJECT_CONTEXT.md`.
- Fix: tighten the origin allow-list; add CSRF tokens or `SameSite=Strict/Lax`; set frame headers on non-embed surfaces.

## 6. SSRF & outbound requests
- **User-controlled URLs that the server fetches** are SSRF risks — an attacker can target internal services or cloud metadata (`169.254.169.254`). If the server fetches a URL the user supplied (webhooks-out, link previews, "import from URL", image proxy): validate scheme (https only), resolve and block private/loopback/link-local IP ranges, and allow-list hosts where possible.
- Fix: validate + allow-list the destination; block internal address ranges; disable redirects to internal hosts.

## 7. Rate limiting, cost-drain & DoS
- **Every public/anonymous endpoint is rate-limited.** Without it, one bot can drain a paid-API budget, spam a database, or degrade the service. Endpoints that trigger paid calls (LLM, SMS, email, third-party APIs) or heavy DB work are top priority.
- **Cost ceilings** on anything that spends money per call (per-session and per-day caps).
- **Pagination/size caps** on list endpoints; reject unbounded queries.
- **No unbounded work from one request** (e.g. fan-out loops driven by client-supplied counts).
- Fix: add rate limiting (token bucket / fixed window via the platform's KV/Redis), add cost caps, cap result sizes.

## 8. Input validation & deserialization
- **Validate every input on the server** — type, length, format, range, allowed values — not just in the client. Client validation is UX; server validation is security.
- **Strip unexpected fields** on write (mass-assignment / over-posting): only persist the fields you intend, so a caller can't set `isAdmin`, `role`, `price`, `ownerId`.
- **Safe deserialization:** no untrusted input into unsafe deserializers (Python `pickle`/`yaml.load`, Node `vm`, PHP `unserialize`). Parse JSON, validate against a schema.
- **Numeric/total integrity:** money/quantities that matter must be derived or validated server-side, never trusted from client input.
- Fix: add a server-side validation/schema layer; explicitly whitelist writable fields; switch to safe parsers.

## 9. Webhooks & third-party callbacks
- **Verify signatures** on every inbound webhook (Stripe, GitHub, Twilio, etc.) using the provider's signing secret and a constant-time compare. An unverified webhook endpoint lets anyone POST fake events — P0/P1 depending on what it triggers.
- **Idempotency** so a replayed event doesn't double-act.
- **Treat the payload as untrusted** — validate it like any other input.
- Fix: add signature verification (constant-time), reject on mismatch, log mismatches.

## 10. LLM / AI-specific
- **User input goes in the `user` role, never spliced into the system prompt.** Untrusted content in the system prompt enables prompt injection / instruction override.
- **A decline clause** in the system prompt for "ignore previous instructions"-style attacks, and don't expose the raw system prompt.
- **Output length + cost ceilings** per call and per day.
- **Don't let model output drive privileged actions** without validation (e.g. tool calls, SQL, file writes generated by the model must be checked/allow-listed).
- **Strip internal markers** before showing model output to users.
- Fix: re-role the input, add caps, validate model-driven actions, add a refusal clause.

## 11. File uploads
- **Validate type and size** server-side (don't trust the extension or client-sent MIME); enforce a max size.
- **Store outside the web root** or in object storage; never execute uploads; randomise stored names.
- **Scan/segregate** where the content type warrants it.
- Fix: add type/size validation, move storage off the executable path, cap size.

## 12. Transport, headers & cookies
- **HTTPS only**, HSTS set, no mixed content.
- **Security headers:** `Content-Security-Policy` (no `unsafe-inline`/`unsafe-eval` where avoidable), `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options`/`frame-ancestors`.
- **Cookies:** `HttpOnly`, `Secure`, `SameSite` on session/auth cookies. No sensitive data in non-HttpOnly cookies or `localStorage` long-term.
- Fix: add the headers (platform config or middleware), set cookie flags.

## 13. Dependencies & supply chain
- **Audit clean** (`npm audit` / `pip-audit` / equivalent) or every advisory documented with justification. Prioritise critical/high in code paths actually used.
- **Lockfile committed** (`package-lock.json` / `poetry.lock` / etc.).
- **No unexpected/typo-squat dependencies**; no `latest`/unpinned criticals.
- Fix: update or patch the vulnerable dep; if a major bump is breaking, flag as `[HUMAN]`. Adding a new dep is always `[HUMAN]`.

## 14. Error handling, logging & information disclosure
- **No stack traces, DB errors, or internal paths returned to the client.** Generic message out, detail logged server-side.
- **Log the security-interesting events:** failed auth, rate-limit hits, validation failures, webhook signature mismatches — so abuse patterns are visible. But **never log secrets or full PII**.
- **Fail closed:** when auth/validation/a third-party call fails, deny — don't fall through to a permissive default.
- Fix: wrap handlers to return generic errors + log internally; add the security event logs; default-deny.

## 15. Secrets-in-history & repo hygiene
- **A committed secret is compromised even if later removed** — git history is permanent. If you find one in history, the finding is "rotate the key", not "delete the line".
- Confirm `.gitignore` covers `.env*`, key files, local config.
- Fix: flag for rotation (P0 if a live production key), confirm gitignore.

---

## Stack quick-notes (common patterns)
- **Next.js / Vercel:** secrets only in non-`NEXT_PUBLIC_` env vars; API routes do method + auth + validation + CORS allow-list + rate limit; never trust `NEXT_PUBLIC_*` for anything secret.
- **Supabase / Postgres:** **RLS on** for every table exposed through the API; the anon key is public *by design* but RLS is what protects the data — verify policies exist and are correct; service-role key is server-only.
- **IIFE / embeddable widgets:** zero secrets in the bundle; all paid calls via a backend proxy; render fetched/CMS data with sanitisation; Shadow DOM / scoped styles; capability-scoped realtime tokens, not root keys. Embeddability (no frame-blocking) is intended — don't treat it as a clickjacking bug.
- **Static sites:** main risks are committed secrets and third-party script integrity; little server surface.
