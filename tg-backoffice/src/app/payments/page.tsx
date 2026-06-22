import { getSql, money } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Due = { booking_no: string | null; lead_name: string | null; kind: string;
  amount: string; currency: string; due_date: string | null; status: string };

export default async function Payments() {
  let rows: Due[] = []; let error: string | null = null;
  try {
    const sql = getSql();
    rows = (await sql`
      select booking_no, lead_name, kind, amount, currency, due_date, status
      from backoffice.v_receipts_due
      order by due_date asc nulls last
      limit 200`) as unknown as Due[];
  } catch (e) { error = (e as Error).message; }

  return (
    <>
      <h1>Payments &amp; AR</h1>
      <p className="sub">Customer money owed to us — the deposit / balance schedule, by due date.</p>
      {error ? (
        <div className="notice">Database not configured. Set <code>DATABASE_URL</code>. Detail: {error}</div>
      ) : rows.length === 0 ? (
        <div className="empty">No scheduled or pending customer payments.</div>
      ) : (
        <table>
          <thead><tr><th>Booking</th><th>Lead</th><th>Type</th><th>Due</th><th>Status</th><th className="right">Amount</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r.booking_no ?? '—'}</td>
                <td>{r.lead_name ?? '—'}</td>
                <td>{r.kind}</td>
                <td>{r.due_date ?? '—'}</td>
                <td>{r.status}</td>
                <td className="right">{money(r.amount, r.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
