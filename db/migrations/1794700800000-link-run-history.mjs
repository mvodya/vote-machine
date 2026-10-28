// Make old reusable runs an explicit per-link choice
export function up(pgm) {
  pgm.sql(`
    ALTER TABLE voting_links ADD COLUMN allow_run_history boolean NOT NULL DEFAULT false CHECK (mode='reusable' OR NOT allow_run_history);
    ALTER FUNCTION vm_edit_voting_link(uuid,bytea,uuid,text,text,bytea,bytea) RENAME TO vm_edit_voting_link_before_history;
    CREATE FUNCTION vm_edit_voting_link(p_room uuid,p_admin bytea,p_link uuid,p_action text,p_name text,p_hash bytea,p_cipher bytea,p_history boolean DEFAULT NULL) RETURNS SETOF voting_links LANGUAGE plpgsql AS $$
    DECLARE saved voting_links;
    BEGIN
      PERFORM 1 FROM rooms WHERE id=p_room FOR UPDATE;
      IF NOT EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) THEN RETURN; END IF;
      SELECT * INTO saved FROM vm_edit_voting_link_before_history(p_room,p_admin,p_link,p_action,p_name,p_hash,p_cipher);
      IF saved.id IS NULL THEN RETURN; END IF;
      IF p_action='rename' AND saved.mode='reusable' AND p_history IS NOT NULL THEN
        UPDATE voting_links SET allow_run_history=p_history WHERE id=saved.id AND allow_run_history IS DISTINCT FROM p_history RETURNING * INTO saved;
        IF saved.id IS NULL THEN SELECT * INTO saved FROM voting_links WHERE id=p_link; END IF;
      END IF;
      RETURN NEXT saved;
    END $$;
    CREATE FUNCTION vm_run_readable(p_link uuid,p_session bytea,p_run uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS(SELECT 1 FROM voting_links l JOIN voting_sessions s ON s.link_id=l.id JOIN voting_runs r ON r.session_id=s.id WHERE l.id=p_link AND s.secret_hash=p_session AND r.id=p_run AND (l.allow_run_history OR r.id=(SELECT id FROM voting_runs WHERE session_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1)));
    $$;
    CREATE FUNCTION vm_run_history_check(p_link uuid,p_session bytea,p_run uuid,p_write boolean) RETURNS integer LANGUAGE plpgsql AS $$
    DECLARE owner uuid; kind text;
    BEGIN
      SELECT room_id INTO owner FROM voting_links WHERE id=p_link;
      IF owner IS NULL THEN RETURN 401; END IF;
      IF p_write THEN PERFORM 1 FROM rooms WHERE id=owner FOR UPDATE;
      ELSE PERFORM 1 FROM rooms WHERE id=owner FOR SHARE; END IF;
      SELECT mode INTO kind FROM vm_voting_access(p_link,p_session);
      IF NOT FOUND THEN RETURN 401; END IF;
      IF kind='reusable' AND p_run IS NOT NULL AND NOT vm_run_readable(p_link,p_session,p_run) THEN RETURN 404; END IF;
      RETURN 200;
    END $$;
    ALTER FUNCTION vm_participant_journey(uuid,bytea,jsonb) RENAME TO vm_participant_journey_before_history;
    CREATE FUNCTION vm_participant_journey(p_link uuid,p_session bytea,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE status integer; result jsonb;
    BEGIN
      status:=vm_run_history_check(p_link,p_session,(p_data->>'run')::uuid,true);
      IF status<>200 THEN RETURN jsonb_build_object('status',status,'error','run'); END IF;
      result:=vm_participant_journey_before_history(p_link,p_session,p_data);
      IF result->>'status'='200' AND EXISTS(SELECT 1 FROM voting_links WHERE id=p_link AND mode='reusable' AND NOT allow_run_history) THEN result:=jsonb_set(result,'{runs}',CASE WHEN result->'run' IS NULL OR result->'run'='null'::jsonb THEN '[]'::jsonb ELSE jsonb_build_array(result->'run') END); END IF;
      RETURN result;
    EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('status',400); END $$;
    ALTER FUNCTION vm_current_answer(uuid,bytea,uuid,uuid) RENAME TO vm_current_answer_before_history;
    CREATE FUNCTION vm_current_answer(p_link uuid,p_session bytea,p_question uuid,p_run uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE status integer; BEGIN
      status:=vm_run_history_check(p_link,p_session,p_run,false);
      IF status<>200 THEN RETURN jsonb_build_object('status',status,'error','run'); END IF;
      RETURN vm_current_answer_before_history(p_link,p_session,p_question,p_run);
    END $$;
    ALTER FUNCTION vm_cast_ballot(uuid,uuid,bytea,boolean,uuid,jsonb) RENAME TO vm_cast_ballot_before_history;
    CREATE FUNCTION vm_cast_ballot(p_room uuid,p_identity uuid,p_session bytea,p_admin boolean,p_question uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE status integer; BEGIN
      IF NOT p_admin THEN
        status:=vm_run_history_check(p_identity,p_session,(p_data->>'runId')::uuid,true);
        IF status<>200 THEN RETURN jsonb_build_object('status',status,'error','run'); END IF;
      END IF;
      RETURN vm_cast_ballot_before_history(p_room,p_identity,p_session,p_admin,p_question,p_data);
    EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('status',400); END $$;
    ALTER FUNCTION vm_begin_run(uuid,bytea,uuid) RENAME TO vm_begin_run_before_history;
    CREATE FUNCTION vm_begin_run(p_link uuid,p_session bytea,p_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE status integer; result jsonb; BEGIN
      status:=vm_run_history_check(p_link,p_session,NULL,true);
      IF status<>200 THEN RETURN jsonb_build_object('status',status); END IF;
      result:=vm_begin_run_before_history(p_link,p_session,p_id);
      IF result->>'status'='200' AND NOT vm_run_readable(p_link,p_session,(result#>>'{run,id}')::uuid) THEN RETURN jsonb_build_object('status',404,'error','run'); END IF;
      RETURN result;
    END $$;
    ALTER FUNCTION vm_results(uuid,bytea,boolean,uuid,jsonb) RENAME TO vm_results_before_history;
    CREATE FUNCTION vm_results(p_identity uuid,p_session bytea,p_admin boolean,p_question uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE status integer; BEGIN
      IF NOT p_admin THEN
        status:=vm_run_history_check(p_identity,p_session,(p_data->>'run')::uuid,false);
        IF status<>200 THEN RETURN jsonb_build_object('status',status,'error','run'); END IF;
      END IF;
      RETURN vm_results_before_history(p_identity,p_session,p_admin,p_question,p_data);
    EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('status',400); END $$;
    ALTER FUNCTION vm_room_report(uuid,bytea,boolean,uuid,boolean) RENAME TO vm_room_report_before_history;
    CREATE FUNCTION vm_room_report(p_identity uuid,p_session bytea,p_admin boolean,p_run uuid,p_export boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE status integer; BEGIN
      IF NOT p_admin THEN
        status:=vm_run_history_check(p_identity,p_session,p_run,false);
        IF status<>200 THEN RETURN jsonb_build_object('status',status,'error','run'); END IF;
      END IF;
      RETURN vm_room_report_before_history(p_identity,p_session,p_admin,p_run,p_export);
    END $$;
    ALTER FUNCTION vm_participant_asset(uuid,bytea,uuid) RENAME TO vm_participant_asset_before_history;
    DO $$ DECLARE definition text; BEGIN
      definition:=pg_get_functiondef('vm_participant_asset_before_history(uuid,bytea,uuid)'::regprocedure);
      definition:=replace(definition,'FUNCTION public.vm_participant_asset_before_history(','FUNCTION public.vm_participant_asset(');
      definition:=replace(definition,'b.link_id = p_link','b.link_id = p_link AND (b.run_id IS NULL OR vm_run_readable(p_link,p_session,b.run_id))');
      EXECUTE definition;
    END $$;
    REVOKE ALL ON FUNCTION vm_run_readable(uuid,bytea,uuid),vm_run_history_check(uuid,bytea,uuid,boolean),vm_edit_voting_link(uuid,bytea,uuid,text,text,bytea,bytea,boolean),vm_edit_voting_link_before_history(uuid,bytea,uuid,text,text,bytea,bytea),vm_participant_journey_before_history(uuid,bytea,jsonb),vm_participant_journey(uuid,bytea,jsonb),vm_current_answer_before_history(uuid,bytea,uuid,uuid),vm_current_answer(uuid,bytea,uuid,uuid),vm_cast_ballot_before_history(uuid,uuid,bytea,boolean,uuid,jsonb),vm_cast_ballot(uuid,uuid,bytea,boolean,uuid,jsonb),vm_begin_run_before_history(uuid,bytea,uuid),vm_begin_run(uuid,bytea,uuid),vm_results_before_history(uuid,bytea,boolean,uuid,jsonb),vm_results(uuid,bytea,boolean,uuid,jsonb),vm_room_report_before_history(uuid,bytea,boolean,uuid,boolean),vm_room_report(uuid,bytea,boolean,uuid,boolean),vm_participant_asset_before_history(uuid,bytea,uuid),vm_participant_asset(uuid,bytea,uuid) FROM PUBLIC;
  `);
}

