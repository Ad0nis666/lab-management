ALTER TABLE stock_movements ADD COLUMN used_by TEXT REFERENCES users(id);
ALTER TABLE stock_movements ADD COLUMN purpose TEXT NOT NULL DEFAULT '';
ALTER TABLE stock_movements ADD COLUMN used_by_name TEXT NOT NULL DEFAULT '';
ALTER TABLE stock_movements ADD COLUMN recorded_by_name TEXT NOT NULL DEFAULT '';
ALTER TABLE stock_movements ADD COLUMN reagent_name TEXT NOT NULL DEFAULT '';
ALTER TABLE stock_movements ADD COLUMN bottle_code TEXT NOT NULL DEFAULT '';
ALTER TABLE stock_movements ADD COLUMN requested_amount TEXT;
ALTER TABLE stock_movements ADD COLUMN requested_unit TEXT;
ALTER TABLE stock_movements ADD COLUMN sequence INTEGER;
UPDATE stock_movements SET
  sequence = rowid,
  recorded_by_name = (SELECT display_name FROM users WHERE id = recorded_by),
  bottle_code = (SELECT bottle_code FROM reagent_bottles WHERE id = bottle_id),
  reagent_name = (SELECT r.name FROM reagents r JOIN reagent_bottles b ON b.reagent_id = r.id WHERE b.id = bottle_id);
CREATE UNIQUE INDEX movements_sequence ON stock_movements(sequence);
CREATE INDEX movements_usage ON stock_movements(type, used_on, used_by, sequence DESC);
CREATE TRIGGER movements_valid_sequence BEFORE INSERT ON stock_movements WHEN NEW.sequence IS NULL OR NEW.sequence <= 0 BEGIN SELECT RAISE(ABORT, 'Movement sequence is required'); END;
CREATE TRIGGER movements_immutable_update BEFORE UPDATE ON stock_movements BEGIN SELECT RAISE(ABORT, 'Stock history is immutable'); END;
CREATE TRIGGER movements_immutable_delete BEFORE DELETE ON stock_movements BEGIN SELECT RAISE(ABORT, 'Stock history is immutable'); END;
