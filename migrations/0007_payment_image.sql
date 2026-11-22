-- Store the (client-compressed) InstaPay screenshot on the booking row.
-- Nullable so legacy rows / test resets stay valid.
ALTER TABLE reservations ADD COLUMN payment_image TEXT;

-- Review page sorts/filters by status a lot.
CREATE INDEX IF NOT EXISTS idx_reservations_status_created
  ON reservations(status, created_at DESC);
