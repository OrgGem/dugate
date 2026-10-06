-- Execution timestamps are lifecycle facts, never file/cache maintenance times.
ALTER TABLE operations ADD COLUMN execution_times_recorded boolean NOT NULL DEFAULT false;
ALTER TABLE operations ADD COLUMN started_at timestamptz;
ALTER TABLE operations ADD COLUMN completed_at timestamptz;
ALTER TABLE operations ADD COLUMN retry_of uuid REFERENCES operations(id);
CREATE INDEX operations_retry_of ON operations(retry_of) WHERE retry_of IS NOT NULL;

-- Historical updated_at may already include maintenance. Do not backfill a
-- fabricated completion time. Historical timestamps remain unknown (NULL).
CREATE FUNCTION preserve_operation_execution_times() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.execution_times_recorded := OLD.execution_times_recorded;
    NEW.created_at := OLD.created_at;
    NEW.started_at := OLD.started_at;
    NEW.completed_at := OLD.completed_at;
    IF OLD.state IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT') THEN
      IF NEW.state IS DISTINCT FROM OLD.state THEN
        RAISE EXCEPTION 'terminal operations are immutable; retry creates a new operation';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.execution_times_recorded AND NEW.state = 'RUNNING'
       AND NEW.state IS DISTINCT FROM OLD.state AND NEW.started_at IS NULL THEN
      NEW.started_at := statement_timestamp();
    END IF;
    IF NEW.state IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT') THEN
      NEW.completed_at := statement_timestamp();
    END IF;
  ELSE
    NEW.execution_times_recorded := true;
    NEW.started_at := CASE WHEN NEW.state = 'RUNNING' THEN statement_timestamp() ELSE NULL END;
    NEW.completed_at := CASE WHEN NEW.state IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT') THEN statement_timestamp() ELSE NULL END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER operation_execution_times BEFORE INSERT OR UPDATE ON operations
FOR EACH ROW EXECUTE FUNCTION preserve_operation_execution_times();
