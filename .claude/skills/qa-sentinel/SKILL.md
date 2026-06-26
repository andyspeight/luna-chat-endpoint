---
name: qa-sentinel
description: Autonomous, multi-round QA and security hardening pass for a whole project. Use whenever the user asks to QA, harden, audit, stress-test, pen-test, red-team, secure, robustify, or production-ready a project or codebase — or says things like "make sure this is robust", "is this hacker-proof", "find the bugs", "any security holes", "run the QA pass", "review the whole project", "before we ship", "before we deploy", or "go over this and fix what's wrong". This skill understands the specific project it lives in, then runs repeated sweeps that find security flaws, abuse/attack vectors, correctness bugs, and robustness gaps, fixes them in priority order with verification, and stops cleanly. It auto-fixes what it safely can and surfaces the rest for a human decision. Run it as a deliberate end-to-end pass, not on every tiny edit. Pairs with any project-specific security/design skills already installed — defer to those for house standards.
---

# QA Sentinel

A project-resident QA and security hardening engine. Drop it into a repo, point it at the project, and it runs **repeated sweeps** that:

1. learn what the project actually *is* and what it must protect,
2. hunt for security flaws, abuse/attack vectors, correctness bugs, and robustness gaps,
3. fix what can be fixed safely — with verification after every fix,
4. surface what needs a human decision,
5. stop cleanly instead of thrashing.

The whole point is robustness through **iteration with evidence**, not a single checklist sweep. One pass that finds and fixes the obvious things, then re-checks its own work and digs a layer deeper, beats a one-shot review every time.

This skill is defensive. It thinks like an attacker in order to *defend* — modelling how something could be broken or abused so it can be hardened. It never writes working exploit code, never weakens a control, and never ships anything to an attacker. Identifying a vulnerability is to fix it.

---

## The First Law

**Diagnose before you fix. Verify after you fix. Stop before you drift.**

An autonomous fixer's worst failure mode is thrashing: it guesses a cause, patches, the patch doesn't hold, it patches the patch, and an hour later the project is worse than when it started. Every rule below exists to prevent that. If you are about to edit code before you can state *what specifically is wrong, where, and how you know* — stop. You are about to thrash.

---

## How a run is structured

A run is a sequence of **sweeps**. Do them in order. Do not collapse them.

```
Sweep 0  Recon & context   → understand the project, establish a baseline   (no fixes)
Sweep 1  Security & abuse   → find security/attack/abuse findings            (no fixes)
Sweep 2  Correctness & robustness → find bug/robustness findings             (no fixes)
Sweep 3  Fix–verify loop    → fix findings in priority order, verify each
Sweep 4  Re-sweep           → repeat 1+2 to catch missed + fix-introduced issues
         … loop 3↔4 until convergence (see Stop Conditions) …
Sweep 5  Regression gate + report
```

Finding and fixing are deliberately separated. Find everything first, rank it, *then* fix in priority order. Fixing as you find leads to fixing low-severity noise while a P0 sits undiscovered, and to half-finished context.

---

## Sweep 0 — Recon & context (no fixes)

The skill must understand the *concept* of the project before it can judge what "broken" or "unsafe" means here. A bare-metal financial endpoint and a static marketing page have completely different threat models.

### 0.1 Load or build the project context

Look for `.claude/qa/PROJECT_CONTEXT.md`.

- **If it exists**, read it. Then sanity-check it against the current tree (new top-level dirs, new dependencies, new routes). If the project has materially changed, refresh the relevant sections.
- **If it does not exist**, build it now. Read, in this order: `README*`, `CLAUDE.md`/`AGENTS.md`, `package.json` / `requirements.txt` / `pyproject.toml` / `go.mod` (whatever exists), `.env.example` / env var names, the directory tree (2 levels), the route/endpoint/handler files, and the main entry point(s). Then write `.claude/qa/PROJECT_CONTEXT.md` using the template in `references/templates.md`.

`PROJECT_CONTEXT.md` is the brain of every future run. It must capture:

- **What this project is** — one paragraph, plain language. What it does, who uses it.
- **Stack & toolchain** — languages, frameworks, runtime, package manager, test runner, linter, build command, deploy target.
- **Trust boundaries** — what runs server-side (can hold secrets) vs what ships to the browser/client (is public). This single distinction drives most security findings.
- **Sensitive assets** — secrets/keys, PII, money/payments, write access to data, anything paid-per-call (LLM/API budgets), anything whose abuse costs real money.
- **Attack surface** — every public/anonymous entry point: routes, forms, webhooks, file uploads, query params, user-generated content, third-party callbacks.
- **Critical invariants** — the "must never happen" list for *this* project. e.g. "a non-admin must never read another tenant's records", "no secret ever reaches the client bundle", "a booking total can never be set from client input".

