-- =============================================================================
-- Lavi MD Shipping Audit — initial schema
--
-- Design rules baked into this schema:
--   * All timestamps are stored in UTC (timestamptz). Display conversion to
--     America/New_York happens in the application layer only.
--   * tracking_number is the primary dedup key between ShipStation and UPS.
--   * Historical timestamps (label_created_at, first_carrier_scan_at) are
--     write-once: the sync layer never overwrites a non-null value with a
--     later observation. Enforced by trigger below as a safety net.
--   * Shipment records are never deleted. Resolution is a flag + audit trail.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- --- enums -------------------------------------------------------------------

-- Where the shipment record originated.
CREATE TYPE shipment_source AS ENUM (
  'shipstation',           -- generic ShipStation store (name kept in source_store)
  'wholesale_danielle'     -- exists in the UPS account but not in ShipStation
);

-- Normalised internal status. The whole point of the application:
-- LABEL_CREATED is NOT "shipped".
CREATE TYPE normalized_status AS ENUM (
  'LABEL_CREATED',   -- label exists, UPS has no physical possession scan
  'AGING_LABEL',     -- LABEL_CREATED and older than the aging threshold
  'SHIPPED',         -- UPS recorded its first physical possession/origin scan
  'IN_TRANSIT',      -- moving through the UPS network
  'DELIVERED',       -- UPS confirms delivery
  'EXCEPTION',       -- carrier exception / failed delivery / return / damage
  'VOIDED',          -- label voided in ShipStation or UPS
  'UNKNOWN'          -- no usable carrier signal yet
);

CREATE TYPE user_role AS ENUM ('admin', 'fulfillment');

-- --- users -------------------------------------------------------------------

CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT NOT NULL,
  name              TEXT NOT NULL,
  role              user_role NOT NULL DEFAULT 'fulfillment',
  password_hash     TEXT NOT NULL,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (LOWER(email));

CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent      TEXT,
  ip_address      TEXT
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- --- shipments ---------------------------------------------------------------

