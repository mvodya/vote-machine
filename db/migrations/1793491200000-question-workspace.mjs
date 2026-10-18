// Add shared room time zones and atomic question workspace changes
export function up(pgm) {
  pgm.sql(`
    ALTER TABLE rooms ADD COLUMN time_zone text;
    CREATE FUNCTION vm_valid_time_zone(p_zone text) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT p_zone IS NOT NULL AND char_length(p_zone) <= 100 AND EXISTS(SELECT 1 FROM pg_timezone_names WHERE name = p_zone);
    $$;
    ALTER TABLE rooms ADD CONSTRAINT room_time_zone CHECK(time_zone IS NULL OR vm_valid_time_zone(time_zone));
    CREATE FUNCTION vm_room_time_zone(p_room uuid,p_admin bytea,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE saved rooms;
    BEGIN
      SELECT r.* INTO saved FROM rooms r WHERE r.id = p_room AND EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF jsonb_typeof(p_data->'timeZone') IS DISTINCT FROM 'string' OR NOT vm_valid_time_zone(p_data->>'timeZone') THEN RETURN jsonb_build_object('status',400,'error','timeZone'); END IF;
      IF p_data->'initialize' = 'true'::jsonb AND saved.time_zone IS NOT NULL THEN NULL;
      ELSE
        IF p_data->'initialize' IS DISTINCT FROM 'true'::jsonb AND (jsonb_typeof(p_data->'revision') IS DISTINCT FROM 'string' OR p_data->>'revision' IS DISTINCT FROM saved.revision::text) THEN RETURN jsonb_build_object('status',409,'error','conflict'); END IF;
        UPDATE rooms SET time_zone = p_data->>'timeZone' WHERE id = p_room RETURNING * INTO saved;
      END IF;
      RETURN jsonb_build_object('status',200,'room',jsonb_build_object('id',saved.id,'name',saved.name,'createdAt',saved.created_at,'revision',saved.revision::text,'timeZone',saved.time_zone));
    END;
    $$;
    ALTER TABLE questions ADD COLUMN deadline_mode text NOT NULL DEFAULT 'none' CHECK(deadline_mode IN ('none','absolute','duration'));
    ALTER TABLE questions ADD COLUMN close_after_seconds integer CHECK(close_after_seconds > 0);
    ALTER TABLE questions ADD COLUMN opened_at timestamptz CHECK(isfinite(opened_at));
    ALTER TABLE questions ADD COLUMN deleting boolean NOT NULL DEFAULT false;
    UPDATE questions SET deadline_mode = CASE WHEN closes_at IS NULL THEN 'none' ELSE 'absolute' END,opened_at = first_opened_at;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    DO $$ DECLARE name text; BEGIN
      SELECT conname INTO name FROM pg_constraint WHERE conrelid = 'questions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%state%' AND pg_get_constraintdef(oid) LIKE '%first_opened_at%';
      EXECUTE format('ALTER TABLE questions DROP CONSTRAINT %I',name);
    END $$;
    ALTER TABLE questions ADD CONSTRAINT question_first_open_rule CHECK((first_opened_at IS NULL AND edit_locked IS NULL AND state IN ('draft','closed')) OR (first_opened_at IS NOT NULL AND edit_locked IS NOT NULL));
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_question_guard()','vm_option_guard()','vm_asset_ref_guard()','vm_ballot_guard()','vm_ballot_choice_guard()','vm_question_request(uuid,bytea,uuid,text,jsonb)','vm_question_lifecycle(uuid,bytea,uuid,jsonb)','vm_question_data(uuid)','vm_lifecycle_data(uuid)','vm_participant_journey(uuid,bytea,jsonb)','vm_participant_asset(uuid,bytea,uuid)','vm_personal_answer(uuid,bytea,uuid)'] LOOP
        name := split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.' || name || '(', 'FUNCTION public.' || name || '_before_workspace(');
      END LOOP;
    END $$;
    CREATE OR REPLACE FUNCTION vm_question_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'draft' OR NEW.first_opened_at IS NOT NULL OR NEW.edit_locked IS NOT NULL OR NEW.deleting THEN RAISE check_violation; END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' THEN
        IF NOT OLD.deleting THEN RAISE check_violation USING MESSAGE = 'Use question deletion'; END IF;
        RETURN OLD;
      END IF;
      IF ROW(NEW.id,NEW.room_id,NEW.ordinal,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.room_id,OLD.ordinal,OLD.created_at) THEN RAISE check_violation; END IF;
      IF OLD.first_opened_at IS NOT NULL AND (NEW.first_opened_at IS DISTINCT FROM OLD.first_opened_at OR NEW.edit_locked IS DISTINCT FROM OLD.edit_locked OR NEW.anonymous IS DISTINCT FROM OLD.anonymous) THEN RAISE check_violation USING MESSAGE = 'Opening promises cannot change'; END IF;
      IF OLD.edit_locked AND ROW(NEW.content,NEW.choice_mode,NEW.min_choices,NEW.max_choices,NEW.hide_results_until_end) IS DISTINCT FROM ROW(OLD.content,OLD.choice_mode,OLD.min_choices,OLD.max_choices,OLD.hide_results_until_end) THEN RAISE check_violation USING MESSAGE = 'Question is locked'; END IF;
      IF NEW.state = 'open' AND OLD.state <> 'open' THEN
        IF btrim(NEW.content) = '' OR (SELECT count(*) FROM question_options WHERE question_id = NEW.id) < 2 OR EXISTS(SELECT 1 FROM question_options WHERE question_id = NEW.id AND btrim(content) = '') THEN RAISE check_violation USING MESSAGE = 'Question is not ready'; END IF;
        NEW.opened_at := clock_timestamp();
        IF OLD.first_opened_at IS NULL THEN
          NEW.first_opened_at := NEW.opened_at;
          SELECT lock_questions_after_open INTO NEW.edit_locked FROM rooms WHERE id = NEW.room_id;
        END IF;
      END IF;
      IF NEW.deadline_mode = 'none' THEN NEW.closes_at := NULL; NEW.close_after_seconds := NULL;
      ELSIF NEW.deadline_mode = 'duration' THEN
        IF NEW.close_after_seconds IS NULL THEN RAISE check_violation; END IF;
        NEW.closes_at := CASE WHEN NEW.state = 'open' THEN NEW.opened_at + make_interval(secs => NEW.close_after_seconds) ELSE NULL END;
      ELSE NEW.close_after_seconds := NULL; END IF;
      IF NEW.state = 'open' AND NEW.closes_at <= clock_timestamp() THEN
        IF OLD.state <> 'open' THEN RAISE check_violation USING MESSAGE = 'Deadline must be in the future'; END IF;
        NEW.state := 'closed'; NEW.closed_at := NEW.closes_at; NEW.closed_reason := 'deadline';
      ELSIF NEW.state = 'closed' AND OLD.state <> 'closed' THEN
        NEW.closed_at := CASE WHEN OLD.state = 'open' AND OLD.closes_at <= clock_timestamp() THEN OLD.closes_at ELSE clock_timestamp() END;
        NEW.closed_reason := CASE WHEN OLD.state = 'open' AND OLD.closes_at <= clock_timestamp() THEN 'deadline' ELSE 'manual' END;
      ELSIF NEW.state <> 'closed' THEN NEW.closed_at := NULL; NEW.closed_reason := NULL;
      END IF;
      NEW.revision := OLD.revision + 1;
      RETURN NEW;
    END;
    $$;
    DO $$ DECLARE definition text; BEGIN
      definition := pg_get_functiondef('vm_option_guard()'::regprocedure);
      EXECUTE replace(definition,'IF FOUND AND owner.edit_locked THEN','IF FOUND AND owner.edit_locked AND NOT owner.deleting THEN');
      definition := pg_get_functiondef('vm_asset_ref_guard()'::regprocedure);
      EXECUTE replace(definition,'AND edit_locked)', 'AND edit_locked AND NOT deleting)');
      definition := pg_get_functiondef('vm_ballot_guard()'::regprocedure);
      EXECUTE replace(definition,'IF TG_OP = ''DELETE'' THEN RAISE', 'IF EXISTS(SELECT 1 FROM questions WHERE id = OLD.question_id AND deleting) THEN IF TG_OP = ''DELETE'' THEN RETURN OLD; END IF; RETURN NEW; END IF; IF TG_OP = ''DELETE'' THEN RAISE');
      definition := pg_get_functiondef('vm_ballot_choice_guard()'::regprocedure);
      EXECUTE replace(definition,'question := vm_ballot_lock', 'IF TG_OP = ''DELETE'' AND EXISTS(SELECT 1 FROM questions WHERE id = ballot.question_id AND deleting) THEN RETURN OLD; END IF; question := vm_ballot_lock');
    END $$;
    CREATE OR REPLACE FUNCTION vm_lifecycle_data(p_id uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
      SELECT vm_lifecycle_data_before_workspace(p_id) || jsonb_build_object('deadlineMode',deadline_mode,'closeAfterSeconds',close_after_seconds,'openedAt',opened_at) FROM questions WHERE id = p_id;
    $$;
    CREATE OR REPLACE FUNCTION vm_question_data(p_id uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
      SELECT vm_question_data_before_workspace(p_id) || vm_lifecycle_data(p_id);
    $$;
    CREATE FUNCTION vm_delete_question(p_room uuid,p_admin bytea,p_id uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE saved questions;
    BEGIN
      PERFORM 1 FROM rooms WHERE id = p_room AND EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      SELECT * INTO saved FROM questions WHERE id = p_id AND room_id = p_room FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      IF jsonb_typeof(p_data->'revision') IS DISTINCT FROM 'string' OR (p_data->>'revision') !~ '^(0|[1-9][0-9]{0,18})$' OR (p_data->>'revision')::numeric > 9223372036854775807 THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      IF p_data->>'revision' IS DISTINCT FROM saved.revision::text THEN RETURN jsonb_build_object('status',409,'error','conflict'); END IF;
      UPDATE questions SET deleting = true WHERE id = p_id;
      DELETE FROM vote_requests WHERE payload->>'questionId' = p_id::text AND link_id IN (SELECT id FROM voting_links WHERE room_id = p_room);
      DELETE FROM ballot_choices WHERE question_id = p_id;
      DELETE FROM ballots WHERE question_id = p_id;
      DELETE FROM question_asset_refs WHERE question_id = p_id;
      DELETE FROM questions WHERE id = p_id;
      RETURN jsonb_build_object('status',200,'deletedId',p_id);
    END;
    $$;
    CREATE FUNCTION vm_store_question(p_room uuid,p_admin bytea,p_id uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE saved questions; result jsonb; abort_reply jsonb; desired text; mode text; deadline timestamptz; duration integer; same_content boolean;
    BEGIN
      PERFORM 1 FROM rooms WHERE id = p_room AND EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF (p_data ? 'allowSkip' AND jsonb_typeof(p_data->'allowSkip') IS DISTINCT FROM 'boolean') OR NOT vm_valid_question_document(p_data) THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      IF p_action = 'save' THEN
        SELECT * INTO saved FROM questions WHERE id = p_id AND room_id = p_room FOR UPDATE;
        IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
        IF jsonb_typeof(p_data->'revision') IS DISTINCT FROM 'string' OR (p_data->>'revision') !~ '^(0|[1-9][0-9]{0,18})$' OR (p_data->>'revision')::numeric > 9223372036854775807 THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      IF p_data->>'revision' IS DISTINCT FROM saved.revision::text THEN RETURN jsonb_build_object('status',409,'error','conflict'); END IF;
      END IF;
      desired := COALESCE(p_data->>'state',saved.state,'draft');
      mode := COALESCE(p_data->>'deadlineMode',saved.deadline_mode,'none');
      IF desired NOT IN ('draft','open','closed') OR mode NOT IN ('none','absolute','duration') THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      IF saved.state = 'open' AND saved.closes_at <= clock_timestamp() AND desired = 'open' THEN RETURN jsonb_build_object('status',409,'error','state'); END IF;
      IF saved.first_opened_at IS NOT NULL AND (p_data->>'anonymous')::boolean IS DISTINCT FROM saved.anonymous THEN RETURN jsonb_build_object('status',409,'error','locked'); END IF;
      deadline := saved.closes_at;
      duration := saved.close_after_seconds;
      IF mode = 'absolute' THEN
        IF p_data ? 'closesAt' THEN
          IF jsonb_typeof(p_data->'closesAt') IS DISTINCT FROM 'string' OR (p_data->>'closesAt') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RETURN jsonb_build_object('status',400,'error','deadline'); END IF;
          deadline := (p_data->>'closesAt')::timestamptz;
        END IF;
        IF deadline IS NULL OR NOT isfinite(deadline) THEN RETURN jsonb_build_object('status',400,'error','deadline'); END IF;
      ELSIF mode = 'duration' THEN
        IF p_data ? 'closeAfterSeconds' THEN
          IF jsonb_typeof(p_data->'closeAfterSeconds') IS DISTINCT FROM 'number' OR (p_data->>'closeAfterSeconds') !~ '^[1-9][0-9]{0,9}$' THEN RETURN jsonb_build_object('status',400,'error','deadline'); END IF;
          duration := (p_data->>'closeAfterSeconds')::integer;
        END IF;
        IF duration IS NULL OR duration <= 0 THEN RETURN jsonb_build_object('status',400,'error','deadline'); END IF;
      END IF;
      IF saved.id IS NOT NULL THEN
        same_content := ROW(saved.content,saved.choice_mode,saved.min_choices,saved.max_choices) IS NOT DISTINCT FROM ROW(p_data->>'content',p_data->>'choiceMode',(p_data->>'minChoices')::integer,(p_data->>'maxChoices')::integer) AND (vm_question_data(saved.id)->'choices') = p_data->'choices';
        IF saved.edit_locked AND NOT same_content THEN RETURN jsonb_build_object('status',409,'error','locked'); END IF;
      END IF;
      IF NOT COALESCE(saved.edit_locked,false) THEN
        result := vm_question_request_before_workspace(p_room,p_admin,p_id,p_action,p_data);
        IF (result->>'status')::integer NOT IN (200,201) THEN RETURN result; END IF;
        p_id := (result#>>'{question,id}')::uuid;
      END IF;
      UPDATE questions SET share_results = (p_data->>'shareResults')::boolean,publication = p_data->>'publication',allow_skip = COALESCE((p_data->>'allowSkip')::boolean,false),allow_answer_change = (p_data->>'allowAnswerChange')::boolean,hide_results_until_end = (p_data->>'hideResultsUntilEnd')::boolean,anonymous = (p_data->>'anonymous')::boolean,
        deadline_mode = mode,closes_at = CASE WHEN mode = 'absolute' THEN deadline ELSE NULL END,close_after_seconds = CASE WHEN mode = 'duration' THEN duration ELSE NULL END,state = desired WHERE id = p_id;
      IF desired = 'open' AND (SELECT state FROM questions WHERE id = p_id) = 'open' AND EXISTS(SELECT 1 FROM question_options WHERE question_id = p_id AND btrim(content) = '') THEN abort_reply := jsonb_build_object('status',400,'error','ready'); RAISE EXCEPTION USING ERRCODE = 'P0001'; END IF;
      RETURN jsonb_build_object('status',CASE WHEN p_action = 'create' THEN 201 ELSE 200 END,'question',vm_question_data(p_id));
    EXCEPTION WHEN raise_exception THEN RETURN abort_reply;
      WHEN check_violation THEN RETURN jsonb_build_object('status',400,'error','ready');
      WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN RETURN jsonb_build_object('status',400,'error','invalid');
    END;
    $$;
    CREATE OR REPLACE FUNCTION vm_question_request(p_room uuid,p_admin bytea,p_id uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
      IF p_action = 'delete' THEN RETURN vm_delete_question(p_room,p_admin,p_id,p_data); END IF;
      IF p_action IN ('create','save') AND (p_data ? 'state' OR p_data ? 'deadlineMode') THEN RETURN vm_store_question(p_room,p_admin,p_id,p_action,p_data); END IF;
      RETURN vm_question_request_before_workspace(p_room,p_admin,p_id,p_action,p_data);
    END;
    $$;
    CREATE OR REPLACE FUNCTION vm_question_lifecycle(p_room uuid,p_admin bytea,p_id uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE saved questions; document jsonb; target text;
    BEGIN
      PERFORM 1 FROM rooms WHERE id = p_room AND EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      SELECT * INTO saved FROM questions WHERE id = p_id AND room_id = p_room FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      IF jsonb_typeof(p_data->'revision') IS DISTINCT FROM 'string' OR (p_data->>'revision') !~ '^(0|[1-9][0-9]{0,18})$' OR (p_data->>'revision')::numeric > 9223372036854775807 THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      IF p_data->>'revision' IS DISTINCT FROM saved.revision::text THEN RETURN jsonb_build_object('status',409,'error','conflict'); END IF;
      target := CASE p_data->>'action' WHEN 'open' THEN 'open' WHEN 'close' THEN 'closed' WHEN 'draft' THEN 'draft' WHEN 'settings' THEN saved.state ELSE NULL END;
      IF target IS NULL THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      IF p_data->>'action' = 'open' AND saved.state = 'open' THEN RETURN jsonb_build_object('status',409,'error','state'); END IF;
      IF p_data->>'action' = 'close' AND saved.state <> 'open' THEN RETURN jsonb_build_object('status',409,'error','state'); END IF;
      document := vm_question_data(p_id) || jsonb_build_object('revision',saved.revision::text,'state',target,'assetRefs',COALESCE((SELECT jsonb_agg(jsonb_build_object('position',COALESCE(o.position,-1),'assetId',ref.asset_id)) FROM question_asset_refs ref LEFT JOIN question_options o ON o.id = ref.option_id WHERE ref.question_id = p_id),'[]'));
      IF p_data ? 'closesAt' AND NOT p_data ? 'deadlineMode' THEN document := document || jsonb_build_object('deadlineMode',CASE WHEN p_data->'closesAt' = 'null'::jsonb THEN 'none' ELSE 'absolute' END); END IF;
      document := document || (p_data - 'action' - 'revision');
      IF p_data->>'action' = 'open' AND document->>'deadlineMode' = 'absolute' AND (document->>'closesAt')::timestamptz <= clock_timestamp() THEN RETURN jsonb_build_object('status',409,'error','deadline'); END IF;
      RETURN vm_store_question(p_room,p_admin,p_id,'save',document);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN RETURN jsonb_build_object('status',400,'error','invalid');
    END;
    $$;
    DO $$ DECLARE definition text; BEGIN
      definition := pg_get_functiondef('vm_participant_journey(uuid,bytea,jsonb)'::regprocedure);
      definition := replace(definition,'q.first_opened_at IS NOT NULL','q.first_opened_at IS NOT NULL AND q.state <> ''draft''');
      definition := replace(definition,$patch$RETURN jsonb_build_object('status',200,'questions',page$patch$,$patch$RETURN jsonb_build_object('timeZone',COALESCE((SELECT time_zone FROM rooms WHERE id = owner),'UTC')) || jsonb_build_object('status',200,'questions',page$patch$);
      EXECUTE definition;
      definition := pg_get_functiondef('vm_participant_asset(uuid,bytea,uuid)'::regprocedure);
      EXECUTE replace(definition,'q.first_opened_at IS NOT NULL','q.first_opened_at IS NOT NULL AND q.state <> ''draft''');
      definition := pg_get_functiondef('vm_personal_answer(uuid,bytea,uuid)'::regprocedure);
      EXECUTE replace(definition,'first_opened_at IS NOT NULL','first_opened_at IS NOT NULL AND state <> ''draft''');
    END $$;
    REVOKE ALL ON FUNCTION vm_valid_time_zone(text),vm_room_time_zone(uuid,bytea,jsonb),vm_store_question(uuid,bytea,uuid,text,jsonb),vm_delete_question(uuid,bytea,uuid,jsonb) FROM PUBLIC;
    REVOKE ALL ON FUNCTION vm_question_guard_before_workspace(),vm_option_guard_before_workspace(),vm_asset_ref_guard_before_workspace(),vm_ballot_guard_before_workspace(),vm_ballot_choice_guard_before_workspace(),vm_question_request_before_workspace(uuid,bytea,uuid,text,jsonb),vm_question_lifecycle_before_workspace(uuid,bytea,uuid,jsonb),vm_question_data_before_workspace(uuid),vm_lifecycle_data_before_workspace(uuid),vm_participant_journey_before_workspace(uuid,bytea,jsonb),vm_participant_asset_before_workspace(uuid,bytea,uuid),vm_personal_answer_before_workspace(uuid,bytea,uuid) FROM PUBLIC;
  `);
}

