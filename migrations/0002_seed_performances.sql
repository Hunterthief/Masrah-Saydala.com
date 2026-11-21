-- Capacities/prices UNKNOWN: seeded 0 + disabled until the organizer configures them.
INSERT INTO performances (id,name,event_date,doors_open,starts_at,capacity,price_piasters,enabled)
VALUES ('A','العرض الأول','2026-12-03','16:30','17:00',0,0,0),
       ('B','العرض الثاني','2026-12-03','18:30','19:00',0,0,0);
INSERT INTO sequences (performance_id,next_serial) VALUES ('A',1),('B',1);
