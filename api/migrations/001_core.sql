CREATE TABLE users (
  id            INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);

CREATE TABLE events (
  id        INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name      TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE holds (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      INT NOT NULL REFERENCES users(id),
  event_id     INT NOT NULL REFERENCES events(id),
  seat_ids     INT[] NOT NULL,
  amount_paise INT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'released', 'converted')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT holds_seat_count CHECK (cardinality(seat_ids) BETWEEN 1 AND 6),
  CONSTRAINT holds_amount_positive CHECK (amount_paise > 0)
);

CREATE TABLE seats (
  id          INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id    INT NOT NULL REFERENCES events(id),
  section     TEXT NOT NULL,              -- 'Lateral Este', 'Fondo Sur'
  row_label   TEXT NOT NULL,
  seat_no     INT NOT NULL,
  price_paise INT NOT NULL CHECK (price_paise > 0),
  status      TEXT NOT NULL DEFAULT 'available'
              CHECK (status IN ('available', 'held', 'sold')),
  hold_id     UUID REFERENCES holds(id),
  held_until  TIMESTAMPTZ,
  UNIQUE (event_id, section, row_label, seat_no),
  -- A held seat has both hold columns set, and any other seat has neither.
  CONSTRAINT seats_hold_state CHECK (
    (status = 'held') = (hold_id IS NOT NULL)
    AND (status = 'held') = (held_until IS NOT NULL)
  )
);

CREATE TABLE orders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hold_id      UUID NOT NULL UNIQUE REFERENCES holds(id),   -- one order per hold
  user_id      INT NOT NULL REFERENCES users(id),
  amount_paise INT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'paying', 'paid', 'refunded')),
  payment_key  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT orders_amount_positive CHECK (amount_paise > 0),
  -- A retry compares its key with this one, so a payment in progress must have it.
  CONSTRAINT orders_paying_has_key CHECK (status <> 'paying' OR payment_key IS NOT NULL)
);

CREATE TABLE tickets (
  id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id),
  seat_id  INT NOT NULL REFERENCES seats(id),
  status   TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'cancelled'))
);

-- Rule 1, enforced by the database itself: even code that skips the seat lock can't double-sell.
CREATE UNIQUE INDEX one_valid_ticket_per_seat
  ON tickets (seat_id) WHERE status = 'valid';

CREATE TABLE idempotency_keys (
  user_id       INT NOT NULL REFERENCES users(id),
  idem_key      TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'in_progress'
                CHECK (status IN ('in_progress', 'done')),
  response_code INT,
  response_body JSONB,
  locked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idem_key),
  -- A finished key is replayed to the client, so it must have something to replay.
  CONSTRAINT idempotency_done_has_response CHECK (
    status <> 'done' OR (response_code IS NOT NULL AND response_body IS NOT NULL)
  )
);

CREATE INDEX ON seats (event_id);
CREATE INDEX ON seats (hold_id) WHERE hold_id IS NOT NULL;
CREATE INDEX ON seats (held_until) WHERE status = 'held';
CREATE INDEX ON tickets (order_id);
