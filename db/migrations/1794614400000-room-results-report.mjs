// Keep room reports and export privacy in one database snapshot
export function up(pgm) {
  pgm.sql(`
    ALTER TABLE rooms ADD COLUMN show_all_results boolean NOT NULL DEFAULT false;
    CREATE FUNCTION vm_room_report(p_identity uuid,p_session bytea,p_admin boolean,p_run uuid,p_export boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE owner uuid; selected_run uuid; result jsonb; shared boolean;
    BEGIN
      IF p_admin THEN SELECT id INTO owner FROM vm_admin_room(p_identity,p_session);
      ELSE SELECT room_id INTO owner FROM vm_voting_access(p_identity,p_session); END IF;
      IF owner IS NULL THEN RETURN jsonb_build_object('status',401); END IF;
      PERFORM 1 FROM rooms WHERE id=owner FOR SHARE;
      IF (p_admin AND NOT EXISTS(SELECT 1 FROM vm_admin_room(p_identity,p_session))) OR (NOT p_admin AND NOT EXISTS(SELECT 1 FROM vm_voting_access(p_identity,p_session))) THEN RETURN jsonb_build_object('status',401); END IF;
      SELECT show_all_results INTO shared FROM rooms WHERE id=owner;
      IF NOT p_admin AND NOT shared THEN RETURN jsonb_build_object('status',403); END IF;
      IF NOT p_admin AND EXISTS(SELECT 1 FROM voting_links WHERE id=p_identity AND mode='reusable') THEN
        SELECT r.id INTO selected_run FROM voting_runs r JOIN voting_sessions s ON s.id=r.session_id WHERE s.link_id=p_identity AND s.secret_hash=p_session AND (p_run IS NULL OR r.id=p_run) ORDER BY r.created_at DESC,r.id DESC LIMIT 1;
        IF p_run IS NOT NULL AND selected_run IS NULL THEN RETURN jsonb_build_object('status',404); END IF;
      END IF;
      WITH visible AS MATERIALIZED (
        SELECT q.* FROM questions q WHERE q.room_id=owner AND q.first_opened_at IS NOT NULL AND q.state<>'draft' AND (NOT q.hide_results_until_end OR vm_effective_state(q.id)='closed')
      ), votes AS MATERIALIZED (
        SELECT b.*,CASE WHEN b.source IN ('personal','admin_personal') THEN 'personal' WHEN b.source='reusable' THEN 'reusable' ELSE 'admin_manual' END AS kind,
          CASE WHEN b.source IN ('personal','admin_personal') THEN 'p:'||b.link_id WHEN b.source='reusable' THEN 'r:'||b.run_id ELSE 'm:'||b.id END AS participant
        FROM ballots b JOIN visible q ON q.id=b.question_id
      ), export_questions AS MATERIALIZED (
        SELECT q.* FROM visible q WHERE p_export AND COALESCE(vm_results_allowed(q.id,p_identity,selected_run,p_admin),false)
      ), identified AS MATERIALIZED (
        SELECT b.* FROM votes b JOIN export_questions q ON q.id=b.question_id WHERE p_admin AND NOT q.anonymous
      ), question_counts AS (
        SELECT q.id,q.content,q.ordinal,count(b.id) AS answers FROM visible q LEFT JOIN votes b ON b.question_id=q.id GROUP BY q.id,q.content,q.ordinal
      ), link_counts AS (
        SELECT l.id,l.name,l.mode,count(b.id) AS answers,count(DISTINCT b.participant) AS participants FROM votes b JOIN visible q ON q.id=b.question_id JOIN voting_links l ON l.id=b.link_id WHERE p_admin AND NOT q.anonymous GROUP BY l.id,l.name,l.mode
      ), people AS (
        SELECT b.participant AS id,max(l.name) AS name,max(b.kind) AS kind,
          jsonb_agg(jsonb_build_object('questionId',b.question_id,'choices',COALESCE((SELECT jsonb_agg(o.content ORDER BY o.position) FROM ballot_choices c JOIN question_options o ON o.id=c.option_id WHERE c.ballot_id=b.id),'[]'::jsonb)) ORDER BY q.ordinal) AS answers
        FROM identified b JOIN export_questions q ON q.id=b.question_id LEFT JOIN voting_links l ON l.id=b.link_id GROUP BY b.participant
      )
      SELECT jsonb_build_object('status',200,'report',jsonb_build_object(
        'roomName',(SELECT name FROM rooms WHERE id=owner),'shared',shared,
        'participants',(SELECT count(DISTINCT participant) FROM votes),'answers',(SELECT count(*) FROM votes),
        'questions',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'content',content,'answers',answers) ORDER BY answers DESC,ordinal) FROM question_counts),'[]'::jsonb),
        'sources',COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',kind,'answers',answers) ORDER BY kind) FROM (SELECT kind,count(*) AS answers FROM votes GROUP BY kind) s),'[]'::jsonb),
        'links',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'mode',mode,'answers',answers,'participants',participants) ORDER BY answers DESC,id) FROM link_counts),'[]'::jsonb),
        'sheets',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',q.id,'content',q.content,'anonymous',q.anonymous,'total',(SELECT count(*) FROM votes WHERE question_id=q.id),'options',COALESCE((SELECT jsonb_agg(jsonb_build_object('content',o.content,'count',(SELECT count(*) FROM ballot_choices WHERE option_id=o.id)) ORDER BY o.position) FROM question_options o WHERE o.question_id=q.id),'[]'::jsonb)) ORDER BY q.ordinal) FROM export_questions q),'[]'::jsonb),
        'people',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'kind',kind,'answers',answers) ORDER BY id) FROM people),'[]'::jsonb)
      )) INTO result;
      RETURN result;
    END $$;
    ALTER FUNCTION vm_results(uuid,bytea,boolean,uuid,jsonb) RENAME TO vm_results_before_report;
    CREATE FUNCTION vm_results(p_identity uuid,p_session bytea,p_admin boolean,p_question uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
      IF p_data->>'view' IN ('summary','export') THEN RETURN vm_room_report(p_identity,p_session,p_admin,(p_data->>'run')::uuid,p_data->>'view'='export'); END IF;
      RETURN vm_results_before_report(p_identity,p_session,p_admin,p_question,p_data);
    EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('status',400); END $$;
    ALTER FUNCTION vm_room_experience(uuid,bytea,boolean,jsonb) RENAME TO vm_room_experience_before_report;
    CREATE FUNCTION vm_room_experience(p_identity uuid,p_session bytea,p_admin boolean,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE owner uuid; result jsonb;
    BEGIN
      IF p_data ? 'showAllResults' THEN
        IF NOT p_admin THEN RETURN jsonb_build_object('status',403); END IF;
        SELECT id INTO owner FROM vm_admin_room(p_identity,p_session);
        IF owner IS NULL THEN RETURN jsonb_build_object('status',401); END IF;
        IF jsonb_typeof(p_data->'showAllResults') IS DISTINCT FROM 'boolean' THEN RETURN jsonb_build_object('status',400); END IF;
        PERFORM 1 FROM rooms WHERE id=owner FOR UPDATE;
        IF NOT EXISTS(SELECT 1 FROM vm_admin_room(p_identity,p_session)) THEN RETURN jsonb_build_object('status',401); END IF;
        UPDATE rooms SET show_all_results=(p_data->>'showAllResults')::boolean WHERE id=owner AND show_all_results IS DISTINCT FROM (p_data->>'showAllResults')::boolean;
      END IF;
      result:=vm_room_experience_before_report(p_identity,p_session,p_admin,p_data-'showAllResults');
      IF result->>'status'<>'200' THEN RETURN result; END IF;
      IF p_admin THEN SELECT id INTO owner FROM vm_admin_room(p_identity,p_session); ELSE SELECT room_id INTO owner FROM vm_voting_access(p_identity,p_session); END IF;
      RETURN result||jsonb_build_object('showAllResults',(SELECT show_all_results FROM rooms WHERE id=owner));
    END $$;
    ALTER FUNCTION vm_participant_journey(uuid,bytea,jsonb) RENAME TO vm_participant_journey_before_report;
    CREATE FUNCTION vm_participant_journey(p_link uuid,p_session bytea,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb;
    BEGIN
      result:=vm_participant_journey_before_report(p_link,p_session,p_data);
      IF result->>'status'='200' THEN result:=result||jsonb_build_object('resultsAvailable',COALESCE((result->>'resultsAvailable')::boolean,false) OR EXISTS(SELECT 1 FROM rooms r JOIN vm_voting_access(p_link,p_session) a ON a.room_id=r.id WHERE r.show_all_results)); END IF;
      RETURN result;
    END $$;
    ALTER FUNCTION vm_event_state(uuid,bytea,boolean) RENAME TO vm_event_state_before_report;
    CREATE FUNCTION vm_event_state(p_identity uuid,p_session bytea,p_admin boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; report jsonb;
    BEGIN
      result:=vm_event_state_before_report(p_identity,p_session,p_admin);
      IF result->>'status'='200' AND NOT p_admin AND EXISTS(SELECT 1 FROM rooms WHERE id=(result->>'roomId')::uuid AND show_all_results) THEN
        report:=vm_room_report(p_identity,p_session,false,NULL,false);
        result:=result||jsonb_build_object('version',md5((result->>'version')||report::text));
      END IF;
      RETURN result;
    END $$;
    REVOKE ALL ON FUNCTION vm_room_report(uuid,bytea,boolean,uuid,boolean),vm_results_before_report(uuid,bytea,boolean,uuid,jsonb),vm_results(uuid,bytea,boolean,uuid,jsonb),vm_room_experience_before_report(uuid,bytea,boolean,jsonb),vm_room_experience(uuid,bytea,boolean,jsonb),vm_participant_journey_before_report(uuid,bytea,jsonb),vm_participant_journey(uuid,bytea,jsonb),vm_event_state_before_report(uuid,bytea,boolean),vm_event_state(uuid,bytea,boolean) FROM PUBLIC;
  `);
}

// Restore the old views and keep all rooms and votes
export function down(pgm) {
  pgm.sql(`
    DROP FUNCTION vm_event_state(uuid,bytea,boolean),vm_participant_journey(uuid,bytea,jsonb),vm_room_experience(uuid,bytea,boolean,jsonb),vm_results(uuid,bytea,boolean,uuid,jsonb);
    ALTER FUNCTION vm_event_state_before_report(uuid,bytea,boolean) RENAME TO vm_event_state;
    ALTER FUNCTION vm_participant_journey_before_report(uuid,bytea,jsonb) RENAME TO vm_participant_journey;
    ALTER FUNCTION vm_room_experience_before_report(uuid,bytea,boolean,jsonb) RENAME TO vm_room_experience;
    ALTER FUNCTION vm_results_before_report(uuid,bytea,boolean,uuid,jsonb) RENAME TO vm_results;
    DROP FUNCTION vm_room_report(uuid,bytea,boolean,uuid,boolean);
    ALTER TABLE rooms DROP COLUMN show_all_results;
  `);
}
