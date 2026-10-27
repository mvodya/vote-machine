// Session rows already keep every visit, including revoked generations
export function up(pgm) {
  pgm.sql(`
    ALTER FUNCTION vm_event_state(uuid,bytea,boolean) RENAME TO vm_event_state_before_visits;
    CREATE FUNCTION vm_event_state(p_identity uuid,p_session bytea,p_admin boolean)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE state jsonb; visits bigint;
    BEGIN
      state := vm_event_state_before_visits(p_identity,p_session,p_admin);
      IF p_admin AND state->>'status'='200' THEN
        SELECT count(*) INTO visits FROM voting_sessions s JOIN voting_links l ON l.id=s.link_id
          WHERE l.room_id=(state->>'roomId')::uuid;
        state := jsonb_set(state,'{version}',to_jsonb(md5((state->>'version') || ':' || visits::text)));
      END IF;
      RETURN state;
    END;
    $$;
    REVOKE ALL ON FUNCTION vm_event_state(uuid,bytea,boolean),vm_event_state_before_visits(uuid,bytea,boolean) FROM PUBLIC;
  `);
}

// Restore the old signal version without deleting sessions or visits
export function down(pgm) {
  pgm.sql(`
    DROP FUNCTION vm_event_state(uuid,bytea,boolean);
    ALTER FUNCTION vm_event_state_before_visits(uuid,bytea,boolean) RENAME TO vm_event_state;
  `);
}
