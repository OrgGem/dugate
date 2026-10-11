-- AWEB-11C: persist worker identity and real heartbeat observations.
CREATE TABLE IF NOT EXISTS worker_instances (
  business_id      text NOT NULL,
  instance_id      text NOT NULL,
  business_version text NOT NULL,
  state            text NOT NULL DEFAULT 'OFFLINE'
                     CHECK (state IN ('ONLINE','DRAINING','OFFLINE')),
  capacity         integer NOT NULL DEFAULT 1 CHECK (capacity >= 0),
  active_leases    integer NOT NULL DEFAULT 0 CHECK (active_leases >= 0),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  observed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, instance_id)
);

CREATE INDEX IF NOT EXISTS worker_instances_business
  ON worker_instances (business_id, state);

CREATE INDEX IF NOT EXISTS worker_instances_last_seen
  ON worker_instances (last_seen_at DESC, business_id, instance_id);
