import { getSql, money } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function loadKpis() {
  const sql = getSql();
  const [bookings, ar, ap, suppliers] = await Promise.all([
    sql`select count(*)::int as n, coalesce(sum(sell_total),0) as sell, coalesce(sum(margin_total),0) as margin
        from backoffice.booking`,
    sql`select coalesce(sum(balance_due),0) as due from backoffice.booking where balance_due > 0`,
    sql`select coalesce(sum(outstanding),0) as out from backoffice.supplier_bill where status not in ('paid','void')`,
    sql`select count(*)::int as n from backoffice.supplier where active`,
  ]);
  return {
    bookings: bookings[0].n as number,
    sell: bookings[0].sell as string,
    margin: bookings[0].margin as string,
    balanceDue: ar[0].due as string,
    payables: ap[0].out as string,
    suppliers: suppliers[0].n as number,
  };
}

export default async function Home() {
  let data: Awaited<ReturnType<typeof loadKpis>> | null = null;
  let error: string | null = null;
  try { data = await loadKpis(); } catch (e) { error = (e as Error).message; }

  return (
    <>
      <h1>Overview</h1>
      <p className="sub">Bookings, money and suppliers — one source of truth.</p>
      {error ? (
        <div className="notice">
          Could not reach the database. Set <code>DATABASE_URL</code> (see <code>.env.example</code>) in your
          environment / Vercel project. <br />Detail: {error}
        </div>
      ) : (
        <>
          <div className="kpis">
            <div className="kpi"><div className="label">Bookings</div><div className="value">{data!.bookings}</div></div>
            <div className="kpi"><div className="label">Sales value</div><div className="value">{money(data!.sell)}</div></div>
            <div className="kpi"><div className="label">Margin</div><div className="value">{money(data!.margin)}</div></div>
            <div className="kpi"><div className="label">Active suppliers</div><div className="value">{data!.suppliers}</div></div>
          </div>
          <div className="kpis" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <div className="kpi"><div className="label">Customer balance due (AR)</div><div className="value">{money(data!.balanceDue)}</div></div>
            <div className="kpi"><div className="label">Supplier payables outstanding (AP)</div><div className="value">{money(data!.payables)}</div></div>
          </div>
        </>
      )}
    </>
  );
}
