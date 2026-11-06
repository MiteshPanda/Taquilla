-- The sweeper deletes keys older than 24 hours on every run (FR-EXP-5), so it finds them by age.
CREATE INDEX idempotency_keys_locked_at ON idempotency_keys (locked_at);
