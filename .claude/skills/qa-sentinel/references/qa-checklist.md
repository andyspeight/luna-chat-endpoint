# Correctness & Robustness Checklist

The catalogue for **Sweep 2**. Work it against the actual code. For each issue: confirm with evidence, write a finding, fix in Sweep 3. High signal only — don't pad with speculative items.

## Contents
1. Build, types & lint health
2. Error handling & failure paths
3. Edge cases & boundary inputs
4. Async, races & concurrency
5. Resource & memory safety
6. External calls (timeouts, retries, degradation)
7. Data integrity & state
8. Logic correctness
9. Tests
10. Config & environment
11. Dead code & footguns
12. Accessibility & UX robustness (UI projects only)
13. Performance (only where it bites)

---

## 1. Build, types & lint health
- Build/compile **passes**. A broken build is the first thing to fix.
- Type checker clean (no implicit `any`, no `@ts-ignore` masking real errors, no type holes at API boundaries). For untyped languages, check input/output contracts at boundaries instead.
- Lint errors triaged — real bugs (unused vars hiding logic errors, `==` vs `===`, shadowed names, unreachable code) fixed; pure style left unless the project enforces it.
- Fix: resolve the underlying error — never silence with a disable comment (see SKILL.md "Never fake green").

## 2. Error handling & failure paths
- **Every external/fallible call handles failure** — network, DB, file, parse, third-party API. No bare calls that throw into the void.
- **No swallowed errors:** empty `catch {}`, `except: pass`, or `.catch(() => {})` that hides failures. Either handle meaningfully or let it propagate to a real handler.
- **Unhandled promise rejections / floating promises:** every `async` call is awaited or explicitly handled.
- **User-facing errors are graceful** — no crash, no blank screen; a clear message and a safe state.
- **Errors fail closed**, not into a permissive default.
- Fix: add handling that does something real (retry, fallback, surface, log + safe-state) — not a swallow.

## 3. Edge cases & boundary inputs
For each input and data path, ask what happens with:
- **Empty / null / undefined / missing** — empty array, null record, missing field, empty string, zero.
- **Huge / many** — very long string, large list, deep nesting, pagination past the end.
- **Malformed** — wrong type, unexpected shape, invalid encoding, partial data.
- **Boundaries** — first/last, off-by-one, min/max, empty result set, single-item set.
- **Duplicate / out-of-order** — repeated submit, stale data, reordered events.
- Fix: add the guard/branch; default sensibly; validate before use.

## 4. Async, races & concurrency
- **Race conditions:** shared state mutated from concurrent paths; check-then-act gaps; read-modify-write without atomicity.
- **Double-submit / double-action:** can the same request fire twice (impatient user, retry, webhook replay)? Idempotency where it matters.
- **Ordering assumptions:** code assuming responses arrive in order when they may not.
- **Cleanup on unmount/cancel:** subscriptions, timers, listeners, in-flight requests cleaned up (UI: no setState-after-unmount; effects have correct deps and teardown).
- Fix: add idempotency keys, atomic operations/locks, ordering guards, proper teardown.

## 5. Resource & memory safety
- **Leaks:** event listeners, intervals/timeouts, subscriptions, file handles, DB connections opened but never closed/removed.
- **Unbounded growth:** caches/arrays/maps that only ever grow; logs without rotation.
- **Connection handling:** pooled/closed correctly; no per-request new connection that's never released.
- Fix: add teardown/close; bound the structure; reuse the pool.

## 6. External calls (timeouts, retries, degradation)
- **Timeouts** on every network/DB/third-party call — no call that can hang forever.
- **Retries with backoff** for idempotent transient-failure calls; **no** blind retry of non-idempotent writes.
- **Graceful degradation:** if a non-critical dependency is down, the feature degrades rather than takes the whole page/flow down.
- Fix: add a timeout, add bounded backoff retry where safe, add a fallback path.

## 7. Data integrity & state
- **Validation before persist** (ties to security §8) — don't store malformed/partial data.
- **No partial writes** that leave inconsistent state; use transactions where multiple writes must succeed together.
- **Derived values stay consistent** — totals, counts, denormalised copies recomputed/updated correctly.
- **Migrations/format changes** handle existing data.
- Fix: wrap multi-step writes in a transaction; validate first; recompute derived fields.

## 8. Logic correctness
- **Conditionals:** inverted booleans, wrong operator, `&&`/`||` mix-ups, missing `else`, fallthrough.
- **Comparisons:** loose vs strict equality, type-coercion surprises, float equality, locale/case in string compares.
- **Off-by-one** in loops/slices/ranges.
- **Copy-paste drift:** a block duplicated then half-edited, leaving the wrong variable.
- **Time/date/timezone:** naive date math, DST, UTC vs local mixed.
- **Money:** floating-point currency math (use integer minor units / decimal types).
- Fix: correct the logic; add a test that pins the corrected behaviour.

## 9. Tests
- **Existing tests pass.** A failing test is either a real bug (fix the code) or a stale test (fix the test honestly) — never deleted/skipped to go green.
- **Critical paths have coverage** — the money/auth/data-integrity paths and the bugs you just fixed. Add a regression test for each significant fix so it can't silently return.
- **Tests assert real behaviour**, not tautologies; they'd actually fail if the code broke.
- Fix: make failing tests pass by fixing the cause; add regression tests for fixes; flag large coverage gaps as `[HUMAN]` if writing a full suite is out of scope.

## 10. Config & environment
- **Required env vars validated at startup** with a clear error if missing — not a confusing runtime crash later.
- **Sensible, safe defaults**; no dev-only setting (debug mode, verbose errors, permissive CORS) leaking into production config.
- **`.env.example`** lists every required var (names only).
- Fix: add startup validation; correct unsafe defaults; update the example.

## 11. Dead code & footguns
- **Dead/unreachable code, commented-out blocks, debug `console.log`/`print`, `TODO`/`FIXME` marking known gaps** — remove debug output; surface meaningful TODOs as findings.
- **Leftover test/stub data, hardcoded local URLs, `localhost`, personal tokens in fixtures.**
- Fix: remove debug noise; replace hardcoded local values with config; report (don't silently delete) TODOs that mark real gaps.

## 12. Accessibility & UX robustness (UI projects only)
Light touch — only if the project has a UI. Defer to a project design skill if one is installed.
- Images have `alt`; interactive elements are real buttons/links or have proper roles + keyboard handling.
- Forms have labels; focus states visible; colour isn't the only signal.
- Loading and error states exist (no infinite spinner, no blank-on-error).
- Fix: add the missing attribute/role/state. Flag a full a11y audit as `[HUMAN]` if it's a big job.

## 13. Performance (only where it bites)
Only flag performance that causes real problems — don't micro-optimise.
- **N+1 queries / queries in loops** hitting a DB or API per item.
- **Obvious unbounded or O(n²) work** on data that can grow large.
- **Missing pagination** on lists that can get big.
- **Render thrash** (UI): work in a hot render path, missing memoisation where it measurably matters.
- Fix: batch the query, add pagination, hoist work out of the loop/render. Leave speculative optimisation alone.

---

## Note on scope
This pass **fixes and hardens**. It does not rewrite architecture, restyle UI, or refactor for taste. If correctness genuinely requires a structural change (e.g. the data model can't represent a valid state), write it as a `[HUMAN]` finding with a recommendation rather than auto-rewriting.
