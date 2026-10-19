// Filter every result and saved anonymous choice on the server
export function up(pgm) {
  pgm.sql(`
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_participant_asset(uuid,bytea,uuid)','vm_personal_answer(uuid,bytea,uuid)','vm_current_answer(uuid,bytea,uuid,uuid)','vm_participant_journey(uuid,bytea,jsonb)','vm_cast_personal(uuid,bytea,uuid,jsonb)','vm_cast_ballot(uuid,uuid,bytea,boolean,uuid,jsonb)'] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||name||'_before_privacy(');
      END LOOP;
    END $$;
    CREATE FUNCTION vm_session_answer(p_id uuid,p_session bytea) RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT CASE WHEN q.anonymous AND NOT EXISTS(SELECT 1 FROM voting_sessions s WHERE s.id=b.origin_session_id AND s.secret_hash=p_session)
        THEN jsonb_build_object('questionId',b.question_id,'revision',b.revision::text,'choices','[]'::jsonb,'hidden',true)
        ELSE vm_ballot_data(b.id) END FROM ballots b JOIN questions q ON q.id=b.question_id WHERE b.id=p_id;
    $$;
    CREATE FUNCTION vm_session_receipt(p_reply jsonb,p_session bytea) RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT CASE WHEN p_reply#>>'{answer,id}' IS NOT NULL AND EXISTS(SELECT 1 FROM questions WHERE id=(p_reply#>>'{answer,questionId}')::uuid AND anonymous)
        THEN jsonb_set(p_reply,'{answer}',COALESCE(vm_session_answer((p_reply#>>'{answer,id}')::uuid,p_session),'null'::jsonb)) ELSE p_reply END;
    $$;
    DO $$ DECLARE signature text; definition text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_personal_answer(uuid,bytea,uuid)','vm_current_answer(uuid,bytea,uuid,uuid)','vm_participant_journey(uuid,bytea,jsonb)'] LOOP
        definition:=pg_get_functiondef(signature::regprocedure);
        EXECUTE replace(definition,'vm_ballot_data(id)','vm_session_answer(id,p_session)');
      END LOOP;
      definition:=pg_get_functiondef('vm_participant_asset(uuid,bytea,uuid)'::regprocedure);
      EXECUTE replace(definition,$patch$vm_effective_state(q.id) = 'open' OR$patch$,$patch$vm_effective_state(q.id) = 'open' OR (vm_effective_state(q.id) = 'closed' AND q.share_results) OR$patch$);
      definition:=pg_get_functiondef('vm_cast_personal(uuid,bytea,uuid,jsonb)'::regprocedure);
      EXECUTE replace(definition,'RETURN cached.response;','RETURN vm_session_receipt(cached.response,p_session);');
      definition:=pg_get_functiondef('vm_cast_ballot(uuid,uuid,bytea,boolean,uuid,jsonb)'::regprocedure);
      EXECUTE replace(definition,'RETURN cached->''response'';','IF p_admin THEN RETURN cached->''response''; END IF; RETURN vm_session_receipt(cached->''response'',p_session);');
    END $$;
    CREATE FUNCTION vm_results_allowed(p_question uuid,p_link uuid,p_run uuid,p_admin boolean) RETURNS boolean LANGUAGE sql VOLATILE AS $$
      SELECT (NOT q.hide_results_until_end OR vm_effective_state(q.id)='closed') AND (p_admin OR (
        q.state<>'draft' AND q.first_opened_at IS NOT NULL AND q.share_results AND (vm_effective_state(q.id)='closed' OR (q.publication='after_answer' AND EXISTS(
          SELECT 1 FROM ballots b WHERE b.question_id=q.id AND b.link_id=p_link AND b.run_id IS NOT DISTINCT FROM p_run
        )))
      )) FROM questions q WHERE q.id=p_question;
    $$;
    CREATE FUNCTION vm_results(p_identity uuid,p_session bytea,p_admin boolean,p_question uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE owner uuid; run uuid; saved questions; page jsonb; next_page text; votes bigint; options jsonb; sources jsonb; people jsonb; next_person text; after_key bigint; after_person uuid;
    BEGIN
      IF p_admin THEN SELECT id INTO owner FROM vm_admin_room(p_identity,p_session);
      ELSE SELECT room_id INTO owner FROM vm_voting_access(p_identity,p_session); END IF;
      IF owner IS NULL THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      PERFORM 1 FROM rooms WHERE id=owner FOR SHARE;
      IF NOT p_admin AND EXISTS(SELECT 1 FROM voting_links WHERE id=p_identity AND mode='reusable') THEN
        SELECT r.id INTO run FROM voting_runs r JOIN voting_sessions s ON s.id=r.session_id WHERE s.link_id=p_identity AND s.secret_hash=p_session AND (p_data->>'run' IS NULL OR r.id=(p_data->>'run')::uuid) ORDER BY r.created_at DESC,r.id DESC LIMIT 1;
        IF p_data->>'run' IS NOT NULL AND run IS NULL THEN RETURN jsonb_build_object('status',404,'error','run'); END IF;
      END IF;
      IF p_question IS NULL THEN
        after_key:=COALESCE((p_data->>'after')::bigint,0);
        IF after_key<0 THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
        WITH selected AS MATERIALIZED (
          SELECT q.* FROM questions q WHERE q.room_id=owner AND q.ordinal>after_key AND (p_admin OR (q.state<>'draft' AND q.first_opened_at IS NOT NULL AND q.share_results)) ORDER BY q.ordinal LIMIT 51
        ), visible AS (SELECT * FROM selected ORDER BY ordinal LIMIT 50)
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'content',content,'state',vm_effective_state(id),'available',vm_results_allowed(id,p_identity,run,p_admin)) ORDER BY ordinal),'[]'),CASE WHEN (SELECT count(*) FROM selected)>50 THEN (SELECT max(ordinal)::text FROM visible) END INTO page,next_page FROM visible;
        RETURN jsonb_build_object('status',200,'questions',page,'nextCursor',next_page);
      END IF;
      SELECT * INTO saved FROM questions WHERE id=p_question AND room_id=owner AND (p_admin OR (state<>'draft' AND first_opened_at IS NOT NULL AND share_results));
      IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      IF NOT COALESCE(vm_results_allowed(saved.id,p_identity,run,p_admin),false) THEN RETURN jsonb_build_object('status',200,'result',jsonb_build_object('id',saved.id,'available',false)); END IF;
      SELECT count(*) INTO votes FROM ballots WHERE question_id=saved.id;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',o.id,'content',o.content,'count',(SELECT count(*) FROM ballot_choices WHERE option_id=o.id),'percent',CASE WHEN votes=0 THEN 0 ELSE round(100.0*(SELECT count(*) FROM ballot_choices WHERE option_id=o.id)/votes,2) END) ORDER BY o.position),'[]') INTO options FROM question_options o WHERE question_id=saved.id;
      IF p_admin THEN
        SELECT jsonb_build_object('personal',count(*) FILTER(WHERE source='personal'),'admin_personal',count(*) FILTER(WHERE source='admin_personal'),'reusable',count(*) FILTER(WHERE source='reusable'),'admin_manual',count(*) FILTER(WHERE source='admin_manual')) INTO sources FROM ballots WHERE question_id=saved.id;
        IF NOT saved.anonymous THEN
          after_person:=(p_data->>'peopleAfter')::uuid;
          WITH selected AS MATERIALIZED (SELECT b.* FROM ballots b WHERE b.question_id=saved.id AND (after_person IS NULL OR b.id>after_person) ORDER BY b.id LIMIT 51), visible AS (SELECT * FROM selected ORDER BY id LIMIT 50)
          SELECT COALESCE(jsonb_agg(jsonb_build_object('id',b.id,'linkId',b.link_id,'name',l.name,'source',b.source,'choices',(SELECT jsonb_agg(option_id ORDER BY option_id) FROM ballot_choices WHERE ballot_id=b.id)) ORDER BY b.id),'[]'),CASE WHEN (SELECT count(*) FROM selected)>50 THEN (SELECT id::text FROM visible ORDER BY id DESC LIMIT 1) END INTO people,next_person FROM visible b LEFT JOIN voting_links l ON l.id=b.link_id;
        END IF;
      END IF;
      RETURN jsonb_build_object('status',200,'result',jsonb_build_object('id',saved.id,'available',true,'roomId',owner,'content',saved.content,'state',vm_effective_state(saved.id),'anonymous',saved.anonymous,'choiceMode',saved.choice_mode,'total',votes,'options',options) || CASE WHEN p_admin THEN jsonb_build_object('sources',sources) ELSE '{}'::jsonb END || CASE WHEN p_admin AND NOT saved.anonymous THEN jsonb_build_object('people',people,'nextPeopleCursor',next_person) ELSE '{}'::jsonb END);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN jsonb_build_object('status',400,'error','invalid');
    END;
    $$;
    REVOKE ALL ON FUNCTION vm_session_answer(uuid,bytea),vm_session_receipt(jsonb,bytea),vm_results_allowed(uuid,uuid,uuid,boolean),vm_results(uuid,bytea,boolean,uuid,jsonb),vm_participant_asset_before_privacy(uuid,bytea,uuid),vm_personal_answer_before_privacy(uuid,bytea,uuid),vm_current_answer_before_privacy(uuid,bytea,uuid,uuid),vm_participant_journey_before_privacy(uuid,bytea,jsonb),vm_cast_personal_before_privacy(uuid,bytea,uuid,jsonb),vm_cast_ballot_before_privacy(uuid,uuid,bytea,boolean,uuid,jsonb) FROM PUBLIC;
  `);
}
// Restore the old readers without changing saved ballots
export function down(pgm) {
  pgm.sql(`
    DROP FUNCTION vm_results(uuid,bytea,boolean,uuid,jsonb),vm_results_allowed(uuid,uuid,uuid,boolean);
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_participant_asset_before_privacy(uuid,bytea,uuid)','vm_personal_answer_before_privacy(uuid,bytea,uuid)','vm_current_answer_before_privacy(uuid,bytea,uuid,uuid)','vm_participant_journey_before_privacy(uuid,bytea,jsonb)','vm_cast_personal_before_privacy(uuid,bytea,uuid,jsonb)','vm_cast_ballot_before_privacy(uuid,uuid,bytea,boolean,uuid,jsonb)'] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||replace(name,'_before_privacy','')||'(');
        EXECUTE 'DROP FUNCTION '||signature;
      END LOOP;
    END $$;
    DROP FUNCTION vm_session_receipt(jsonb,bytea),vm_session_answer(uuid,bytea);
  `);
}
