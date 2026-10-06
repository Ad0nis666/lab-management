CREATE TABLE reminder_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  low_enabled INTEGER NOT NULL DEFAULT 1 CHECK (low_enabled IN (0,1)),
  expiry_enabled INTEGER NOT NULL DEFAULT 1 CHECK (expiry_enabled IN (0,1)),
  expiry_days INTEGER NOT NULL DEFAULT 60 CHECK (expiry_days BETWEEN 0 AND 365),
  calibration_enabled INTEGER NOT NULL DEFAULT 1 CHECK (calibration_enabled IN (0,1)),
  calibration_days INTEGER NOT NULL DEFAULT 30 CHECK (calibration_days BETWEEN 0 AND 365),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT
);
INSERT INTO reminder_settings (id) VALUES (1);
