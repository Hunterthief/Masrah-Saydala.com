-- Booker name: authoritative on the reservation, copied onto each ticket row
-- so the organizer can review names directly in reservation_tickets.
ALTER TABLE reservations ADD COLUMN customer_name TEXT;
ALTER TABLE reservation_tickets ADD COLUMN customer_name TEXT;
