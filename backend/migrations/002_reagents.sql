CREATE TABLE reagents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  cas TEXT NOT NULL DEFAULT '',
  grade TEXT NOT NULL DEFAULT '',
  supplier TEXT NOT NULL DEFAULT '',
  catalog_no TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  hazard_tags TEXT NOT NULL DEFAULT '',
  stock_unit TEXT NOT NULL CHECK(stock_unit IN ('mL','L','g','kg')),
  low_stock_threshold TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX reagents_updated ON reagents(updated_at DESC, id DESC);
