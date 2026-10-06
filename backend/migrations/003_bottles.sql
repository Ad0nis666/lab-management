CREATE TABLE reagent_bottles (
  id TEXT PRIMARY KEY,
  reagent_id TEXT NOT NULL REFERENCES reagents(id),
  bottle_code TEXT NOT NULL UNIQUE,
  batch_no TEXT NOT NULL,
  initial_minor INTEGER NOT NULL CHECK(initial_minor > 0 AND initial_minor <= 99999999999),
  remaining_minor INTEGER NOT NULL CHECK(remaining_minor >= 0 AND remaining_minor <= initial_minor),
  unit TEXT NOT NULL CHECK(unit IN ('mL','L','g','kg')),
  location TEXT NOT NULL,
  received_on TEXT NOT NULL,
  expires_on TEXT NOT NULL CHECK(expires_on >= received_on),
  lifecycle_status TEXT NOT NULL DEFAULT 'in_stock' CHECK(lifecycle_status IN ('in_stock','depleted','discarded')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX bottles_reagent ON reagent_bottles(reagent_id, created_at DESC, id DESC);
CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  bottle_id TEXT NOT NULL REFERENCES reagent_bottles(id),
  type TEXT NOT NULL CHECK(type IN ('receipt','consumption','adjustment','disposal','reversal')),
  quantity_delta_minor INTEGER NOT NULL,
  before_minor INTEGER NOT NULL CHECK(before_minor >= 0),
  after_minor INTEGER NOT NULL CHECK(after_minor >= 0),
  unit TEXT NOT NULL,
  used_on TEXT NOT NULL,
  recorded_by TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  request_payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(recorded_by, idempotency_key)
);
CREATE INDEX movements_bottle ON stock_movements(bottle_id, created_at DESC, id DESC);
