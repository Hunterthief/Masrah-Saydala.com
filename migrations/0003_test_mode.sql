-- Safe test switch: opens booking without real payment/contact details.
-- '1' = test mode (visible hazard banner, no real payment instructions).
-- '0' = live (requires INSTAPAY_ADDRESS + WHATSAPP_NUMBER).
INSERT OR REPLACE INTO settings (key, value) VALUES ('test_mode', '0');
