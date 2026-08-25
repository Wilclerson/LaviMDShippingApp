import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getCurrentUser, createSession, setSessionCookie } from '@/lib/auth/session';
import { authenticate } from '@/lib/auth/users';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/** Only allow same-origin relative paths, so ?next= cannot become an open redirect. */
function safeNext(value: string | undefined): string {
  if (!value) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const nextPath = safeNext(typeof params.next === 'string' ? params.next : undefined);
  const errorCode = typeof params.error === 'string' ? params.error : null;

  const existing = await getCurrentUser();
  if (existing) redirect(nextPath);

  async function signIn(formData: FormData) {
    'use server';

    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const target = safeNext(String(formData.get('next') ?? '/'));

    if (!email || !password) {
      redirect(`/login?error=missing&next=${encodeURIComponent(target)}`);
    }

    const user = await authenticate(email, password);
    if (!user) {
      // Deliberately vague: never reveal whether the account exists.
      logger.warn('failed login attempt', { emailDomain: email.split('@')[1] ?? 'unknown' });
      redirect(`/login?error=invalid&next=${encodeURIComponent(target)}`);
    }

    const headerList = await headers();
    const { token, expiresAt } = await createSession(user.id, {
      userAgent: headerList.get('user-agent'),
      ipAddress: headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    });
    await setSessionCookie(token, expiresAt);
    logger.info('user signed in', { userId: user.id, role: user.role });

    redirect(target);
  }

  const message =
    errorCode === 'invalid'
      ? 'Incorrect email or password.'
      : errorCode === 'missing'
        ? 'Enter both an email address and a password.'
        : errorCode === 'forbidden'
          ? 'Your account does not have access to that page.'
          : null;

  return (
    <main className="login-wrap">
      <div className="login-card">
        <h1 style={{ fontSize: 18, margin: '0 0 4px' }}>Lavi MD Shipping Audit</h1>
        <p className="subtle" style={{ margin: '0 0 20px' }}>Internal access only.</p>

        {message && <div className="form-error">{message}</div>}

        <form action={signIn}>
          <input type="hidden" name="next" value={nextPath} />
          <div className="form-row">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="username" required autoFocus />
          </div>
          <div className="form-row">
            <label htmlFor="password">Password</label>
            <input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: 6 }}>
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
