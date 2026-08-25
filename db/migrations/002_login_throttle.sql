-- =============================================================================
-- Login attempt throttling.
--
-- The application is internet-facing on shipping.lavimd.store, so the sign-in
-- form is reachable by anyone who finds the hostname. Attempts are recorded and
-- throttled per identifier (email and client IP are tracked separately) so a
-- credential-stuffing run is slowed to uselessness without locking a real user
-- out permanently.
-- =============================================================================

CREATE TABLE login_attempts (
  id            BIGSERIAL PRIMARY KEY,
  -- 'email:someone@example.com' or 'ip:203.0.113.4'
  identifier    TEXT NOT NULL,
  successful    BOOLEAN NOT NULL,
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX login_attempts_identifier_time_idx
  ON login_attempts (identifier, attempted_at DESC);

-- Supports the periodic purge of old rows.
CREATE INDEX login_attempts_attempted_at_idx ON login_attempts (attempted_at);
