#!/usr/bin/env node
// Turns the Travelify geo export into the JSON table Luna loads at runtime.
//
//   node scripts/build-geo-table.js            # reads lib/geo/travelify-geo.csv
//   node scripts/build-geo-table.js ~/GeoExport.csv
//
// To refresh the table: export the geo list from Travelify, drop the CSV over
// lib/geo/travelify-geo.csv, run this script, commit both files. The CSV is
// the source of truth; the JSON is what api/luna-chat.js requires (a plain
// require is always bundled by Vercel, a file read at runtime is not).
//
// Expected columns (the Travelify export, verbatim):
//   City_ID, City_Name, City_CountryCode, City_IATACode,
//   City_Latitude, City_Longitude, City_RadiusOverrideMI
//
// Radius is in MILES. That is what the dl.tvllnk.com deeplink's `rad` takes.

'use strict';

const fs = require('fs');
const path = require('path');

const src = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'lib', 'geo', 'travelify-geo.csv');
const out = path.join(__dirname, '..', 'lib', 'geo', 'travelify-geo.json');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const rows = parseCsv(fs.readFileSync(src, 'utf8'));
const header = rows.shift().map((h) => h.trim());
const col = (name) => {
  const i = header.indexOf(name);
  if (i === -1) throw new Error('column missing from export: ' + name);
  return i;
};
const iId = col('City_ID'), iName = col('City_Name'), iCc = col('City_CountryCode'),
  iIata = col('City_IATACode'), iLat = col('City_Latitude'), iLng = col('City_Longitude'),
  iRad = col('City_RadiusOverrideMI');

const table = [];
const problems = [];
rows.forEach((r, n) => {
  const name = (r[iName] || '').trim();
  const lat = parseFloat(r[iLat]), lng = parseFloat(r[iLng]), rad = parseFloat(r[iRad]);
  if (!name || !isFinite(lat) || !isFinite(lng) || !isFinite(rad) || rad <= 0) {
    problems.push('row ' + (n + 2) + ' skipped: ' + JSON.stringify(r));
    return;
  }
  table.push({
    id: String(r[iId] || '').trim(),
    name,
    cc: (r[iCc] || '').trim().toUpperCase(),
    iata: (r[iIata] || '').trim().toUpperCase(),
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    radiusMi: rad
  });
});

// The export can carry the same name twice with different centres (Zakinthos
// did). Keep the wider one: a search that is slightly too broad still shows the
// right hotels; one that is too tight hides them.
const byName = new Map();
table.forEach((t) => {
  const prev = byName.get(t.name);
  if (!prev || t.radiusMi > prev.radiusMi) byName.set(t.name, t);
  if (prev) problems.push('duplicate name "' + t.name + '" (radius ' + prev.radiusMi + ' and ' + t.radiusMi + '), kept the wider');
});

const final = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(out, JSON.stringify({
  source: path.basename(src),
  unit: 'miles',
  builtAt: new Date().toISOString().slice(0, 10),
  rows: final
}, null, 0) + '\n');

console.log('wrote ' + final.length + ' destinations to ' + path.relative(process.cwd(), out));
problems.forEach((p) => console.log('  note: ' + p));
