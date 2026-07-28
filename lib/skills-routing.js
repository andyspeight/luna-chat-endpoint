// lib/skills-routing.js
// The skills-routing matcher lives in public/skills-routing.js as a UMD module
// so the browser (dashboard + widget) and node (this re-export + tests) share
// ONE implementation. Import it here for server-side use and tests.
'use strict';
module.exports = require('../public/skills-routing.js');
