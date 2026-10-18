// Add personal question navigation without exposing other answers
export function up(pgm) {
  pgm.sql(`
    ALTER TABLE questions ADD COLUMN allow_skip boolean NOT NULL DEFAULT false;
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_question_data(uuid)','vm_question_request_v6(uuid,bytea,uuid,text,jsonb)','vm_question_lifecycle(uuid,bytea,uuid,jsonb)','vm_participant_asset(uuid,bytea,uuid)','vm_cast_personal(uuid,bytea,uuid,jsonb)'] LOOP
        name := split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.' || name || '(', 'FUNCTION public.' || name || '_pre10(');
      END LOOP;
    END $$;
    CREATE OR REPLACE FUNCTION vm_question_data(p_id uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
      SELECT vm_question_data_pre10(p_id) || jsonb_build_object('allowSkip',allow_skip) FROM questions WHERE id = p_id;
    $$;
    DO $$ DECLARE definition text; BEGIN
      definition := pg_get_functiondef('vm_question_request_v6(uuid,bytea,uuid,text,jsonb)'::regprocedure);
      definition := replace(definition,'IF NOT vm_valid_question_document(p_data) THEN', 'IF (p_data ? ''allowSkip'' AND jsonb_typeof(p_data->''allowSkip'') IS DISTINCT FROM ''boolean'') OR NOT vm_valid_question_document(p_data) THEN');
      EXECUTE replace(definition,'anonymous = (p_data->>''anonymous'')::boolean WHERE id = saved.id;', 'anonymous = (p_data->>''anonymous'')::boolean, allow_skip = COALESCE((p_data->>''allowSkip'')::boolean,false) WHERE id = saved.id;');
      definition := pg_get_functiondef('vm_question_lifecycle(uuid,bytea,uuid,jsonb)'::regprocedure);
      definition := replace(definition,'action := p_data->>''action'';', 'IF p_data ? ''allowSkip'' AND jsonb_typeof(p_data->''allowSkip'') IS DISTINCT FROM ''boolean'' THEN RETURN jsonb_build_object(''status'',400,''error'',''invalid''); END IF; action := p_data->>''action'';');
      EXECUTE replace(definition,'UPDATE questions SET closes_at = deadline,share_results', 'UPDATE questions SET allow_skip = COALESCE((p_data->>''allowSkip'')::boolean,allow_skip),closes_at = deadline,share_results');
    END $$;
    CREATE FUNCTION vm_navigation_allowed(p_link uuid,p_question uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
      SELECT EXISTS(SELECT 1 FROM questions q JOIN voting_links l ON l.room_id = q.room_id WHERE l.id = p_link AND q.id = p_question AND q.first_opened_at IS NOT NULL AND (
        EXISTS(SELECT 1 FROM ballots b WHERE b.link_id = p_link AND b.question_id = q.id) OR NOT EXISTS(
          SELECT 1 FROM questions prior WHERE prior.room_id = q.room_id AND vm_effective_state(prior.id) = 'open' AND NOT prior.allow_skip
          AND (prior.created_at,prior.ordinal) < (q.created_at,q.ordinal)
          AND NOT EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = prior.id AND b.link_id = p_link)
        )
      ));
    $$;
    DO $$ DECLARE definition text; BEGIN
      definition := pg_get_functiondef('vm_cast_personal(uuid,bytea,uuid,jsonb)'::regprocedure);
      EXECUTE replace(definition,'IF question.state <> ''open'' OR question.closes_at <= clock_timestamp() THEN', 'IF NOT vm_navigation_allowed(p_link,p_question) THEN RETURN jsonb_build_object(''status'',409,''error'',''sequence''); END IF; IF question.state <> ''open'' OR question.closes_at <= clock_timestamp() THEN');
    END $$;
    CREATE FUNCTION vm_participant_journey(p_link uuid,p_session bytea,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE owner uuid; mode text; selected uuid; skipped questions; current questions; after_time timestamptz; after_key bigint; page jsonb; next_cursor text; progress jsonb;
    BEGIN
      SELECT room_id INTO owner FROM voting_links WHERE id = p_link;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      PERFORM 1 FROM rooms WHERE id = owner FOR SHARE;
      SELECT access.mode INTO mode FROM vm_voting_access(p_link,p_session) access;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF mode <> 'personal' THEN RETURN jsonb_build_object('status',200,'questions','[]'::jsonb,'nextCursor',NULL,'current',NULL,'answer',NULL,'progress',jsonb_build_object('answered',0,'total',0,'pending',0)); END IF;
      IF p_data->>'after' IS NOT NULL AND p_data->>'after' <> '0' THEN
        IF (p_data->>'after') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}.[0-9]{6}Z~[1-9][0-9]{0,18}$' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
        after_time := split_part(p_data->>'after','~',1)::timestamptz; after_key := split_part(p_data->>'after','~',2)::bigint;
      END IF;
      IF p_data->>'skip' IS NOT NULL THEN
        SELECT * INTO skipped FROM questions WHERE id = (p_data->>'skip')::uuid AND room_id = owner AND first_opened_at IS NOT NULL;
        IF NOT FOUND OR (vm_effective_state(skipped.id) = 'open' AND NOT skipped.allow_skip AND NOT EXISTS(SELECT 1 FROM ballots WHERE question_id = skipped.id AND link_id = p_link)) THEN RETURN jsonb_build_object('status',409,'error','skip'); END IF;
      END IF;
      IF p_data->>'selected' IS NOT NULL THEN
        SELECT * INTO current FROM questions q WHERE q.id = (p_data->>'selected')::uuid AND q.room_id = owner AND q.first_opened_at IS NOT NULL
          AND (vm_effective_state(q.id) = 'open' OR EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = q.id AND b.link_id = p_link));
        IF FOUND AND NOT vm_navigation_allowed(p_link,current.id) THEN current := NULL; END IF;
      END IF;
      IF current.id IS NULL THEN
        SELECT * INTO current FROM questions q WHERE q.room_id = owner AND vm_effective_state(q.id) = 'open'
          AND NOT EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = q.id AND b.link_id = p_link)
          AND (skipped.id IS NULL OR (q.created_at,q.ordinal) > (skipped.created_at,skipped.ordinal))
          AND vm_navigation_allowed(p_link,q.id)
          ORDER BY q.created_at,q.ordinal LIMIT 1;
      END IF;
      WITH selected AS MATERIALIZED (
        SELECT q.*,EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = q.id AND b.link_id = p_link) AS answered
          FROM questions q WHERE q.room_id = owner AND q.first_opened_at IS NOT NULL
          AND (vm_effective_state(q.id) = 'open' OR EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = q.id AND b.link_id = p_link))
          AND (after_time IS NULL OR (q.created_at,q.ordinal) > (after_time,after_key)) ORDER BY q.created_at,q.ordinal LIMIT 51
      ), visible AS (SELECT * FROM selected ORDER BY created_at,ordinal LIMIT 50)
      SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'roomId',room_id,'preview',left(content,240),'state',vm_effective_state(id),'ordinal',ordinal::text,'revision',revision::text,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'editLocked',edit_locked,'choiceMode',choice_mode,'choiceCount',(SELECT count(*) FROM question_options WHERE question_id = visible.id),'answered',answered,'allowSkip',allow_skip,'canChoose',vm_navigation_allowed(p_link,id)) || vm_lifecycle_data(id) ORDER BY created_at,ordinal),'[]'),
        CASE WHEN (SELECT count(*) FROM selected) > 50 THEN (SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '~' || ordinal::text FROM visible ORDER BY created_at DESC,ordinal DESC LIMIT 1) END
        INTO page,next_cursor FROM visible;
      SELECT jsonb_build_object('total',count(*),'answered',count(*) FILTER(WHERE EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = q.id AND b.link_id = p_link)),'pending',count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = q.id AND b.link_id = p_link))) INTO progress FROM questions q WHERE q.room_id = owner AND vm_effective_state(q.id) = 'open';
      RETURN jsonb_build_object('status',200,'questions',page,'nextCursor',next_cursor,'current',vm_question_data(current.id),'answer',(SELECT vm_ballot_data(id) FROM ballots WHERE question_id = current.id AND link_id = p_link),'progress',progress);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN RETURN jsonb_build_object('status',400,'error','invalid');
    END;
    $$;
    CREATE OR REPLACE FUNCTION vm_participant_asset(p_link uuid,p_session bytea,p_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE owner uuid;
    BEGIN
      SELECT room_id INTO owner FROM vm_voting_access(p_link,p_session);
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF NOT EXISTS(SELECT 1 FROM assets a JOIN question_asset_refs ref ON ref.asset_id = a.id JOIN questions q ON q.id = ref.question_id WHERE a.id = p_id AND a.room_id = owner AND a.state = 'ready' AND q.first_opened_at IS NOT NULL AND (vm_effective_state(q.id) = 'open' OR EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = q.id AND b.link_id = p_link))) THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      RETURN jsonb_build_object('status',200,'asset',vm_asset_data(p_id));
    END;
    $$;
    REVOKE ALL ON FUNCTION vm_question_data_pre10(uuid),vm_question_request_v6_pre10(uuid,bytea,uuid,text,jsonb),vm_question_lifecycle_pre10(uuid,bytea,uuid,jsonb),vm_participant_asset_pre10(uuid,bytea,uuid),vm_cast_personal_pre10(uuid,bytea,uuid,jsonb),vm_navigation_allowed(uuid,uuid),vm_participant_journey(uuid,bytea,jsonb) FROM PUBLIC;
  `);
}

// Restore previous access rules before removing the skip setting
export function down(pgm) {
  pgm.sql(`
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_question_data_pre10(uuid)','vm_question_request_v6_pre10(uuid,bytea,uuid,text,jsonb)','vm_question_lifecycle_pre10(uuid,bytea,uuid,jsonb)','vm_participant_asset_pre10(uuid,bytea,uuid)','vm_cast_personal_pre10(uuid,bytea,uuid,jsonb)'] LOOP
        name := split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.' || name || '(', 'FUNCTION public.' || replace(name,'_pre10','') || '(');
      END LOOP;
    END $$;
    DROP FUNCTION vm_participant_journey(uuid,bytea,jsonb),vm_navigation_allowed(uuid,uuid);
    DROP FUNCTION vm_question_data_pre10(uuid),vm_question_request_v6_pre10(uuid,bytea,uuid,text,jsonb),vm_question_lifecycle_pre10(uuid,bytea,uuid,jsonb),vm_participant_asset_pre10(uuid,bytea,uuid),vm_cast_personal_pre10(uuid,bytea,uuid,jsonb);
    ALTER TABLE questions DROP COLUMN allow_skip;
  `);
}