// Restore the earlier history rules without deleting runs or answers
export function down(pgm) {
  pgm.sql(`
    DROP FUNCTION vm_edit_voting_link(uuid,bytea,uuid,text,text,bytea,bytea,boolean),vm_participant_journey(uuid,bytea,jsonb),vm_current_answer(uuid,bytea,uuid,uuid),vm_cast_ballot(uuid,uuid,bytea,boolean,uuid,jsonb),vm_begin_run(uuid,bytea,uuid),vm_results(uuid,bytea,boolean,uuid,jsonb),vm_room_report(uuid,bytea,boolean,uuid,boolean),vm_participant_asset(uuid,bytea,uuid);
    ALTER FUNCTION vm_edit_voting_link_before_history(uuid,bytea,uuid,text,text,bytea,bytea) RENAME TO vm_edit_voting_link;
    ALTER FUNCTION vm_participant_journey_before_history(uuid,bytea,jsonb) RENAME TO vm_participant_journey;
    ALTER FUNCTION vm_current_answer_before_history(uuid,bytea,uuid,uuid) RENAME TO vm_current_answer;
    ALTER FUNCTION vm_cast_ballot_before_history(uuid,uuid,bytea,boolean,uuid,jsonb) RENAME TO vm_cast_ballot;
    ALTER FUNCTION vm_begin_run_before_history(uuid,bytea,uuid) RENAME TO vm_begin_run;
    ALTER FUNCTION vm_results_before_history(uuid,bytea,boolean,uuid,jsonb) RENAME TO vm_results;
    ALTER FUNCTION vm_room_report_before_history(uuid,bytea,boolean,uuid,boolean) RENAME TO vm_room_report;
    ALTER FUNCTION vm_participant_asset_before_history(uuid,bytea,uuid) RENAME TO vm_participant_asset;
    DROP FUNCTION vm_run_history_check(uuid,bytea,uuid,boolean),vm_run_readable(uuid,bytea,uuid);
    ALTER TABLE voting_links DROP COLUMN allow_run_history;
  `);
}
