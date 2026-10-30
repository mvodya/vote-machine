// Keep scheduled question content out of participant snapshots
export function up(pgm) {
  pgm.sql(`
    ALTER TABLE questions ADD COLUMN hide_until_open boolean NOT NULL DEFAULT false;
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_question_data(uuid)','vm_question_request(uuid,bytea,uuid,text,jsonb)','vm_journey_with_starts(uuid,bytea,jsonb)','vm_participant_journey(uuid,bytea,jsonb)','vm_participant_asset(uuid,bytea,uuid)','vm_results_allowed(uuid,uuid,uuid,boolean)','vm_results_before_review(uuid,bytea,boolean,uuid,jsonb)','vm_room_report_before_history(uuid,bytea,boolean,uuid,boolean)'] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||name||'_before_hidden_content(');
        EXECUTE 'REVOKE ALL ON FUNCTION '||replace(signature,name,name||'_before_hidden_content')||' FROM PUBLIC';
      END LOOP;
    END $$;
    CREATE OR REPLACE FUNCTION vm_question_data(p_id uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
      SELECT vm_question_data_before_hidden_content(p_id)||jsonb_build_object('hideUntilOpen',hide_until_open) FROM questions WHERE id=p_id;
    $$;
    CREATE OR REPLACE FUNCTION vm_question_request(p_room uuid,p_admin bytea,p_id uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb;
    BEGIN
      IF p_action IN ('create','save') AND p_data ? 'hideUntilOpen' AND jsonb_typeof(p_data->'hideUntilOpen') IS DISTINCT FROM 'boolean' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      result:=vm_question_request_before_hidden_content(p_room,p_admin,p_id,p_action,p_data);
      IF p_action IN ('create','save') AND result->>'status' IN ('200','201') THEN
        p_id:=(result#>>'{question,id}')::uuid;
        UPDATE questions SET hide_until_open=(p_data->>'hideUntilOpen')::boolean WHERE id=p_id AND p_data ? 'hideUntilOpen' AND hide_until_open IS DISTINCT FROM (p_data->>'hideUntilOpen')::boolean;
        result:=jsonb_set(result,'{question}',result->'question'||(SELECT jsonb_build_object('hideUntilOpen',hide_until_open,'revision',revision::text) FROM questions WHERE id=p_id));
      END IF;
      RETURN result;
    END;
    $$;
    CREATE OR REPLACE FUNCTION vm_participant_journey(p_link uuid,p_session bytea,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb;
    BEGIN
      result:=vm_participant_journey_before_hidden_content(p_link,p_session,p_data);
      IF result->>'status'='200' AND EXISTS(SELECT 1 FROM questions WHERE id=(result#>>'{upcoming,id}')::uuid AND hide_until_open AND scheduled_at IS NOT NULL) THEN
        result:=jsonb_set(result,'{upcoming,preview}','""'::jsonb);
      END IF;
      RETURN result;
    END;
    $$;
    DO $$ DECLARE definition text; BEGIN
      definition:=pg_get_functiondef('vm_journey_with_starts(uuid,bytea,jsonb)'::regprocedure);
      IF position('q.room_id = owner AND' IN definition)=0 THEN RAISE EXCEPTION 'Missing journey filter'; END IF;
      EXECUTE replace(definition,'q.room_id = owner AND','q.room_id = owner AND NOT (q.hide_until_open AND q.scheduled_at IS NOT NULL) AND');
      definition:=pg_get_functiondef('vm_participant_asset(uuid,bytea,uuid)'::regprocedure);
      EXECUTE replace(definition,'q.first_opened_at IS NOT NULL','NOT (q.hide_until_open AND q.scheduled_at IS NOT NULL) AND q.first_opened_at IS NOT NULL');
      definition:=pg_get_functiondef('vm_results_allowed(uuid,uuid,uuid,boolean)'::regprocedure);
      EXECUTE replace(definition,'SELECT (NOT q.hide_results_until_end','SELECT (p_admin OR NOT (q.hide_until_open AND q.scheduled_at IS NOT NULL)) AND (NOT q.hide_results_until_end');
      definition:=pg_get_functiondef('vm_results_before_review(uuid,bytea,boolean,uuid,jsonb)'::regprocedure);
      IF position('q.room_id=owner AND' IN definition)=0 THEN RAISE EXCEPTION 'Missing participant filter'; END IF;
      EXECUTE replace(definition,'q.room_id=owner AND','q.room_id=owner AND (p_admin OR NOT (q.hide_until_open AND q.scheduled_at IS NOT NULL)) AND');
      definition:=pg_get_functiondef('vm_room_report_before_history(uuid,bytea,boolean,uuid,boolean)'::regprocedure);
      IF position('q.room_id=owner AND' IN definition)=0 THEN RAISE EXCEPTION 'Missing participant filter'; END IF;
      EXECUTE replace(definition,'q.room_id=owner AND','q.room_id=owner AND (p_admin OR NOT (q.hide_until_open AND q.scheduled_at IS NOT NULL)) AND');
    END $$;
  `);
}

// Require an explicit choice before removing content protection
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM questions WHERE hide_until_open) THEN RAISE EXCEPTION 'Disable hidden question content before rollback'; END IF; END $$;
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_question_data(uuid)','vm_question_request(uuid,bytea,uuid,text,jsonb)','vm_journey_with_starts(uuid,bytea,jsonb)','vm_participant_journey(uuid,bytea,jsonb)','vm_participant_asset(uuid,bytea,uuid)','vm_results_allowed(uuid,uuid,uuid,boolean)','vm_results_before_review(uuid,bytea,boolean,uuid,jsonb)','vm_room_report_before_history(uuid,bytea,boolean,uuid,boolean)'] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(replace(signature,name,name||'_before_hidden_content')::regprocedure),'FUNCTION public.'||name||'_before_hidden_content(','FUNCTION public.'||name||'(');
        EXECUTE 'DROP FUNCTION '||replace(signature,name,name||'_before_hidden_content');
      END LOOP;
    END $$;
    ALTER TABLE questions DROP COLUMN hide_until_open;
  `);
}
