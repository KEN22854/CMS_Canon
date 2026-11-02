-- Partition upkeep must work from the worker role (canon_system), which does not own the
-- partitioned tables. Both functions run with the owner's rights, take no free-form SQL, and pin
-- search_path so a caller cannot shadow objects.

ALTER FUNCTION canon_ensure_monthly_partitions(regclass, int) SECURITY DEFINER SET search_path = public, partitions, pg_temp;

-- Raw analytics retention: drops whole monthly partitions that end on or before `before`.
-- Restricted to analytics_events: the audit trail and its hash chain are never dropped this way.
CREATE OR REPLACE FUNCTION canon_drop_analytics_partitions_before(before date)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, partitions, pg_temp
AS $$
DECLARE
  r record;
  dropped int := 0;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE i.inhparent = '"analytics_events"'::regclass
      AND ns.nspname = 'partitions'
      AND c.relname ~ '^analytics_events_[0-9]{4}_[0-9]{2}$'
  LOOP
    IF (to_date(right(r.relname, 7), 'YYYY_MM') + interval '1 month')::date <= before THEN
      EXECUTE format('DROP TABLE partitions.%I', r.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END;
$$;

REVOKE ALL ON FUNCTION canon_drop_analytics_partitions_before(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION canon_drop_analytics_partitions_before(date) TO canon_system;
