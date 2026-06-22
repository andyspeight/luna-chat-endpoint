import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Travelgenix Back Office',
  description: 'Single source of truth for bookings, financials and suppliers.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="layout">
          <aside className="sidebar">
            <div className="brand">Back Office<small>Travelgenix</small></div>
            <nav className="nav">
              <Link href="/">Overview</Link>
              <Link href="/bookings">Bookings</Link>
              <Link href="/payments">Payments &amp; AR</Link>
              <Link href="/suppliers">Suppliers &amp; AP</Link>
            </nav>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
