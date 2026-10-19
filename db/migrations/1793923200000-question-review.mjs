// Add scheduled starts and short-lived question view leases
export function up(pgm) {
  pgm.sql(`
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_store_question(uuid,bytea,uuid,text,jsonb)','vm_effective_state(uuid)','vm_lifecycle_data(uuid)','vm_question_request(uuid,bytea,uuid,text,jsonb)','vm_question_lifecycle(uuid,bytea,uuid,jsonb)','vm_close_due()','vm_reset_question(uuid,bytea,uuid,jsonb)','vm_participant_journey(uuid,bytea,jsonb)','vm_results(uuid,bytea,boolean,uuid,jsonb)','vm_event_state(uuid,bytea,boolean)'] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||name||'_before_review(');
        EXECUTE 'REVOKE ALL ON FUNCTION '||replace(signature,name,name||'_before_review')||' FROM PUBLIC';
      END LOOP;
    END $$;

    ALTER TABLE questions ADD COLUMN start_mode text NOT NULL DEFAULT 'none' CHECK(start_mode IN ('none','absolute','duration'));
    ALTER TABLE questions ADD COLUMN starts_at timestamptz CHECK(isfinite(starts_at));
    ALTER TABLE questions ADD COLUMN start_after_seconds integer CHECK(start_after_seconds>0);
    ALTER TABLE questions ADD COLUMN scheduled_at timestamptz CHECK(isfinite(scheduled_at));
    ALTER TABLE questions ADD CONSTRAINT question_start_config CHECK(
      (start_mode='none' AND starts_at IS NULL AND start_after_seconds IS NULL AND scheduled_at IS NULL) OR
      (start_mode='absolute' AND starts_at IS NOT NULL AND start_after_seconds IS NULL) OR
      (start_mode='duration' AND starts_at IS NULL AND start_after_seconds IS NOT NULL)
    );
    ALTER TABLE questions ADD CONSTRAINT question_waiting_state CHECK(scheduled_at IS NULL OR state<>'open');
    CREATE INDEX questions_start_due ON questions(scheduled_at,room_id) WHERE scheduled_at IS NOT NULL;
    CREATE TABLE question_views (
      room_id uuid NOT NULL,
      link_id uuid NOT NULL,
      session_id uuid NOT NULL,
      tab_id uuid NOT NULL,
      sequence bigint NOT NULL CHECK(sequence>0),
      question_id uuid REFERENCES questions(id) ON DELETE CASCADE,
      seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY(link_id,room_id) REFERENCES voting_links(id,room_id) ON DELETE RESTRICT,
      FOREIGN KEY(session_id,link_id) REFERENCES voting_sessions(id,link_id) ON DELETE RESTRICT,
      PRIMARY KEY(session_id,tab_id)
    );
    CREATE INDEX question_views_question ON question_views(question_id,seen_at);
    CREATE FUNCTION vm_view_signal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='INSERT' THEN PERFORM pg_notify('live_changes',NEW.room_id::text);
      ELSIF TG_OP='DELETE' THEN PERFORM pg_notify('live_changes',OLD.room_id::text);
      ELSIF NEW.question_id IS DISTINCT FROM OLD.question_id OR OLD.seen_at<=clock_timestamp()-interval '35 seconds' THEN PERFORM pg_notify('live_changes',NEW.room_id::text); END IF;
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER question_view_signal AFTER INSERT OR UPDATE OR DELETE ON question_views FOR EACH ROW EXECUTE FUNCTION vm_view_signal();
    CREATE FUNCTION vm_question_viewers(p_question uuid) RETURNS bigint LANGUAGE sql VOLATILE AS $$
      SELECT count(DISTINCT CASE WHEN l.mode='personal' THEN l.id ELSE v.session_id END)
      FROM question_views v JOIN voting_links l ON l.id=v.link_id JOIN voting_sessions s ON s.id=v.session_id
      WHERE v.question_id=p_question AND v.seen_at>clock_timestamp()-interval '35 seconds' AND l.revoked_at IS NULL AND s.generation=l.generation;
    $$;
    CREATE FUNCTION vm_admin_question_metrics(p_question uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
      SELECT jsonb_build_object('answerCount',(SELECT count(*) FROM ballots WHERE question_id=p_question),'viewerCount',vm_question_viewers(p_question));
    $$;
    CREATE FUNCTION vm_question_presence(p_link uuid,p_session bytea,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE owner uuid; current_session uuid; target uuid; run uuid; tab uuid; serial bigint;
    BEGIN
      SELECT room_id INTO owner FROM voting_links WHERE id=p_link;
      PERFORM 1 FROM rooms WHERE id=owner FOR UPDATE;
      IF NOT EXISTS(SELECT 1 FROM vm_voting_access(p_link,p_session)) THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF jsonb_typeof(p_data->'tabId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_data->'sequence') IS DISTINCT FROM 'number' OR (p_data->>'sequence') !~ '^[1-9][0-9]{0,14}$' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      tab:=(p_data->>'tabId')::uuid;serial:=(p_data->>'sequence')::bigint;
      target:=(p_data->>'questionId')::uuid;run:=(p_data->>'runId')::uuid;
      SELECT id INTO current_session FROM voting_sessions WHERE link_id=p_link AND secret_hash=p_session;
      IF target IS NOT NULL THEN
        IF EXISTS(SELECT 1 FROM voting_links WHERE id=p_link AND mode='reusable') AND NOT EXISTS(SELECT 1 FROM voting_runs WHERE id=run AND session_id=current_session) THEN RETURN jsonb_build_object('status',404,'error','run'); END IF;
        IF NOT EXISTS(SELECT 1 FROM questions WHERE id=target AND room_id=owner AND (scheduled_at IS NOT NULL OR (state<>'draft' AND first_opened_at IS NOT NULL AND vm_run_navigation(p_link,run,target)))) THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      END IF;
      INSERT INTO question_views(room_id,link_id,session_id,tab_id,sequence,question_id) VALUES(owner,p_link,current_session,tab,serial,target)
        ON CONFLICT(session_id,tab_id) DO UPDATE SET sequence=EXCLUDED.sequence,question_id=EXCLUDED.question_id,seen_at=clock_timestamp() WHERE question_views.sequence<EXCLUDED.sequence;
      RETURN jsonb_build_object('status',200,'ok',true);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN jsonb_build_object('status',400,'error','invalid');
    END;
    $$;
    CREATE OR REPLACE FUNCTION vm_effective_state(p_id uuid) RETURNS text LANGUAGE sql VOLATILE AS $$
      SELECT CASE WHEN scheduled_at IS NOT NULL THEN 'scheduled' ELSE vm_effective_state_before_review(p_id) END FROM questions WHERE id=p_id;
    $$;
    CREATE OR REPLACE FUNCTION vm_lifecycle_data(p_id uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
      SELECT vm_lifecycle_data_before_review(p_id)||jsonb_build_object('startMode',start_mode,'startsAt',starts_at,'startAfterSeconds',start_after_seconds,'scheduledAt',scheduled_at) FROM questions WHERE id=p_id;
    $$;
    CREATE OR REPLACE FUNCTION vm_store_question(p_room uuid,p_admin bytea,p_id uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE saved questions; result jsonb; abort_reply jsonb; mode text; start_at timestamptz; duration integer; desired text; armed timestamptz; schedule boolean; now_at timestamptz;
    BEGIN
      PERFORM 1 FROM rooms WHERE id=p_room AND EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF p_action='save' THEN
        SELECT * INTO saved FROM questions WHERE id=p_id AND room_id=p_room FOR UPDATE;
        IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
        IF jsonb_typeof(p_data->'revision') IS DISTINCT FROM 'string' OR (p_data->>'revision') !~ '^(0|[1-9][0-9]{0,18})$' OR (p_data->>'revision')::numeric>9223372036854775807 THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
        IF p_data->>'revision' IS DISTINCT FROM saved.revision::text THEN RETURN jsonb_build_object('status',409,'error','conflict'); END IF;
      END IF;
      mode:=COALESCE(p_data->>'startMode',saved.start_mode,'none');
      IF mode NOT IN ('none','absolute','duration') THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      desired:=COALESCE(p_data->>'state',saved.state,'draft');
      schedule:=desired='open' AND COALESCE(saved.state,'draft')<>'open' AND mode<>'none';
      IF desired='scheduled' AND saved.scheduled_at IS NULL THEN RETURN jsonb_build_object('status',409,'error','state'); END IF;
      IF mode='absolute' THEN
        start_at:=COALESCE((p_data->>'startsAt')::timestamptz,saved.starts_at);
        IF start_at IS NULL OR NOT isfinite(start_at) OR (p_data ? 'startsAt' AND (p_data->>'startsAt') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$') THEN RETURN jsonb_build_object('status',400,'error','deadline'); END IF;
      ELSIF mode='duration' THEN
        IF p_data ? 'startAfterSeconds' AND (jsonb_typeof(p_data->'startAfterSeconds') IS DISTINCT FROM 'number' OR (p_data->>'startAfterSeconds') !~ '^[1-9][0-9]{0,9}$') THEN RETURN jsonb_build_object('status',400,'error','deadline'); END IF;
        duration:=COALESCE((p_data->>'startAfterSeconds')::integer,saved.start_after_seconds);
        IF duration IS NULL OR duration<1 THEN RETURN jsonb_build_object('status',400,'error','deadline'); END IF;
      END IF;
      armed:=saved.scheduled_at;
      now_at:=clock_timestamp();
      IF mode='none' THEN armed:=NULL;
      ELSIF schedule OR (armed IS NOT NULL AND ROW(mode,start_at,duration) IS DISTINCT FROM ROW(saved.start_mode,saved.starts_at,saved.start_after_seconds)) THEN
        armed:=CASE WHEN mode='absolute' THEN start_at ELSE now_at+make_interval(secs=>duration) END;
        IF armed<=now_at THEN RETURN jsonb_build_object('status',400,'error','deadline'); END IF;
      END IF;
      IF armed IS NOT NULL AND COALESCE(p_data->>'deadlineMode',saved.deadline_mode)='absolute' AND COALESCE((p_data->>'closesAt')::timestamptz,saved.closes_at)<=armed THEN RETURN jsonb_build_object('status',400,'error','deadline'); END IF;
      result:=vm_store_question_before_review(p_room,p_admin,p_id,p_action,p_data||jsonb_build_object('state',CASE WHEN schedule OR desired='scheduled' THEN COALESCE(saved.state,'draft') ELSE desired END));
      IF result->>'status' NOT IN ('200','201') THEN RETURN result; END IF;
      p_id:=(result#>>'{question,id}')::uuid;
      IF schedule AND (NOT EXISTS(SELECT 1 FROM questions WHERE id=p_id AND btrim(content)<>'') OR (SELECT count(*) FROM question_options WHERE question_id=p_id)<2 OR EXISTS(SELECT 1 FROM question_options WHERE question_id=p_id AND btrim(content)='')) THEN abort_reply:=jsonb_build_object('status',400,'error','ready');RAISE EXCEPTION USING ERRCODE='P0001'; END IF;
      UPDATE questions SET start_mode=mode,starts_at=start_at,start_after_seconds=duration,scheduled_at=CASE WHEN state='open' THEN NULL ELSE armed END WHERE id=p_id;
      RETURN jsonb_build_object('status',CASE WHEN p_action='create' THEN 201 ELSE 200 END,'question',vm_question_data(p_id));
    EXCEPTION WHEN raise_exception THEN RETURN abort_reply;
      WHEN check_violation OR invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN RETURN jsonb_build_object('status',400,'error','invalid');
    END;
    $$;
    CREATE OR REPLACE FUNCTION vm_question_request(p_room uuid,p_admin bytea,p_id uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; page jsonb;
    BEGIN
      IF p_action IN ('create','save') AND p_data ? 'startMode' THEN result:=vm_store_question(p_room,p_admin,p_id,p_action,p_data);
      ELSE result:=vm_question_request_before_review(p_room,p_admin,p_id,p_action,p_data); END IF;
      IF result->>'status' IN ('200','201') THEN
        IF result ? 'questions' THEN
          SELECT COALESCE(jsonb_agg(item||vm_admin_question_metrics((item->>'id')::uuid) ORDER BY position),'[]') INTO page FROM jsonb_array_elements(result->'questions') WITH ORDINALITY e(item,position);
          result:=jsonb_set(result,'{questions}',page);
        ELSIF result ? 'question' THEN result:=jsonb_set(result,'{question}',result->'question'||vm_admin_question_metrics((result#>>'{question,id}')::uuid)); END IF;
      END IF;
      RETURN result;
    END;
    $$;
    CREATE OR REPLACE FUNCTION vm_question_lifecycle(p_room uuid,p_admin bytea,p_id uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE saved questions;
    BEGIN
      IF p_data->>'action'<>'cancel_start' THEN RETURN vm_question_lifecycle_before_review(p_room,p_admin,p_id,p_data); END IF;
      PERFORM 1 FROM rooms WHERE id=p_room AND EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      SELECT * INTO saved FROM questions WHERE id=p_id AND room_id=p_room FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      IF p_data->>'revision' IS DISTINCT FROM saved.revision::text THEN RETURN jsonb_build_object('status',409,'error','conflict'); END IF;
      UPDATE questions SET scheduled_at=NULL WHERE id=p_id;
      RETURN jsonb_build_object('status',200,'question',vm_question_data(p_id));
    END;
    $$;
    CREATE OR REPLACE FUNCTION vm_reset_question(p_room uuid,p_admin bytea,p_id uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb;
    BEGIN
      result:=vm_reset_question_before_review(p_room,p_admin,p_id,p_data);
      IF result->>'status'='200' THEN
        UPDATE questions SET scheduled_at=NULL WHERE id=p_id;
        result:=jsonb_set(result,'{question}',vm_question_data(p_id));
      END IF;
      RETURN result;
    END;
    $$;
    CREATE OR REPLACE FUNCTION vm_close_due() RETURNS integer LANGUAGE plpgsql AS $$
    DECLARE owner uuid; question questions; changed integer:=0; amount integer;
    BEGIN
      FOR owner IN SELECT r.id FROM rooms r WHERE EXISTS(SELECT 1 FROM questions q WHERE q.room_id=r.id AND ((q.state='open' AND q.closes_at<=clock_timestamp()) OR q.scheduled_at<=clock_timestamp())) ORDER BY r.id FOR UPDATE SKIP LOCKED LIMIT 25 LOOP
        FOR question IN SELECT * FROM questions WHERE room_id=owner AND scheduled_at<=clock_timestamp() ORDER BY scheduled_at,ordinal FOR UPDATE LOOP
          IF question.deadline_mode='absolute' AND question.closes_at<=clock_timestamp() THEN
            UPDATE questions SET scheduled_at=NULL,state='closed' WHERE id=question.id;
            UPDATE questions SET closed_reason='deadline',closed_at=closes_at WHERE id=question.id;
          ELSE UPDATE questions SET scheduled_at=NULL,state='open' WHERE id=question.id; END IF;
          changed:=changed+1;
        END LOOP;
        UPDATE questions SET state='closed' WHERE room_id=owner AND state='open' AND closes_at<=clock_timestamp();
        GET DIAGNOSTICS amount=ROW_COUNT;changed:=changed+amount;
      END LOOP;
      DELETE FROM question_views WHERE seen_at<=clock_timestamp()-interval '35 seconds';
      RETURN changed;
    END;
    $$;

    DO $$ DECLARE definition text; BEGIN
      definition:=pg_get_functiondef('vm_participant_journey(uuid,bytea,jsonb)'::regprocedure);
      definition:=replace(definition,$patch$FROM questions q WHERE q.room_id = owner AND q.first_opened_at IS NOT NULL AND q.state<>'draft'
          AND (vm_effective_state(q.id) = 'open' OR EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = q.id AND b.link_id = p_link AND (b.run_id IS NOT DISTINCT FROM run_uuid)))
          AND (after_time$patch$,$patch$FROM questions q WHERE q.room_id = owner AND (q.scheduled_at IS NOT NULL OR (q.first_opened_at IS NOT NULL AND q.state<>'draft'
          AND (vm_effective_state(q.id) = 'open' OR EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = q.id AND b.link_id = p_link AND (b.run_id IS NOT DISTINCT FROM run_uuid)))))
          AND (after_time$patch$);
      EXECUTE replace(definition,'FUNCTION public.vm_participant_journey(','FUNCTION public.vm_journey_with_starts(');
    END $$;
    CREATE OR REPLACE FUNCTION vm_participant_journey(p_link uuid,p_session bytea,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; owner uuid; run uuid; upcoming jsonb;
    BEGIN
      result:=vm_journey_with_starts(p_link,p_session,p_data);
      IF result->>'status'<>'200' THEN RETURN result; END IF;
      SELECT room_id INTO owner FROM vm_voting_access(p_link,p_session);
      run:=(result#>>'{run,id}')::uuid;
      SELECT jsonb_build_object('id',id,'preview',left(content,240),'scheduledAt',scheduled_at) INTO upcoming FROM questions WHERE room_id=owner AND scheduled_at IS NOT NULL ORDER BY scheduled_at,ordinal LIMIT 1;
      RETURN result||jsonb_build_object('upcoming',upcoming,'resultsAvailable',EXISTS(SELECT 1 FROM questions q WHERE q.room_id=owner AND vm_results_allowed(q.id,p_link,run,false)));
    END;
    $$;
    CREATE OR REPLACE FUNCTION vm_results(p_identity uuid,p_session bytea,p_admin boolean,p_question uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; sources jsonb; people jsonb;
    BEGIN
      result:=vm_results_before_review(p_identity,p_session,p_admin,p_question,p_data);
      IF result#>'{result,sources}' IS NOT NULL THEN
        sources:=result#>'{result,sources}';
        result:=jsonb_set(result,'{result,sources}',(sources-'admin_personal')||jsonb_build_object('personal',(sources->>'personal')::bigint+(sources->>'admin_personal')::bigint));
      END IF;
      IF result#>'{result,people}' IS NOT NULL THEN
        SELECT COALESCE(jsonb_agg(CASE WHEN item->>'source'='admin_personal' THEN item||jsonb_build_object('source','personal') ELSE item END ORDER BY position),'[]') INTO people FROM jsonb_array_elements(result#>'{result,people}') WITH ORDINALITY e(item,position);
        result:=jsonb_set(result,'{result,people}',people);
      END IF;
      RETURN result;
    END;
    $$;
    DO $$ DECLARE definition text; BEGIN
      definition:=pg_get_functiondef('vm_event_state(uuid,bytea,boolean)'::regprocedure);
      definition:=replace(definition,$patch$'room',(SELECT revision::text FROM rooms WHERE id=owner),$patch$,$patch$'metrics',CASE WHEN p_admin THEN (SELECT jsonb_agg(jsonb_build_array(id,vm_admin_question_metrics(id)) ORDER BY ordinal) FROM questions WHERE room_id=owner) END,
        'room',(SELECT revision::text FROM rooms WHERE id=owner),$patch$);
      EXECUTE replace(definition,$patch$(p_admin OR (q.first_opened_at$patch$,$patch$(p_admin OR q.scheduled_at IS NOT NULL OR (q.first_opened_at$patch$);
    END $$;
    REVOKE ALL ON FUNCTION vm_view_signal(),vm_question_viewers(uuid),vm_admin_question_metrics(uuid),vm_question_presence(uuid,bytea,jsonb),vm_journey_with_starts(uuid,bytea,jsonb) FROM PUBLIC;
  `);
}
// Refuse to discard an armed start during rollback
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM questions WHERE scheduled_at IS NOT NULL) THEN RAISE EXCEPTION 'Cancel scheduled starts before rollback'; END IF; END $$;
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_store_question_before_review(uuid,bytea,uuid,text,jsonb)','vm_effective_state_before_review(uuid)','vm_lifecycle_data_before_review(uuid)','vm_question_request_before_review(uuid,bytea,uuid,text,jsonb)','vm_question_lifecycle_before_review(uuid,bytea,uuid,jsonb)','vm_close_due_before_review()','vm_reset_question_before_review(uuid,bytea,uuid,jsonb)','vm_participant_journey_before_review(uuid,bytea,jsonb)','vm_results_before_review(uuid,bytea,boolean,uuid,jsonb)','vm_event_state_before_review(uuid,bytea,boolean)'] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||replace(name,'_before_review','')||'(');
        EXECUTE 'DROP FUNCTION '||signature;
      END LOOP;
    END $$;
    DROP FUNCTION vm_journey_with_starts(uuid,bytea,jsonb),vm_admin_question_metrics(uuid),vm_question_viewers(uuid),vm_question_presence(uuid,bytea,jsonb);
    DROP TABLE question_views;
    DROP FUNCTION vm_view_signal();
    ALTER TABLE questions DROP COLUMN scheduled_at,DROP COLUMN starts_at,DROP COLUMN start_after_seconds,DROP COLUMN start_mode;
  `);
}
