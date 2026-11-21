-- Masrah Saydala — initial schema (Cloudflare D1 / SQLite). Money: integer piasters.
-- created_at/expires_at: UNIX epoch seconds (UTC). doors_open/starts_at: Africa/Cairo "HH:MM".
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings (key, value) VALUES ('max_event_capacity', '3000');

CREATE TABLE performances (
  id TEXT PRIMARY KEY CHECK (id IN ('A','B')),
  name TEXT NOT NULL, event_date TEXT NOT NULL, doors_open TEXT NOT NULL, starts_at TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 0 CHECK (capacity >= 0),
  price_piasters INTEGER NOT NULL DEFAULT 0 CHECK (price_piasters >= 0),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1))
);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  performance_id TEXT NOT NULL REFERENCES performances(id),
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  total_piasters INTEGER NOT NULL CHECK (total_piasters >= 0),
  status TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment','expired')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX idx_reservations_active ON reservations (performance_id, status, expires_at);

CREATE TABLE sequences (
  performance_id TEXT PRIMARY KEY REFERENCES performances(id),
  next_serial INTEGER NOT NULL DEFAULT 1 CHECK (next_serial >= 1)
);

CREATE TABLE reservation_tickets (
  id INTEGER PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  performance_id TEXT NOT NULL REFERENCES performances(id),
  serial_number INTEGER NOT NULL CHECK (serial_number >= 1),
  ticket_number TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  UNIQUE (performance_id, serial_number)
);
CREATE INDEX idx_tickets_reservation ON reservation_tickets (reservation_id);

CREATE TRIGGER trg_perf_capacity_insert BEFORE INSERT ON performances
WHEN (SELECT COALESCE(SUM(capacity),0) FROM performances) + NEW.capacity
     > CAST((SELECT value FROM settings WHERE key='max_event_capacity') AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'Combined performance capacity exceeds max_event_capacity (1000)'); END;

CREATE TRIGGER trg_perf_capacity_update BEFORE UPDATE OF capacity ON performances
WHEN (SELECT COALESCE(SUM(capacity),0) FROM performances WHERE id <> NEW.id) + NEW.capacity
     > CAST((SELECT value FROM settings WHERE key='max_event_capacity') AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'Combined performance capacity exceeds max_event_capacity (1000)'); END;
