-- Only for POST /dev/buy-naive, and never created in production.
-- No unique index and no foreign keys, on purpose: this table must be able to record one seat sold
-- many times, so the race shows up as extra rows instead of being stopped by an error.
CREATE TABLE naive_tickets (
  id      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seat_id INT NOT NULL,
  user_id INT NOT NULL
);
