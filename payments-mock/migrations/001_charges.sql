-- One row per idempotency key (DR-9). A repeated key finds this row and gets the same charge back.
CREATE TABLE charges (
  key          TEXT PRIMARY KEY,
  id           UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  order_id     UUID NOT NULL,
  amount_paise INT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('succeeded', 'declined', 'refunded')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  refunded_at  TIMESTAMPTZ,
  CONSTRAINT charges_key_length CHECK (char_length(key) BETWEEN 1 AND 255),
  CONSTRAINT charges_amount_positive CHECK (amount_paise > 0),
  -- A charge has a refund time if and only if it was refunded.
  CONSTRAINT charges_refund_state CHECK ((status = 'refunded') = (refunded_at IS NOT NULL))
);

-- Deliberately not unique (FR-MOCK-3): two keys for one order make two charges, so only
-- Taquilla's own logic can stop a double charge. The audit looks charges up by order (INV-2).
CREATE INDEX charges_order_id ON charges (order_id);
