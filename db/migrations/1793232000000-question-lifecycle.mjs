// Add shared lifecycle rules and restart-safe deadline work
export function up(pgm) {
  pgm.sql(`
    ALTER TABLE questions ADD COLUMN closes_at timestamptz CHECK (isfinite(closes_at));
    ALTER TABLE questions ADD COLUMN closed_at timestamptz CHECK (isfinite(closed_at));
    ALTER TABLE questions ADD COLUMN closed_reason text CHECK (closed_reason IN ('manual','deadline'));
    CREATE INDEX questions_due ON questions(closes_at,room_id) WHERE state = 'open' AND closes_at IS NOT NULL;
    DO $$ DECLARE signature text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_question_data(uuid)','vm_question_guard()','vm_question_request(uuid,bytea,uuid,text,jsonb)'] LOOP
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.' || split_part(signature,'(',1) || '(', 'FUNCTION public.' || split_part(signature,'(',1) || '_pre8(');
      END LOOP;
    END $$;
    CREATE FUNCTION vm_effective_state(p_id uuid) RETURNS text LANGUAGE sql VOLATILE AS $$
      SELECT CASE WHEN state = 'open' AND closes_at <= clock_timestamp() THEN 'closed' ELSE state END FROM questions WHERE id = p_id;
    $$;
    CREATE FUNCTION vm_lifecycle_data(p_id uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
      SELECT jsonb_build_object('state',vm_effective_state(id),'closesAt',closes_at,'closedAt',CASE WHEN state = 'open' AND closes_at <= clock_timestamp() THEN closes_at ELSE closed_at END,'closedReason',CASE WHEN state = 'open' AND closes_at <= clock_timestamp() THEN 'deadline' ELSE closed_reason END) FROM questions WHERE id = p_id;
    $$;
    CREATE OR REPLACE FUNCTION vm_question_data(p_id uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
      SELECT vm_question_data_pre8(p_id) || vm_lifecycle_data(p_id);
    $$;
    DO $$ DECLARE definition text; BEGIN
      definition := pg_get_functiondef('vm_question_guard()'::regprocedure);
      definition := replace(definition,
        'NEW.share_results, NEW.publication, NEW.hide_results_until_end, NEW.allow_answer_change, NEW.anonymous',
        'NEW.hide_results_until_end, NEW.anonymous');
      definition := replace(definition,
        'OLD.share_results, OLD.publication, OLD.hide_results_until_end, OLD.allow_answer_change, OLD.anonymous',
        'OLD.hide_results_until_end, OLD.anonymous');
      definition := replace(definition,'NEW.revision := OLD.revision + 1;', $body$
        IF NEW.state = 'open' AND OLD.state <> 'open' THEN
          IF OLD.state NOT IN ('draft','closed') OR btrim(NEW.content) = '' OR
            (SELECT count(*) FROM question_options WHERE question_id = NEW.id) < 2 OR
            EXISTS (SELECT 1 FROM question_options WHERE question_id = NEW.id AND btrim(content) = '') OR
            NEW.closes_at <= clock_timestamp() THEN RAISE check_violation USING MESSAGE = 'Question is not ready'; END IF;
          NEW.closed_at := NULL; NEW.closed_reason := NULL;
        ELSIF NEW.state = 'closed' AND OLD.state = 'open' THEN
          NEW.closed_at := CASE WHEN OLD.closes_at <= clock_timestamp() THEN OLD.closes_at ELSE clock_timestamp() END;
          NEW.closed_reason := CASE WHEN OLD.closes_at <= clock_timestamp() THEN 'deadline' ELSE 'manual' END;
        ELSIF NEW.state IS DISTINCT FROM OLD.state THEN RAISE check_violation USING MESSAGE = 'Invalid transition';
        END IF;
        IF NEW.state = 'open' AND NEW.closes_at <= clock_timestamp() THEN
          NEW.state := 'closed'; NEW.closed_at := NEW.closes_at; NEW.closed_reason := 'deadline';
        END IF;
        NEW.revision := OLD.revision + 1;
      $body$);
      EXECUTE definition;
    END $$;
    CREATE OR REPLACE FUNCTION vm_question_request(p_room uuid,p_admin bytea,p_id uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; page jsonb;
    BEGIN
      result := vm_question_request_pre8(p_room,p_admin,p_id,p_action,p_data);
      IF p_action = 'list' AND result->>'status' = '200' THEN
        SELECT coalesce(jsonb_agg(item || vm_lifecycle_data((item->>'id')::uuid) ORDER BY position),'[]') INTO page
          FROM jsonb_array_elements(result->'questions') WITH ORDINALITY AS e(item,position);
        result := jsonb_set(result,'{questions}',page);
      END IF;
      RETURN result;
    END;
    $$;
    CREATE FUNCTION vm_question_lifecycle(p_room uuid,p_admin bytea,p_id uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE saved questions; deadline timestamptz; action text;
    BEGIN
      PERFORM 1 FROM rooms WHERE id = p_room AND EXISTS (SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      SELECT * INTO saved FROM questions WHERE id = p_id AND room_id = p_room FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      IF jsonb_typeof(p_data->'revision') IS DISTINCT FROM 'string' OR (p_data->>'revision') !~ '^(0|[1-9][0-9]{0,18})$' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      IF (p_data->>'revision')::bigint <> saved.revision THEN RETURN jsonb_build_object('status',409,'error','conflict'); END IF;
      action := p_data->>'action';
      deadline := saved.closes_at;
      IF p_data ? 'closesAt' THEN
        IF p_data->'closesAt' = 'null'::jsonb THEN deadline := NULL;
        ELSE
          IF jsonb_typeof(p_data->'closesAt') IS DISTINCT FROM 'string' OR (p_data->>'closesAt') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RETURN jsonb_build_object('status',400,'error','deadline'); END IF;
          deadline := (p_data->>'closesAt')::timestamptz;
          IF NOT isfinite(deadline) THEN RETURN jsonb_build_object('status',400,'error','deadline'); END IF;
        END IF;
      END IF;
      IF action = 'open' THEN
        IF saved.state NOT IN ('draft','closed') OR deadline <= clock_timestamp() THEN RETURN jsonb_build_object('status',409,'error','deadline'); END IF;
        UPDATE questions SET state = 'open',closes_at = deadline WHERE id = saved.id;
      ELSIF action = 'close' THEN
        IF saved.state <> 'open' THEN RETURN jsonb_build_object('status',409,'error','state'); END IF;
        UPDATE questions SET state = 'closed' WHERE id = saved.id;
      ELSIF action = 'settings' THEN
        IF saved.state = 'open' AND saved.closes_at <= clock_timestamp() THEN
          UPDATE questions SET state = 'closed' WHERE id = saved.id;
          RETURN jsonb_build_object('status',409,'error','state');
        END IF;
        IF jsonb_typeof(p_data->'shareResults') IS DISTINCT FROM 'boolean' OR p_data->>'publication' IS NULL OR p_data->>'publication' NOT IN ('after_answer','after_close') THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
        UPDATE questions SET closes_at = deadline,share_results = (p_data->>'shareResults')::boolean,publication = p_data->>'publication' WHERE id = saved.id;
      ELSE RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      RETURN jsonb_build_object('status',200,'question',vm_question_data(saved.id));
    EXCEPTION WHEN check_violation OR invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation OR numeric_value_out_of_range THEN
      RETURN jsonb_build_object('status',400,'error','ready');
    END;
    $$;
    CREATE FUNCTION vm_close_due() RETURNS integer LANGUAGE plpgsql AS $$
    DECLARE owner uuid; changed integer := 0; amount integer;
    BEGIN
      FOR owner IN SELECT r.id FROM rooms r WHERE EXISTS (SELECT 1 FROM questions q WHERE q.room_id = r.id AND q.state = 'open' AND q.closes_at <= clock_timestamp()) ORDER BY r.id FOR UPDATE SKIP LOCKED LIMIT 25 LOOP
        UPDATE questions SET state = 'closed' WHERE room_id = owner AND state = 'open' AND closes_at <= clock_timestamp();
        GET DIAGNOSTICS amount = ROW_COUNT; changed := changed + amount;
      END LOOP;
      RETURN changed;
    END;
    $$;
    REVOKE ALL ON FUNCTION vm_question_data_pre8(uuid),vm_question_guard_pre8(),vm_question_request_pre8(uuid,bytea,uuid,text,jsonb),vm_effective_state(uuid),vm_lifecycle_data(uuid),vm_question_lifecycle(uuid,bytea,uuid,jsonb),vm_close_due() FROM PUBLIC;
  `);
}

// Restore prior functions before removing deadline fields
export function down(pgm) {
  pgm.sql(`
    DO $$ DECLARE name text; signature text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_question_data_pre8(uuid)','vm_question_guard_pre8()','vm_question_request_pre8(uuid,bytea,uuid,text,jsonb)'] LOOP
        name := split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.' || name || '(', 'FUNCTION public.' || replace(name,'_pre8','') || '(');
      END LOOP;
    END $$;
    DROP FUNCTION vm_question_lifecycle(uuid,bytea,uuid,jsonb);
    DROP FUNCTION vm_close_due();
    DROP FUNCTION vm_lifecycle_data(uuid);
    DROP FUNCTION vm_effective_state(uuid);
    DROP FUNCTION vm_question_data_pre8(uuid),vm_question_guard_pre8(),vm_question_request_pre8(uuid,bytea,uuid,text,jsonb);
    ALTER TABLE questions DROP COLUMN closes_at,DROP COLUMN closed_at,DROP COLUMN closed_reason;
  `);
}
