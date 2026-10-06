CREATE TABLE instruments (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('robot','balance','pump','other')),
  model TEXT NOT NULL,
  location TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('unknown','normal','fault','calibration','maintenance')),
  calibration_on TEXT NOT NULL,
  notes TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE samples (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  project TEXT NOT NULL,
  quantity TEXT NOT NULL,
  unit TEXT NOT NULL,
  location TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('stored','in_use','exhausted','discarded')),
  notes TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX instruments_updated ON instruments(updated_at DESC, id DESC);
CREATE INDEX samples_updated ON samples(updated_at DESC, id DESC);

-- Preserve bottles and immutable movement references while allowing unknown expiry.
CREATE TABLE reagent_bottles_new (
  id TEXT PRIMARY KEY,
  reagent_id TEXT NOT NULL REFERENCES reagents(id),
  bottle_code TEXT NOT NULL UNIQUE,
  batch_no TEXT NOT NULL,
  initial_minor INTEGER NOT NULL CHECK(initial_minor > 0 AND initial_minor <= 99999999999),
  remaining_minor INTEGER NOT NULL CHECK(remaining_minor >= 0 AND remaining_minor <= initial_minor),
  unit TEXT NOT NULL CHECK(unit IN ('mL','L','g','kg')),
  location TEXT NOT NULL,
  received_on TEXT NOT NULL,
  expires_on TEXT CHECK(expires_on IS NULL OR expires_on >= received_on),
  lifecycle_status TEXT NOT NULL DEFAULT 'in_stock' CHECK(lifecycle_status IN ('in_stock','depleted','discarded')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO reagent_bottles_new SELECT * FROM reagent_bottles;
DROP TABLE reagent_bottles;
ALTER TABLE reagent_bottles_new RENAME TO reagent_bottles;
CREATE INDEX bottles_reagent ON reagent_bottles(reagent_id, created_at DESC, id DESC);
