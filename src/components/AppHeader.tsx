import Link from 'next/link';
import { formatDateTime, DISPLAY_TZ } from '@/lib/time';
import type { SessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';

export function AppHeader({
  user,
  lastSyncAt,
}: {
  user: SessionUser;
  lastSyncAt: Date | null;
}) {
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link href="/" className="brand" style={{ color: 'inherit' }}>
          Lavi MD <span>Shipping Audit</span>
        </Link>

        <nav className="toolbar" style={{ gap: 14, fontSize: 13 }}>
          <Link href="/">Dashboard</Link>
          {can(user.role, 'system:view') && <Link href="/system">System</Link>}
          {can(user.role, 'users:manage') && <Link href="/users">Users</Link>}
        </nav>

        <div className="header-spacer" />

        <div className="header-meta">
          <div>
            Last sync:{' '}
            {lastSyncAt ? formatDateTime(lastSyncAt) : <span className="muted">never</span>}
          </div>
          <div className="subtle">Times shown in {DISPLAY_TZ.replace('_', ' ')}</div>
        </div>

        <div style={{ fontSize: 13, textAlign: 'right' }}>
          <div style={{ fontWeight: 600 }}>{user.name}</div>
          <div className="subtle" style={{ textTransform: 'capitalize' }}>{user.role}</div>
        </div>

        <form action="/api/auth/logout" method="post">
          <button type="submit" className="btn btn-sm">Sign out</button>
        </form>
      </div>
    </header>
  );
}
