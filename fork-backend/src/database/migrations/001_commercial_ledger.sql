CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  legacy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS app_devices_user_id_idx ON app_devices(user_id);

CREATE TABLE IF NOT EXISTS app_sessions (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES app_devices(id) ON DELETE SET NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS app_sessions_user_id_idx ON app_sessions(user_id);

CREATE TABLE IF NOT EXISTS orders_v2 (
  id TEXT PRIMARY KEY,
  out_trade_no TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES app_users(id),
  product_id TEXT NOT NULL,
  product_snapshot JSONB NOT NULL,
  money_cents INTEGER NOT NULL CHECK (money_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL CHECK (status IN ('pending_payment', 'paid', 'fulfilling', 'fulfilled', 'cancelled', 'expired', 'payment_failed', 'refund_requested', 'refunded', 'legacy_review')),
  client_idempotency_key TEXT,
  pay_type TEXT,
  pay_url TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_v2_user_idempotency_idx ON orders_v2(user_id, client_idempotency_key) WHERE client_idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_v2_status_expires_idx ON orders_v2(status, expires_at);

CREATE TABLE IF NOT EXISTS order_state_events (
  id UUID PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders_v2(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS order_state_events_order_idx ON order_state_events(order_id, created_at);

CREATE TABLE IF NOT EXISTS payment_events (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_key TEXT NOT NULL,
  order_id TEXT REFERENCES orders_v2(id),
  provider_trade_no TEXT,
  status TEXT NOT NULL,
  payload_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, provider_event_key)
);

CREATE TABLE IF NOT EXISTS coupons_v2 (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  max_uses INTEGER NOT NULL DEFAULT 0 CHECK (max_uses >= 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coupon_reservations (
  id UUID PRIMARY KEY,
  coupon_id TEXT NOT NULL REFERENCES coupons_v2(id),
  user_id TEXT NOT NULL REFERENCES app_users(id),
  order_id TEXT NOT NULL REFERENCES orders_v2(id) ON DELETE CASCADE,
  pricing_snapshot JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released')),
  reserved_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(order_id)
);
CREATE INDEX IF NOT EXISTS coupon_reservations_expiry_idx ON coupon_reservations(status, reserved_until);

CREATE TABLE IF NOT EXISTS entitlements (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id),
  origin_type TEXT NOT NULL CHECK (origin_type IN ('order', 'coupon', 'reward', 'manual_adjustment', 'legacy_migration')),
  origin_id TEXT NOT NULL,
  product_id TEXT,
  source_id TEXT,
  pool TEXT NOT NULL CHECK (pool IN ('free', 'paid')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  product_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(origin_type, origin_id)
);
CREATE INDEX IF NOT EXISTS entitlements_user_active_idx ON entitlements(user_id, status, expires_at);

CREATE TABLE IF NOT EXISTS traffic_grants (
  id UUID PRIMARY KEY,
  entitlement_id UUID NOT NULL REFERENCES entitlements(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES app_users(id),
  pool TEXT NOT NULL CHECK (pool IN ('free', 'paid')),
  quota_mode TEXT NOT NULL CHECK (quota_mode IN ('limited', 'unlimited', 'none')),
  granted_bytes BIGINT NOT NULL DEFAULT 0 CHECK (granted_bytes >= 0),
  remaining_bytes BIGINT,
  period_key TEXT,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('active', 'exhausted', 'expired', 'revoked')),
  consumption_priority INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((quota_mode = 'limited' AND remaining_bytes IS NOT NULL) OR (quota_mode <> 'limited' AND remaining_bytes IS NULL))
);
CREATE INDEX IF NOT EXISTS traffic_grants_user_pool_idx ON traffic_grants(user_id, pool, status, expires_at, consumption_priority);

CREATE TABLE IF NOT EXISTS usage_reports (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id),
  device_id TEXT REFERENCES app_devices(id) ON DELETE SET NULL,
  client_report_id UUID NOT NULL,
  sequence_no BIGINT NOT NULL CHECK (sequence_no >= 0),
  subscription_revision TEXT,
  reported_pool TEXT CHECK (reported_pool IN ('free', 'paid')),
  reported_source_id TEXT,
  delta_bytes BIGINT NOT NULL CHECK (delta_bytes >= 0),
  accepted_bytes BIGINT NOT NULL DEFAULT 0 CHECK (accepted_bytes >= 0),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'duplicate', 'rejected', 'review')),
  occurred_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, device_id, client_report_id),
  UNIQUE(user_id, device_id, sequence_no)
);

CREATE TABLE IF NOT EXISTS traffic_consumptions (
  id UUID PRIMARY KEY,
  usage_report_id UUID NOT NULL REFERENCES usage_reports(id) ON DELETE CASCADE,
  traffic_grant_id UUID NOT NULL REFERENCES traffic_grants(id),
  bytes BIGINT NOT NULL CHECK (bytes > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(usage_report_id, traffic_grant_id)
);

CREATE TABLE IF NOT EXISTS traffic_ledger (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id),
  traffic_grant_id UUID REFERENCES traffic_grants(id),
  entitlement_id UUID REFERENCES entitlements(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('grant', 'consume', 'expire', 'revoke', 'manual_adjustment', 'legacy_migration')),
  bytes BIGINT NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS traffic_ledger_user_idx ON traffic_ledger(user_id, created_at);

CREATE TABLE IF NOT EXISTS proxy_preferences (
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  disabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, node_key)
);

CREATE TABLE IF NOT EXISTS email_tokens (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password', 'admin_reset')),
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_tokens_user_purpose_idx ON email_tokens(user_id, purpose, expires_at);
