// Regression tests for the cross-tenant account-visibility breach.
//
// The central auth platform's `role` is a role WITHIN the user's own organisation.
// A client who owns their own agency account legitimately has role 'owner'. The
// code treated owner/admin as a PLATFORM superuser, so every such client was shown
// — and could load and edit — every other tenant's Luna account. A client did
// exactly that in production against the Travelgenix record.
//
// Rule now: cross-tenant requires the role AND a Travelgenix staff domain.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const auth = require('../lib/luna-auth');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('a CLIENT who is owner/admin of their own org gets NO cross-tenant access', () => {
  assert.equal(auth.isCrossTenantUser('owner', 'director@thatsmydreamholiday.com'), false,
    'this exact user reached another tenant in production — must never be cross-tenant');
  assert.equal(auth.isCrossTenantUser('admin', 'director@thatsmydreamholiday.com'), false);
  assert.equal(auth.isCrossTenantUser('owner', 'hello@sunshinetravel.com'), false);
});

test('Travelgenix staff keep cross-tenant access', () => {
  assert.equal(auth.isCrossTenantUser('owner', 'andy.speight@agendas.group'), true);
  assert.equal(auth.isCrossTenantUser('owner', 'info@travelgenix.io'), true);
  assert.equal(auth.isCrossTenantUser('admin', 'someone@travelify.io'), true);
});

test('a staff domain WITHOUT an elevated role is not cross-tenant (both required)', () => {
  assert.equal(auth.isCrossTenantUser('member', 'someone@agendas.group'), false);
  assert.equal(auth.isCrossTenantUser('', 'someone@agendas.group'), false);
});

test('malformed / missing identities fail closed', () => {
  [undefined, null, '', 'not-an-email', '@', 'a@', '@b.com'].forEach(function (e) {
    assert.equal(auth.isCrossTenantUser('owner', e), false, 'must fail closed for: ' + JSON.stringify(e));
  });
});

test('domain matching cannot be spoofed by a lookalike domain', () => {
  // Suffix-matching would wrongly admit these.
  assert.equal(auth.isCrossTenantUser('owner', 'x@notagendas.group'), false);
  assert.equal(auth.isCrossTenantUser('owner', 'x@agendas.group.evil.com'), false);
  assert.equal(auth.isCrossTenantUser('owner', 'x@evil-travelify.io'), false);
});

// ── the two enforcement points must both use it ──
test('GUARD: auth-session lists cross-tenant accounts only for staff', () => {
  const SRC = read('api/auth-session.js');
  assert.match(SRC, /isCrossTenantUser\(role, email\)/, 'candidate listing must be staff-gated');
  assert.doesNotMatch(SRC, /CROSS_TENANT_ROLES\.has\(role\)/, 'the role-only check must be gone');
});

test('GUARD: resolveEntitledClient grants any-client access only to staff', () => {
  const SRC = read('lib/luna-auth.js');
  assert.match(SRC, /if \(isCrossTenantUser\(session\.role,/, 'entitlement must be staff-gated');
  assert.doesNotMatch(SRC, /if \(CROSS_TENANT_ROLES\.has\(session\.role\)\)/, 'the role-only check must be gone');
});

test('GUARD: the switcher button reflects the user OWN accounts, not role', () => {
  const DASH = read('public/dashboard.html');
  // Tightened further: Switch exists for a client who owns several websites, so
  // it counts data.accounts (own) rather than everything the user may open. A
  // staff member's ability to support clients is not a reason to offer a switcher.
  assert.match(DASH, /ownCount > 1/, 'switcher must show only with >1 OWN account');
  assert.doesNotMatch(DASH, /canSwitch = CONFIG\.USER_ROLE === 'owner'/, 'role-based switcher must be gone');
});