// Restore prior rules after moving hidden drafts back to closed state
export function down(pgm) {
  pgm.sql(`
    UPDATE questions SET state = 'draft' WHERE state = 'closed' AND first_opened_at IS NULL;
    UPDATE questions SET state = 'closed' WHERE state = 'draft' AND first_opened_at IS NOT NULL;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_question_guard_before_workspace()','vm_option_guard_before_workspace()','vm_asset_ref_guard_before_workspace()','vm_ballot_guard_before_workspace()','vm_ballot_choice_guard_before_workspace()','vm_question_request_before_workspace(uuid,bytea,uuid,text,jsonb)','vm_question_lifecycle_before_workspace(uuid,bytea,uuid,jsonb)','vm_question_data_before_workspace(uuid)','vm_lifecycle_data_before_workspace(uuid)','vm_participant_journey_before_workspace(uuid,bytea,jsonb)','vm_participant_asset_before_workspace(uuid,bytea,uuid)','vm_personal_answer_before_workspace(uuid,bytea,uuid)'] LOOP
        name := split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.' || name || '(', 'FUNCTION public.' || replace(name,'_before_workspace','') || '(');
      END LOOP;
    END $$;
    DROP FUNCTION vm_store_question(uuid,bytea,uuid,text,jsonb),vm_delete_question(uuid,bytea,uuid,jsonb),vm_room_time_zone(uuid,bytea,jsonb);
    ALTER TABLE rooms DROP COLUMN time_zone;
    DROP FUNCTION vm_valid_time_zone(text);
    ALTER TABLE questions DROP CONSTRAINT question_first_open_rule;
    ALTER TABLE questions ADD CONSTRAINT question_first_open_rule CHECK((state = 'draft' AND first_opened_at IS NULL AND edit_locked IS NULL) OR (state <> 'draft' AND first_opened_at IS NOT NULL AND edit_locked IS NOT NULL));
    ALTER TABLE questions DROP COLUMN deadline_mode,DROP COLUMN close_after_seconds,DROP COLUMN opened_at,DROP COLUMN deleting;
    DROP FUNCTION vm_question_guard_before_workspace(),vm_option_guard_before_workspace(),vm_asset_ref_guard_before_workspace(),vm_ballot_guard_before_workspace(),vm_ballot_choice_guard_before_workspace(),vm_question_request_before_workspace(uuid,bytea,uuid,text,jsonb),vm_question_lifecycle_before_workspace(uuid,bytea,uuid,jsonb),vm_question_data_before_workspace(uuid),vm_lifecycle_data_before_workspace(uuid),vm_participant_journey_before_workspace(uuid,bytea,jsonb),vm_participant_asset_before_workspace(uuid,bytea,uuid),vm_personal_answer_before_workspace(uuid,bytea,uuid);
  `);
}
