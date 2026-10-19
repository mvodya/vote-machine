// Signal committed changes without sending private data to browsers
export function up(pgm) {
  pgm.sql(`
    CREATE FUNCTION vm_live_signal() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE record_data jsonb; owner uuid;
    BEGIN
      IF TG_OP='DELETE' THEN record_data:=to_jsonb(OLD); ELSE record_data:=to_jsonb(NEW); END IF;
      IF TG_TABLE_NAME='rooms' THEN owner:=(record_data->>'id')::uuid;
      ELSIF TG_TABLE_NAME='voting_sessions' THEN SELECT room_id INTO owner FROM voting_links WHERE id=(record_data->>'link_id')::uuid;
      ELSE owner:=(record_data->>'room_id')::uuid; END IF;
      IF owner IS NOT NULL THEN PERFORM pg_notify('live_changes',owner::text); END IF;
      RETURN NULL;
    END;
    $$;
    DO $$ DECLARE table_name text; BEGIN
      FOREACH table_name IN ARRAY ARRAY['rooms','questions','question_options','voting_links','voting_sessions','room_admin_sessions','voting_runs','ballots','ballot_choices'] LOOP
        EXECUTE format('CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION vm_live_signal()',table_name);
      END LOOP;
    END $$;
    CREATE FUNCTION vm_event_state(p_identity uuid,p_session bytea,p_admin boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE owner uuid; version text; current_session uuid;
    BEGIN
      IF p_admin THEN SELECT id INTO owner FROM vm_admin_room(p_identity,p_session);
      ELSE SELECT room_id INTO owner FROM vm_voting_access(p_identity,p_session); END IF;
      IF owner IS NULL THEN RETURN jsonb_build_object('status',401); END IF;
      SELECT s.id INTO current_session FROM voting_sessions s WHERE s.link_id=p_identity AND s.secret_hash=p_session;
      SELECT md5(jsonb_build_object(
        'room',(SELECT revision::text FROM rooms WHERE id=owner),
        'links',CASE WHEN p_admin THEN (SELECT jsonb_agg(jsonb_build_array(id,revision::text) ORDER BY ordinal) FROM voting_links WHERE room_id=owner) ELSE (SELECT to_jsonb(revision::text) FROM voting_links WHERE id=p_identity) END,
        'runs',(SELECT jsonb_agg(r.id ORDER BY r.created_at,r.id) FROM voting_runs r WHERE r.session_id=current_session),
        'questions',(SELECT jsonb_agg(jsonb_build_array(q.id,q.revision::text,vm_effective_state(q.id),
          (SELECT jsonb_agg(jsonb_build_array(b.id,b.revision::text) ORDER BY b.id) FROM ballots b WHERE b.question_id=q.id AND (
            (NOT p_admin AND b.link_id=p_identity AND (b.run_id IS NULL OR EXISTS(SELECT 1 FROM voting_runs r WHERE r.id=b.run_id AND r.session_id=current_session))) OR
            vm_results_allowed(q.id,p_identity,NULL,p_admin) OR (NOT p_admin AND EXISTS(SELECT 1 FROM voting_runs own WHERE own.session_id=current_session AND vm_results_allowed(q.id,p_identity,own.id,false)))
          ))
        ) ORDER BY q.ordinal) FROM questions q WHERE q.room_id=owner AND (p_admin OR (q.first_opened_at IS NOT NULL AND q.state<>'draft' AND (
          vm_effective_state(q.id)='open' OR q.share_results OR EXISTS(SELECT 1 FROM ballots b WHERE b.question_id=q.id AND b.link_id=p_identity AND (b.run_id IS NULL OR EXISTS(SELECT 1 FROM voting_runs r WHERE r.id=b.run_id AND r.session_id=current_session)))
        ))))
      )::text) INTO version;
      RETURN jsonb_build_object('status',200,'roomId',owner,'version',version);
    END;
    $$;
    REVOKE ALL ON FUNCTION vm_live_signal(),vm_event_state(uuid,bytea,boolean) FROM PUBLIC;
  `);
}
// Remove live delivery without changing application data
export function down(pgm) {
  pgm.sql(`
    DO $$ DECLARE table_name text; BEGIN
      FOREACH table_name IN ARRAY ARRAY['rooms','questions','question_options','voting_links','voting_sessions','room_admin_sessions','voting_runs','ballots','ballot_choices'] LOOP
        EXECUTE format('DROP TRIGGER live_signal ON %I',table_name);
      END LOOP;
    END $$;
    DROP FUNCTION vm_live_signal(),vm_event_state(uuid,bytea,boolean);
  `);
}