If a project-specific security or design skill is installed (e.g. a `*-security` skill), read it now and treat its rules as the house standard. This skill defers to it on specifics and adds the multi-round loop and the auto-fix discipline on top.

### 0.2 Establish the baseline

Detect and run whatever the toolchain provides, capturing pass/fail and counts. Run only what exists; degrade gracefully (a static site has no test runner). Typical set:

- Build / compile (e.g. `npm run build`, `tsc --noEmit`, `go build ./...`)
- Type check
- Lint (e.g. `eslint`, `ruff`)
- Tests (e.g. `npm test`, `pytest`)
- Dependency audit (e.g. `npm audit`, `pip-audit`)
- Secret scan of any built/shipped output (see `references/security-checklist.md` → "Secrets")

**Record the baseline numbers** (build: pass/fail; N tests passing; M lint errors; K audit advisories). The regression gate in Sweep 5 compares against these. You may not finish a run in a worse state than you started.

---

## Sweeps 1 & 2 — Find (no fixes)

Work the two catalogues against the *actual* attack surface and code, not in the abstract:

- **Sweep 1 — Security & abuse:** `references/security-checklist.md`
- **Sweep 2 — Correctness & robustness:** `references/qa-checklist.md`

For each issue you find, write a **finding** (don't fix yet):

```
[ID]  Pn  <category>  <file:line>
  What: one line — the concrete flaw, not a generic worry.
  Why it matters: the realistic consequence for THIS project (tie to a sensitive asset or invariant).
  Evidence: the specific code/output that proves it (a line, a response, an audit entry). Not "probably".
  Fix approach: the specific change. Mark [AUTO] (safe to fix now) or [HUMAN] (needs a decision).
```

A finding without evidence is a hypothesis — keep digging or drop it. Don't pad the report with speculative items; high signal only.

### Severity

| | meaning | default action |
|---|---|---|
| **P0** | Exploitable now; data, money, secrets, or platform at real risk | auto-fix this run; if not safely auto-fixable, **stop and flag immediately** |
| **P1** | Serious flaw or near-certain bug; would bite in production | auto-fix this run |
| **P2** | Real weakness or robustness gap; should be fixed | auto-fix this run |
| **P3** | Minor / hygiene / nice-to-have | note; auto-fix only if trivial and zero-risk |

### What is [HUMAN], not [AUTO]

Flag for a human decision instead of auto-fixing when the fix would:

- change a public API/contract, a schema, or a data shape other code depends on,
- delete or rewrite something whose intent is ambiguous,
- require a new dependency or a new secret/credential,
- involve auth/permission *policy* (who is allowed to do what) rather than a clear bug,
- touch money, billing, or anything legally/financially sensitive,
- be a design trade-off with no single right answer.

When in doubt, flag it. A flagged finding with a clear recommendation is a good outcome.

---

## Sweep 3 — Fix–verify loop

Fix findings in strict priority order (P0 → P1 → P2 → trivial P3). For **each** finding, run this micro-loop. Do not batch.

1. **State the fix and the success signal.** One or two lines: what change, and exactly what will prove it worked (an error gone, a test passing, an audit advisory cleared, a malicious input now rejected). If you can't state the success signal, you don't understand the finding — go back to Sweep 1/2.
2. **Make the smallest change that fixes it.** One logical fix. Do not "improve a few other things while here" — bundled changes hide which edit broke the build.
3. **Verify.** Re-run the relevant check(s). Did the success signal appear? Did anything else break?
4. **Resolve or escalate.**
   - Success signal appeared, nothing else broke → mark resolved.
   - Didn't work → **2-strike rule** below.

### The 2-strike rule (per finding)

After **two failed fix attempts on the same finding**, STOP fixing it:

- If the attempts left things worse, **revert them**.
- Re-classify the finding as `[HUMAN]` with a note: what you tried, why each attempt failed, what you now think is going on, and what evidence/decision would resolve it.
- Move on. Do not attempt a third blind fix. Two strikes — not five, not "let me just try one more thing".

This is the single most important rule in the skill. A flagged finding is fine. A patched patch that introduced two new bugs is not.

### Never fake green

These are forbidden, always. They make checks pass without fixing anything and quietly *reduce* robustness:

- Deleting, skipping, or weakening a test to make the suite green.
- Loosening an assertion or hardcoding an expected value to match buggy output.
- Silencing a finding with `eslint-disable`, `@ts-ignore`, `as any`, `# noqa`, `# nosec`, `# type: ignore`, broad `except: pass`, or an empty `catch {}`.
- Widening a `try`/`except` to swallow the error the finding is about.
- Weakening a security control (opening CORS, removing validation, disabling a check) to make something "work".
- Commenting out the failing code.

If the only way to make a check pass is one of the above, the finding is `[HUMAN]`. Suppression is not a fix.

### If a whole sweep regresses the build

If, after a fix–verify loop, the build or test suite is worse than the baseline and you can't quickly see why, **roll the sweep's changes back** to the last good state and re-enter Sweep 1/2 to re-diagnose. Never push forward on a broken foundation.

---

## Sweep 4 — Re-sweep (the "multiple rounds")

After a fix–verify loop, **re-run Sweeps 1 and 2**. This is what makes the pass robust rather than one-shot:

- Fixes can introduce new issues — catch them now.
- Some flaws are only visible once a louder one is gone.
- A second look with the project fully in context finds things the first pass missed.

Then loop back to Sweep 3 on any new findings. Continue 3↔4 until a Stop Condition is met.

### Stop Conditions (any one ends the loop)

- A full re-sweep produces **no new auto-fixable findings** (only `[HUMAN]` items remain).
- **Max rounds reached** — default **3** full find→fix→re-sweep cycles. Stopping at the cap with a clear list of what's left is a success, not a failure.
- Remaining findings are all `[HUMAN]` or all P3-noted.
- Two consecutive rounds make no net progress (same findings recurring) — stop and flag; you're at the edge of what's safely automatable.

A run that stops cleanly with three P0s flagged for human decision is far more valuable than one that "fixed everything" by suppressing checks.

---

## Sweep 5 — Regression gate + report

### 5.1 Regression gate (mandatory)

Before declaring done: full build + full test suite must pass, and the project must be **no worse than the baseline** on every metric (build status, tests passing, lint errors, audit advisories). If anything regressed, fix or revert until the gate is green. A hardening pass that leaves the build broken has failed regardless of how many findings it closed.

### 5.2 Write the report

Write `.claude/qa/QA_REPORT.md` (overwrite — latest run) using the template in `references/templates.md`. It must contain, in this order:

1. **Verdict** — one line. `SHIP` / `SHIP WITH NOTES` / `DO NOT SHIP` and why.
2. **Headline risks** — the most severe findings first.
3. **Fixed this run** — what was changed, grouped by severity, each with the file and a one-line description.
4. **Needs your decision** — every `[HUMAN]` finding with a specific recommendation.
5. **Residual risk** — what remains and why it wasn't auto-fixed.
6. **Run stats** — rounds completed, baseline → final metrics, what stopped the loop.

Then append one summary line to `.claude/qa/QA_LOG.md` (date, rounds, P0/P1/P2 fixed, P0/P1 remaining) so trends are visible across runs.

### 5.3 Report voice

Direct, priority-ranked, actionable, effort-aware. Lead with the worst thing. Every finding has a specific fix, not "improve security". No checklist recitation, no lecture. State ship-blockers as ship-blockers and safe things as safe.

---

## Operating rules

- **Read before you write.** Never edit a file you haven't viewed in this run. After editing it, your earlier view is stale — re-read before editing it again.
- **One logical fix at a time, always verified.** This is non-negotiable even when fixes look trivially safe.
- **No new dependencies or secrets without flagging.** Adding either is a `[HUMAN]` decision.
- **Don't redesign.** This pass hardens and fixes; it does not refactor architecture or restyle UI unless a specific finding requires it. Big rewrites are out of scope — flag them.
- **Stay in scope.** If recon reveals the project is far larger or more sensitive than expected (e.g. handles payments, health data, or auth for many tenants), say so up front and confirm scope before a deep automated pass.
- **Honesty over a clean-looking report.** "I found three serious issues I can't safely fix alone" is the right outcome when it's true.

---

## Self-check before finishing

1. Did I build `PROJECT_CONTEXT.md` and judge findings against *this* project's invariants — not a generic checklist?
2. Did I separate find from fix, and fix in priority order?
3. Does every fix have a verified success signal?
4. Did I respect the 2-strike rule and never fake green?
5. Is the regression gate green and the project no worse than baseline?
6. Does the report lead with the worst risk and give every `[HUMAN]` item a clear recommendation?

If any answer is no, the run isn't finished.

---

## One-line summary

**Learn the project, find with evidence, fix one-at-a-time with verification, re-sweep, stop after the cap, never fake green.**
