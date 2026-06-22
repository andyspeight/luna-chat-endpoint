import { getSql, money } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Row = {
  id: string; booking_no: string | null; status: string; payment_status: string;
  currency: string; lead_name: string | null; destination: string | null;
  depart_date: string | null; sell_total: string; margin_total: string;
  paid_total: string; balance_due: string; item_count: number;
};

export default async function Bookings() {
  let rows: Row[] = []; let error: string | null = null;
  try {
    const sql = getSql();
    rows = (await sql`
      select id, booking_no, status, payment_status, currency, lead_name, destination,
             depart_date, sell_total, margin_total, paid_total, balance_due, item_count
      from backoffice.v_booking_finance
      order by created_at desc
      limit 200`) as unknown as Row[];
  } catch (e) { error = (e as Error).message; }

  return (
    <>
      <h1>Bookings</h1>
      <p className="sub">Every booking, with live sell / margin / balance from line items and receipts.</p>
      {error ? (
        <div className="notice">Database not configured. Set <code>DATABASE_URL</code>. Detail: {error}</div>
      ) : rows.length === 0 ? (
        <div className="empty">No bookings yet. They will appear here once created manually, imported from the
          booking engine, or ingested from supplier confirmation emails.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Ref</th><th>Lead</th><th>Destination</th><th>Depart</th><th>Status</th>
              <th className="right">Sell</th><th className="right">Margin</th>
              <th className="right">Paid</th><th className="right">Balance</th><th>Pay</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.booking_no ?? '—'}</td>
                <td>{r.lead_name ?? '—'}</td>
                <td>{r.destination ?? '—'}</td>
                <td>{r.depart_date ?? '—'}</td>
                <td>{r.status}</td>
                <td className="right">{money(r.sell_total, r.currency)}</td>
                <td className="right">{money(r.margin_total, r.currency)}</td>
                <td className="right">{money(r.paid_total, r.currency)}</td>
                <td className="right">{money(r.balance_due, r.currency)}</td>
                <td><span className={`pill ${r.payment_status}`}>{r.payment_status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
