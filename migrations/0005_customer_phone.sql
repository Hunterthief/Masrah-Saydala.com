-- Booker phone: the payment-matching key for manual InstaPay verification.
-- Stored normalized (digits only, Egyptian local numbers canonicalized to 20…).
ALTER TABLE reservations ADD COLUMN customer_phone TEXT;
ALTER TABLE reservation_tickets ADD COLUMN customer_phone TEXT;