CREATE TABLE shipments (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Primary dedup key. Normalised (uppercase, no whitespace) by the app.
  tracking_number           TEXT NOT NULL,

  source                    shipment_source NOT NULL,
  -- Human-facing source label, e.g. "Lavi MD Shopify Store" or
  -- "Wholesale / Danielle". Kept denormalised for fast filtering/display.
  source_store              TEXT,
  shipstation_store_id      TEXT,

  customer_name             TEXT,
  company_name              TEXT,

  -- NULL for wholesale / Danielle shipments — they have no internal order.
  order_number              TEXT,
  shipstation_order_id      TEXT,
  shipstation_shipment_id   TEXT,
  shipstation_label_id      TEXT,
  shipstation_status        TEXT,

  carrier                   TEXT,
  service                   TEXT,

  -- Historical, write-once timestamps. Never overwritten once set.
  label_created_at          TIMESTAMPTZ,
  ship_date                 DATE,
  first_carrier_scan_at     TIMESTAMPTZ,
  delivered_at              TIMESTAMPTZ,

  destination_city          TEXT,
  destination_state         TEXT,
  destination_postal_code   TEXT,
  destination_country       TEXT,

  ups_status                TEXT,   -- raw UPS status description
  ups_status_code           TEXT,   -- raw UPS status code (e.g. "MP", "OR")
  ups_status_type           TEXT,   -- raw UPS status type (M/I/D/X/U/P)
  normalized_status         normalized_status NOT NULL DEFAULT 'UNKNOWN',

  latest_tracking_event     TEXT,
  latest_tracking_event_at  TIMESTAMPTZ,
  exception_type            TEXT,

  -- True once a physical (non-logical, non-manifest) UPS scan is observed.
  -- Denormalised from first_carrier_scan_at for index-friendly filtering.
  has_physical_scan         BOOLEAN NOT NULL DEFAULT FALSE,

  first_seen_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at            TIMESTAMPTZ,
  last_tracking_check_at    TIMESTAMPTZ,

  manually_resolved         BOOLEAN NOT NULL DEFAULT FALSE,
  manually_resolved_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  manually_resolved_at      TIMESTAMPTZ,
  resolution_reason         TEXT,
  resolution_note           TEXT,

  notes                     TEXT,

  -- Raw payloads for forensic replay. Never surfaced to the browser.
  raw_shipstation           JSONB,
  raw_ups                   JSONB,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The dedup guarantee: one row per tracking number, full stop.
CREATE UNIQUE INDEX shipments_tracking_number_key ON shipments (tracking_number);

CREATE INDEX shipments_normalized_status_idx  ON shipments (normalized_status);
CREATE INDEX shipments_source_idx             ON shipments (source);
CREATE INDEX shipments_label_created_at_idx   ON shipments (label_created_at DESC);
CREATE INDEX shipments_store_idx              ON shipments (shipstation_store_id);
CREATE INDEX shipments_order_number_idx       ON shipments (order_number);
CREATE INDEX shipments_shipstation_ship_idx   ON shipments (shipstation_shipment_id);

-- Partial index driving the "Needs Attention" view and the morning email.
-- Unresolved shipments with no physical carrier scan are the working set.
CREATE INDEX shipments_needs_attention_idx
  ON shipments (label_created_at DESC)
  WHERE manually_resolved = FALSE
    AND (has_physical_scan = FALSE OR normalized_status = 'EXCEPTION');

-- Global search across customer / order / tracking.
CREATE INDEX shipments_search_idx ON shipments USING GIN (
  to_tsvector('simple',
    COALESCE(customer_name, '') || ' ' ||
    COALESCE(company_name, '')  || ' ' ||
    COALESCE(order_number, '')  || ' ' ||
    COALESCE(tracking_number, ''))
);
CREATE INDEX shipments_tracking_prefix_idx ON shipments (tracking_number text_pattern_ops);

-- --- carrier event history ---------------------------------------------------

-- Append-only. Carrier scans are never updated or deleted, so the answer to
-- "did order X actually leave the facility on Tuesday?" stays reconstructable.
CREATE TABLE shipment_events (
  id                  BIGSERIAL PRIMARY KEY,
  shipment_id         UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  tracking_number     TEXT NOT NULL,

  occurred_at         TIMESTAMPTZ NOT NULL,
  description         TEXT NOT NULL,
  status_code         TEXT,
  status_type         TEXT,

  location_city       TEXT,
  location_state      TEXT,
  location_country    TEXT,

  -- TRUE when this event represents actual UPS physical possession of the
  -- package (origin scan, pickup scan, arrival/departure scan, delivery).
  -- FALSE for manifest / "label created" / billing-information-received rows.
  is_physical_scan    BOOLEAN NOT NULL DEFAULT FALSE,

  -- Where the event came from: 'ups_tracking' | 'ups_quantum_view' | 'shipstation'
  event_source        TEXT NOT NULL,

  -- Stable hash of the event's identity, used to make ingestion idempotent.
  dedup_key           TEXT NOT NULL,

  raw                 JSONB,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX shipment_events_dedup_idx ON shipment_events (shipment_id, dedup_key);
CREATE INDEX shipment_events_shipment_time_idx ON shipment_events (shipment_id, occurred_at DESC);
CREATE INDEX shipment_events_physical_idx
  ON shipment_events (shipment_id, occurred_at)
  WHERE is_physical_scan = TRUE;

-- --- status history ----------------------------------------------------------

CREATE TABLE shipment_status_history (
  id                BIGSERIAL PRIMARY KEY,
  shipment_id       UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  from_status       normalized_status,
  to_status         normalized_status NOT NULL,
  reason            TEXT,
  changed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX shipment_status_history_shipment_idx
  ON shipment_status_history (shipment_id, changed_at DESC);

-- --- notes + audit -----------------------------------------------------------

CREATE TABLE shipment_notes (
  id            BIGSERIAL PRIMARY KEY,
  shipment_id   UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  author_name   TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX shipment_notes_shipment_idx ON shipment_notes (shipment_id, created_at DESC);

-- Immutable audit trail. Every administrative action lands here.
CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_email   TEXT,
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  detail        JSONB,
  ip_address    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);

-- --- sync + delivery observability -------------------------------------------

CREATE TABLE sync_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source              TEXT NOT NULL,     -- 'shipstation' | 'ups_tracking' | 'ups_quantum_view' | 'full'
  status              TEXT NOT NULL,     -- 'running' | 'success' | 'partial' | 'failed'
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at         TIMESTAMPTZ,
  duration_ms         INTEGER,
  records_seen        INTEGER NOT NULL DEFAULT 0,
  records_created     INTEGER NOT NULL DEFAULT 0,
  records_updated     INTEGER NOT NULL DEFAULT 0,
  events_recorded     INTEGER NOT NULL DEFAULT 0,
  error_count         INTEGER NOT NULL DEFAULT 0,
  error_message       TEXT,
  detail              JSONB,
  triggered_by        TEXT               -- 'cron' | 'manual' | 'cli'
);
CREATE INDEX sync_runs_source_started_idx ON sync_runs (source, started_at DESC);
CREATE INDEX sync_runs_status_idx ON sync_runs (status, started_at DESC);

-- Incremental cursors so a sync resumes instead of rescanning history.
CREATE TABLE sync_state (
  key           TEXT PRIMARY KEY,
  cursor_value  TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE email_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date     DATE NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'daily_audit',
  status          TEXT NOT NULL,       -- 'sent' | 'failed' | 'skipped'
  recipients      TEXT[] NOT NULL DEFAULT '{}',
  subject         TEXT,
  provider        TEXT,
  provider_message_id TEXT,
  error_message   TEXT,
  summary         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX email_deliveries_report_date_idx ON email_deliveries (report_date DESC, kind);

-- Application-level error log surfaced to admins in the UI.
CREATE TABLE error_log (
  id            BIGSERIAL PRIMARY KEY,
  scope         TEXT NOT NULL,     -- 'shipstation' | 'ups' | 'email' | 'sync' | 'auth'
  message       TEXT NOT NULL,
  detail        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX error_log_scope_created_idx ON error_log (scope, created_at DESC);

-- --- triggers ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shipments_touch_updated_at
  BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Safety net for the "do not overwrite historical timestamps" rule. Even a
-- buggy writer cannot erase or move the first-scan / label-creation evidence.
CREATE OR REPLACE FUNCTION protect_historical_timestamps() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.label_created_at IS NOT NULL
     AND NEW.label_created_at IS DISTINCT FROM OLD.label_created_at THEN
    NEW.label_created_at := OLD.label_created_at;
  END IF;

  IF OLD.first_carrier_scan_at IS NOT NULL
     AND NEW.first_carrier_scan_at IS DISTINCT FROM OLD.first_carrier_scan_at THEN
    -- Allow only a correction that moves the scan EARLIER (a late-arriving
    -- earlier scan from Quantum View). Never later, never to NULL.
    IF NEW.first_carrier_scan_at IS NULL
       OR NEW.first_carrier_scan_at > OLD.first_carrier_scan_at THEN
      NEW.first_carrier_scan_at := OLD.first_carrier_scan_at;
    END IF;
  END IF;

  IF OLD.first_seen_at IS NOT NULL THEN
    NEW.first_seen_at := OLD.first_seen_at;
  END IF;

  -- Once a physical scan has been observed it can never be un-observed.
  IF OLD.has_physical_scan = TRUE THEN
    NEW.has_physical_scan := TRUE;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shipments_protect_history
  BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION protect_historical_timestamps();

-- Record every normalized_status transition automatically.
CREATE OR REPLACE FUNCTION record_status_change() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.normalized_status IS DISTINCT FROM OLD.normalized_status THEN
    INSERT INTO shipment_status_history (shipment_id, from_status, to_status, reason)
    VALUES (NEW.id, OLD.normalized_status, NEW.normalized_status, NEW.latest_tracking_event);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shipments_record_status_change
  AFTER UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION record_status_change();
