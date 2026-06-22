import 'server-only';
import postgres from 'postgres';

// Lazy singleton so a missing env var surfaces as a friendly runtime message
// rather than crashing the build. The backoffice/contracts schemas are not
// exposed to PostgREST, so we talk to Postgres directly, server-side only.
let _sql: ReturnType<typeof postgres> | null = null;

export function getSql() {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example and set the Supabase pooler connection string.');
  }
  _sql = postgres(url, {
    // Supabase transaction pooler (pgBouncer) does not support prepared statements.
    prepare: false,
    ssl: 'require',
    max: 5,
    idle_timeout: 20,
  });
  return _sql;
}

export const money = (n: number | string | null | undefined, ccy = 'GBP') => {
  const v = Number(n ?? 0);
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: ccy }).format(v);
  } catch {
    return `${ccy} ${v.toFixed(2)}`;
  }
};
