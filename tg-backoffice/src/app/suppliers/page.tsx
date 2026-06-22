import { getSql, money } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Supplier = { id: string; name: string; kind: string; default_currency: string;
  is_api_supplier: boolean; active: boolean; payables: string };

export default async function Suppliers() {
  let rows: Supplier[] = []; let error: string | null = null;
  try {
    const sql = getSql();
    rows = (await sql`
      select s.id, s.name, s.kind, s.default_currency, s.is_api_supplier, s.active,
             coalesce((select sum(sb.outstanding) from backoffice.supplier_bill sb
                       where sb.supplier_id = s.id and sb.status not in ('paid','void')),0) as payables
      from backoffice.supplier s
      order by s.name asc
      limit 500`) as unknown as Supplier[];
  } catch (e) { error = (e as Error).message; }

  return (
    <>
      <h1>Suppliers &amp; AP</h1>
      <p className="sub">The canonical supplier master, with outstanding payables (money we owe out).</p>
      {error ? (
        <div className="notice">Database not configured. Set <code>DATABASE_URL</code>. Detail: {error}</div>
      ) : rows.length === 0 ? (
        <div className="empty">No suppliers yet. Run the supplier reconciliation step to import the Airtable trade
          suppliers and the contract suppliers into the master.</div>
      ) : (
        <table>
          <thead><tr><th>Supplier</th><th>Kind</th><th>API</th><th>Active</th><th className="right">Payables outstanding</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{r.kind}</td>
                <td>{r.is_api_supplier ? 'Yes' : '—'}</td>
                <td>{r.active ? 'Yes' : 'No'}</td>
                <td className="right">{money(r.payables, r.default_currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
