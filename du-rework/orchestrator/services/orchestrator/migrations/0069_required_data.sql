-- Required production data has its own version history; no development fixtures.
CREATE TABLE IF NOT EXISTS required_data_bootstrap (
  name text PRIMARY KEY,
  version integer NOT NULL CHECK (version > 0),
  applied_at timestamptz NOT NULL DEFAULT now()
);
