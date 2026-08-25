import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/rbac';
import { listUsers, createUser, setUserActive, setUserRole, setUserPassword, countAdmins, getUserById } from '@/lib/auth/users';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/password';
import { destroyAllSessionsForUser } from '@/lib/auth/session';
import { recordAudit } from '@/lib/database/mutations';
import { getLastSuccessfulSyncAt } from '@/lib/sync/run';
import { AppHeader } from '@/components/AppHeader';
import { formatDateTime } from '@/lib/time';
import { logger } from '@/lib/logger';
import type { UserRole } from '@/lib/types';

export const dynamic = 'force-dynamic';

function isRole(value: string): value is UserRole {
  return value === 'admin' || value === 'fulfillment';
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const currentUser = await requirePermission('users:manage', '/users');
  const params = await searchParams;
  const notice = typeof params.notice === 'string' ? params.notice : null;
  const error = typeof params.error === 'string' ? params.error : null;

  const [users, lastSyncAt] = await Promise.all([listUsers(), getLastSuccessfulSyncAt()]);

  async function addUser(formData: FormData) {
    'use server';
    const admin = await requirePermission('users:manage', '/users');

    const email = String(formData.get('email') ?? '').trim();
    const name = String(formData.get('name') ?? '').trim();
    const roleValue = String(formData.get('role') ?? 'fulfillment');
    const password = String(formData.get('password') ?? '');

    if (!email || !name || !isRole(roleValue)) {
      revalidatePath('/users');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      revalidatePath('/users');
      return;
    }

    try {
      const created = await createUser({ email, name, role: roleValue, password });
      await recordAudit({
        userId: admin.id,
        actorEmail: admin.email,
        action: 'user.create',
        entityType: 'user',
        entityId: created.id,
        detail: { email: created.email, role: created.role },
      });
    } catch (err) {
      logger.warn('user creation failed', { error: err });
    }
    revalidatePath('/users');
  }

  async function toggleActive(formData: FormData) {
    'use server';
    const admin = await requirePermission('users:manage', '/users');
    const userId = String(formData.get('userId') ?? '');
    const makeActive = String(formData.get('active') ?? '') === 'true';

    const target = await getUserById(userId);
    if (!target) return;

    // Never let the last active administrator lock everyone out.
    if (!makeActive && target.role === 'admin' && (await countAdmins()) <= 1) {
      logger.warn('refused to deactivate the last active admin', { userId });
      revalidatePath('/users');
      return;
    }

    await setUserActive(userId, makeActive);
    await recordAudit({
      userId: admin.id,
      actorEmail: admin.email,
      action: makeActive ? 'user.activate' : 'user.deactivate',
      entityType: 'user',
      entityId: userId,
    });
    revalidatePath('/users');
  }

  async function changeRole(formData: FormData) {
    'use server';
    const admin = await requirePermission('users:manage', '/users');
    const userId = String(formData.get('userId') ?? '');
    const roleValue = String(formData.get('role') ?? '');
    if (!isRole(roleValue)) return;

    const target = await getUserById(userId);
    if (!target) return;

    if (target.role === 'admin' && roleValue !== 'admin' && (await countAdmins()) <= 1) {
      logger.warn('refused to demote the last active admin', { userId });
      revalidatePath('/users');
      return;
    }

    await setUserRole(userId, roleValue);
    await recordAudit({
      userId: admin.id,
      actorEmail: admin.email,
      action: 'user.role_change',
      entityType: 'user',
      entityId: userId,
      detail: { from: target.role, to: roleValue },
    });
    revalidatePath('/users');
  }

  async function resetPassword(formData: FormData) {
    'use server';
    const admin = await requirePermission('users:manage', '/users');
    const userId = String(formData.get('userId') ?? '');
    const password = String(formData.get('password') ?? '');
    if (password.length < MIN_PASSWORD_LENGTH) return;

    await setUserPassword(userId, password);
    // A password change invalidates every existing session for that user.
    await destroyAllSessionsForUser(userId);
    await recordAudit({
      userId: admin.id,
      actorEmail: admin.email,
      action: 'user.password_reset',
      entityType: 'user',
      entityId: userId,
    });
    revalidatePath('/users');
  }

  return (
    <>
      <AppHeader user={currentUser} lastSyncAt={lastSyncAt} />
      <main className="container">
        <h1 style={{ fontSize: 18, margin: '0 0 16px' }}>Users</h1>

        {notice && <div className="form-success">{notice}</div>}
        {error && <div className="form-error">{error}</div>}

        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-header"><h2 className="panel-title">Add a user</h2></div>
          <div className="panel-body">
            <form action={addUser} className="toolbar" style={{ alignItems: 'flex-end', gap: 12 }}>
              <div style={{ flex: '1 1 200px' }}>
                <label className="field-label" htmlFor="new-name">Name</label>
                <input id="new-name" name="name" required maxLength={120} />
              </div>
              <div style={{ flex: '1 1 220px' }}>
                <label className="field-label" htmlFor="new-email">Email</label>
                <input id="new-email" name="email" type="email" required maxLength={200} />
              </div>
              <div style={{ flex: '0 1 150px' }}>
                <label className="field-label" htmlFor="new-role">Role</label>
                <select id="new-role" name="role" defaultValue="fulfillment">
                  <option value="fulfillment">Fulfillment</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div style={{ flex: '1 1 200px' }}>
                <label className="field-label" htmlFor="new-password">
                  Password (min {MIN_PASSWORD_LENGTH})
                </label>
                <input
                  id="new-password"
                  name="password"
                  type="password"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                />
              </div>
              <button type="submit" className="btn btn-primary">Create user</button>
            </form>
            <p className="subtle" style={{ marginTop: 10, marginBottom: 0 }}>
              Admins can view everything, resolve exceptions, add notes and manage users.
              Fulfillment can view shipments, search, view tracking and add notes.
            </p>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header"><h2 className="panel-title">Existing users</h2></div>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last login</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((row) => (
                  <tr key={row.id} className={row.is_active ? '' : 'row-resolved'}>
                    <td style={{ fontWeight: 500 }}>{row.name}</td>
                    <td className="muted">{row.email}</td>
                    <td>
                      <form action={changeRole} className="toolbar">
                        <input type="hidden" name="userId" value={row.id} />
                        <select name="role" defaultValue={row.role} style={{ width: 130 }}>
                          <option value="fulfillment">Fulfillment</option>
                          <option value="admin">Admin</option>
                        </select>
                        <button type="submit" className="btn btn-sm">Save</button>
                      </form>
                    </td>
                    <td>
                      <span className={`badge tone-${row.is_active ? 'success' : 'neutral'}`}>
                        {row.is_active ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td className="nowrap">{formatDateTime(row.last_login_at)}</td>
                    <td>
                      <div className="toolbar">
                        <form action={toggleActive}>
                          <input type="hidden" name="userId" value={row.id} />
                          <input type="hidden" name="active" value={row.is_active ? 'false' : 'true'} />
                          <button type="submit" className="btn btn-sm">
                            {row.is_active ? 'Disable' : 'Enable'}
                          </button>
                        </form>
                        <form action={resetPassword} className="toolbar">
                          <input type="hidden" name="userId" value={row.id} />
                          <input
                            type="password"
                            name="password"
                            placeholder="New password"
                            minLength={MIN_PASSWORD_LENGTH}
                            style={{ width: 150 }}
                            autoComplete="new-password"
                            aria-label={`New password for ${row.name}`}
                          />
                          <button type="submit" className="btn btn-sm">Reset</button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </>
  );
}
