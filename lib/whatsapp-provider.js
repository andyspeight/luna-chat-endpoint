// lib/whatsapp-provider.js
// THE PROVIDER SEAM (dispatcher). The webhook and send endpoint import only this
// module; it forwards to the active implementation under lib/providers/ chosen
// by env WHATSAPP_PROVIDER ("gupshup" | "360dialog"). Swapping providers — or
// later cutting over to direct Meta — is a config change here plus one new file
// in lib/providers/, never a change to the orchestration code.
//
//   WHATSAPP_PROVIDER=gupshup    (default) cheapest: no fixed/per-number fee
//   WHATSAPP_PROVIDER=360dialog            Meta-native; cleanest future Meta exit
//
// Interface (all providers implement these): getNumberConfig, getConfigByClientId,
// parseInbound, sendText, verifyMetaSignature. Inbound auth (verifyChallenge /
// verifyInbound) and safeEqual are provider-independent (shared).

const shared = require('./providers/_shared');

const IMPLS = {
  'gupshup': require('./providers/gupshup'),
  '360dialog': require('./providers/360dialog')
};
const DEFAULT = 'gupshup';

function providerName() {
  var n = String(process.env.WHATSAPP_PROVIDER || DEFAULT).toLowerCase().trim();
  return IMPLS[n] ? n : DEFAULT;
}
function impl() { return IMPLS[providerName()]; }

module.exports = {
  get name() { return providerName(); },

  // provider-independent (shared)
  verifyChallenge: shared.verifyChallenge,
  verifyInbound: shared.verifyInbound,
  safeEqual: shared.safeEqual,

  // delegated to the active provider (resolved per call so env can switch)
  getNumberConfig: function (id) { return impl().getNumberConfig(id); },
  getConfigByClientId: function (id) { return impl().getConfigByClientId(id); },
  parseInbound: function (body) { return impl().parseInbound(body); },
  sendText: function (cfg, to, text) { return impl().sendText(cfg, to, text); },
  verifyMetaSignature: function (raw, sig) { return impl().verifyMetaSignature(raw, sig); }
};
