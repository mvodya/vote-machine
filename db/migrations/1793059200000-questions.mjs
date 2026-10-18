// Add draft storage and shared question rules
export function up(pgm) {
  pgm.sql(`
    ALTER TABLE rooms ADD COLUMN lock_questions_after_open boolean NOT NULL DEFAULT true;

    CREATE TABLE questions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
      ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      content text NOT NULL DEFAULT '' CHECK (char_length(content) <= 20000),
      state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'open', 'closed')),
      choice_mode text NOT NULL DEFAULT 'single' CHECK (choice_mode IN ('single', 'multiple')),
      min_choices integer NOT NULL DEFAULT 1 CHECK (min_choices BETWEEN 1 AND 100),
      max_choices integer NOT NULL DEFAULT 1 CHECK (max_choices BETWEEN min_choices AND 100),
      share_results boolean NOT NULL DEFAULT false,
      publication text NOT NULL DEFAULT 'after_close' CHECK (publication IN ('after_answer', 'after_close')),
      hide_results_until_end boolean NOT NULL DEFAULT false,
      allow_answer_change boolean NOT NULL DEFAULT false,
      anonymous boolean NOT NULL DEFAULT false,
      edit_locked boolean,
      first_opened_at timestamptz CHECK (isfinite(first_opened_at)),
      created_at timestamptz NOT NULL DEFAULT statement_timestamp() CHECK (isfinite(created_at)),
      revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
      UNIQUE(id, room_id),
      CHECK (choice_mode <> 'single' OR (min_choices = 1 AND max_choices = 1)),
      CHECK ((state = 'draft' AND first_opened_at IS NULL AND edit_locked IS NULL) OR (state <> 'draft' AND first_opened_at IS NOT NULL AND edit_locked IS NOT NULL))
    );
    CREATE INDEX questions_room_order ON questions(room_id, created_at, ordinal);
    CREATE TABLE question_options (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      question_id uuid NOT NULL,
      room_id uuid NOT NULL,
      position integer NOT NULL CHECK (position BETWEEN 0 AND 99),
      content text NOT NULL DEFAULT '' CHECK (char_length(content) <= 5000),
      FOREIGN KEY (question_id, room_id) REFERENCES questions(id, room_id) ON DELETE CASCADE,
      UNIQUE(question_id, position) DEFERRABLE INITIALLY DEFERRED
    );

    CREATE FUNCTION vm_valid_question_document(p_data jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE item jsonb; seen uuid[] := '{}'; option_id uuid; amount integer;
    BEGIN
      IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR jsonb_typeof(p_data->'content') IS DISTINCT FROM 'string' OR char_length(p_data->>'content') > 20000 THEN RETURN false; END IF;
      IF jsonb_typeof(p_data->'choices') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      amount := jsonb_array_length(p_data->'choices');
      IF amount > 100 THEN RETURN false; END IF;
      IF p_data->>'choiceMode' IS NULL OR p_data->>'choiceMode' NOT IN ('single', 'multiple') THEN RETURN false; END IF;
      IF jsonb_typeof(p_data->'minChoices') IS DISTINCT FROM 'number' OR jsonb_typeof(p_data->'maxChoices') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
      IF (p_data->>'minChoices') !~ '^[0-9]{1,3}$' OR (p_data->>'maxChoices') !~ '^[0-9]{1,3}$' THEN RETURN false; END IF;
      IF (p_data->>'minChoices')::integer NOT BETWEEN 1 AND (p_data->>'maxChoices')::integer OR (p_data->>'maxChoices')::integer > greatest(amount, 1) THEN RETURN false; END IF;
      IF p_data->>'choiceMode' = 'single' AND ((p_data->>'minChoices')::integer <> 1 OR (p_data->>'maxChoices')::integer <> 1) THEN RETURN false; END IF;
      IF EXISTS (SELECT 1 FROM unnest(ARRAY['shareResults','hideResultsUntilEnd','allowAnswerChange','anonymous']) field WHERE jsonb_typeof(p_data->field) IS DISTINCT FROM 'boolean') THEN RETURN false; END IF;
      IF p_data->>'publication' IS NULL OR p_data->>'publication' NOT IN ('after_answer','after_close') THEN RETURN false; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(p_data->'choices') LOOP
        IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR jsonb_typeof(item->'content') IS DISTINCT FROM 'string' OR char_length(item->>'content') > 5000 THEN RETURN false; END IF;
        IF item ? 'id' THEN
          IF jsonb_typeof(item->'id') IS DISTINCT FROM 'string' OR (item->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
          option_id := (item->>'id')::uuid;
          IF option_id = ANY(seen) THEN RETURN false; END IF;
          seen := array_append(seen, option_id);
        END IF;
      END LOOP;
      RETURN true;
    END;
    $$;

    CREATE FUNCTION vm_question_data(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT jsonb_build_object(
        'id', q.id, 'roomId', q.room_id, 'content', q.content, 'preview', left(q.content, 240),
        'state', q.state, 'ordinal', q.ordinal::text, 'revision', q.revision::text,
        'createdAt', to_char(q.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'editLocked', q.edit_locked, 'choiceMode', q.choice_mode, 'minChoices', q.min_choices, 'maxChoices', q.max_choices,
        'shareResults', q.share_results, 'publication', q.publication, 'hideResultsUntilEnd', q.hide_results_until_end,
        'allowAnswerChange', q.allow_answer_change, 'anonymous', q.anonymous,
        'choiceCount', (SELECT count(*) FROM question_options o WHERE o.question_id = q.id),
        'choices', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', o.id, 'content', o.content) ORDER BY o.position) FROM question_options o WHERE o.question_id = q.id), '[]'::jsonb)
      ) FROM questions q WHERE q.id = p_id;
    $$;
    CREATE FUNCTION vm_question_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'draft' OR NEW.first_opened_at IS NOT NULL OR NEW.edit_locked IS NOT NULL THEN RAISE check_violation; END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' THEN
        IF OLD.state <> 'draft' OR OLD.first_opened_at IS NOT NULL THEN RAISE check_violation USING MESSAGE = 'Only drafts can be deleted'; END IF;
        RETURN OLD;
      END IF;
      IF OLD.first_opened_at IS NULL AND NEW.state <> 'draft' THEN
        NEW.first_opened_at := statement_timestamp();
        SELECT lock_questions_after_open INTO NEW.edit_locked FROM rooms WHERE id = OLD.room_id;
      END IF;
      IF NEW.id <> OLD.id OR NEW.room_id <> OLD.room_id OR NEW.ordinal <> OLD.ordinal OR NEW.created_at <> OLD.created_at THEN RAISE check_violation USING MESSAGE = 'Question identity cannot change'; END IF;
      IF OLD.first_opened_at IS NOT NULL AND (NEW.first_opened_at IS DISTINCT FROM OLD.first_opened_at OR NEW.edit_locked IS DISTINCT FROM OLD.edit_locked) THEN RAISE check_violation USING MESSAGE = 'Opened question policy cannot change'; END IF;
      IF OLD.edit_locked AND ROW(NEW.content, NEW.choice_mode, NEW.min_choices, NEW.max_choices, NEW.share_results, NEW.publication, NEW.hide_results_until_end, NEW.allow_answer_change, NEW.anonymous) IS DISTINCT FROM ROW(OLD.content, OLD.choice_mode, OLD.min_choices, OLD.max_choices, OLD.share_results, OLD.publication, OLD.hide_results_until_end, OLD.allow_answer_change, OLD.anonymous) THEN RAISE check_violation USING MESSAGE = 'Question is locked'; END IF;
      IF OLD.first_opened_at IS NOT NULL AND NEW.anonymous IS DISTINCT FROM OLD.anonymous THEN RAISE check_violation USING MESSAGE = 'Anonymity cannot change after opening'; END IF;
      NEW.revision := OLD.revision + 1;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER question_guard BEFORE INSERT OR UPDATE OR DELETE ON questions FOR EACH ROW EXECUTE FUNCTION vm_question_guard();

    CREATE FUNCTION vm_option_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE owner questions; question uuid;
    BEGIN
      IF TG_OP = 'DELETE' THEN question := OLD.question_id; ELSE question := NEW.question_id; END IF;
      SELECT * INTO owner FROM questions WHERE id = question FOR UPDATE;
      IF FOUND AND owner.edit_locked THEN RAISE check_violation USING MESSAGE = 'Question is locked'; END IF;
      IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.question_id <> OLD.question_id OR NEW.room_id <> OLD.room_id) THEN RAISE check_violation USING MESSAGE = 'Option ownership cannot change'; END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER option_guard BEFORE INSERT OR UPDATE OR DELETE ON question_options FOR EACH ROW EXECUTE FUNCTION vm_option_guard();

    CREATE FUNCTION vm_question_choices_check() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE question uuid; owner questions; amount bigint; last_position integer;
    BEGIN
      IF TG_TABLE_NAME = 'questions' THEN question := NEW.id;
      ELSIF TG_OP = 'DELETE' THEN question := OLD.question_id; ELSE question := NEW.question_id; END IF;
      SELECT * INTO owner FROM questions WHERE id = question;
      IF NOT FOUND THEN RETURN NULL; END IF;
      SELECT count(*), max(position) INTO amount, last_position FROM question_options WHERE question_id = question;
      IF amount > 100 OR owner.max_choices > greatest(amount, 1) OR coalesce(last_position, -1) <> amount - 1 THEN RAISE check_violation USING MESSAGE = 'Invalid question choices'; END IF;
      RETURN NULL;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER question_choices_check AFTER INSERT OR UPDATE ON questions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vm_question_choices_check();
    CREATE CONSTRAINT TRIGGER option_choices_check AFTER INSERT OR UPDATE OR DELETE ON question_options DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vm_question_choices_check();

    CREATE FUNCTION vm_options_touch() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE questions q SET revision = q.revision WHERE q.id IN (SELECT question_id FROM changed_options);
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER options_inserted AFTER INSERT ON question_options REFERENCING NEW TABLE AS changed_options FOR EACH STATEMENT EXECUTE FUNCTION vm_options_touch();
    CREATE TRIGGER options_updated AFTER UPDATE ON question_options REFERENCING NEW TABLE AS changed_options FOR EACH STATEMENT EXECUTE FUNCTION vm_options_touch();
    CREATE TRIGGER options_deleted AFTER DELETE ON question_options REFERENCING OLD TABLE AS changed_options FOR EACH STATEMENT EXECUTE FUNCTION vm_options_touch();

    CREATE FUNCTION vm_question_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE changed questions;
    BEGIN
      IF TG_OP = 'DELETE' THEN changed := OLD; changed.revision := OLD.revision + 1; ELSE changed := NEW; END IF;
      PERFORM pg_notify('question_changes', json_build_object('roomId', changed.room_id, 'questionId', changed.id, 'revision', changed.revision::text, 'deleted', TG_OP = 'DELETE')::text);
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER question_changed AFTER INSERT OR UPDATE OR DELETE ON questions FOR EACH ROW EXECUTE FUNCTION vm_question_changed();

    CREATE FUNCTION vm_question_request(p_room uuid, p_admin bytea, p_id uuid, p_action text, p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE saved questions; item jsonb; normalized jsonb := '[]'; option_ids uuid[] := '{}'; option_id uuid; after_time timestamptz; after_key bigint; page jsonb; next_cursor text;
    BEGIN
      IF p_action IN ('list','get','policy') THEN
        PERFORM 1 FROM vm_admin_room(p_room, p_admin);
      ELSE
        PERFORM 1 FROM rooms r WHERE r.id = p_room AND EXISTS (SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
      END IF;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      IF p_action IN ('policy','setPolicy') THEN
        IF p_action = 'setPolicy' THEN
          IF jsonb_typeof(p_data->'lockAfterOpen') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_data->'revision') IS DISTINCT FROM 'string' OR (p_data->>'revision') !~ '^(0|[1-9][0-9]{0,18})$' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
          IF (p_data->>'revision')::bigint <> (SELECT revision FROM rooms WHERE id = p_room) THEN RETURN jsonb_build_object('status',409,'error','conflict'); END IF;
          UPDATE rooms SET lock_questions_after_open = (p_data->>'lockAfterOpen')::boolean WHERE id = p_room;
        END IF;
        RETURN (SELECT jsonb_build_object('status',200,'policy',jsonb_build_object('lockAfterOpen',lock_questions_after_open,'revision',revision::text)) FROM rooms WHERE id = p_room);
      END IF;
      IF p_action = 'list' THEN
        IF p_data->>'after' IS DISTINCT FROM '0' THEN
          IF p_data->>'after' IS NULL OR (p_data->>'after') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}.[0-9]{6}Z~[1-9][0-9]{0,18}$' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
          after_time := split_part(p_data->>'after','~',1)::timestamptz;
          after_key := split_part(p_data->>'after','~',2)::bigint;
        END IF;
        WITH selected AS MATERIALIZED (
          SELECT q.*, (SELECT count(*) FROM question_options o WHERE o.question_id = q.id) AS choice_count
          FROM questions q WHERE q.room_id = p_room AND (after_time IS NULL OR (q.created_at,q.ordinal) > (after_time,after_key)) ORDER BY q.created_at,q.ordinal LIMIT 51
        ), visible AS (SELECT * FROM selected ORDER BY created_at,ordinal LIMIT 50)
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'roomId',room_id,'preview',left(content,240),'state',state,'ordinal',ordinal::text,'revision',revision::text,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'editLocked',edit_locked,'choiceMode',choice_mode,'choiceCount',choice_count) ORDER BY created_at,ordinal),'[]'),
          CASE WHEN (SELECT count(*) FROM selected) > 50 THEN (SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '~' || ordinal::text FROM visible ORDER BY created_at DESC,ordinal DESC LIMIT 1) END
          INTO page,next_cursor FROM visible;
        RETURN jsonb_build_object('status',200,'questions',page,'nextCursor',next_cursor);
      END IF;
      IF p_action <> 'create' THEN
        SELECT * INTO saved FROM questions WHERE id = p_id AND room_id = p_room FOR UPDATE;
        IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      END IF;
      IF p_action = 'get' THEN RETURN jsonb_build_object('status',200,'question',vm_question_data(saved.id)); END IF;
      IF p_action NOT IN ('create','save','delete') THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      IF p_action <> 'create' THEN
        IF jsonb_typeof(p_data->'revision') IS DISTINCT FROM 'string' OR (p_data->>'revision') !~ '^(0|[1-9][0-9]{0,18})$' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
        IF (p_data->>'revision')::bigint <> saved.revision THEN RETURN jsonb_build_object('status',409,'error','conflict'); END IF;
        IF saved.edit_locked THEN RETURN jsonb_build_object('status',409,'error','locked'); END IF;
      END IF;
      IF p_action = 'delete' THEN
        IF saved.state <> 'draft' THEN RETURN jsonb_build_object('status',409,'error','locked'); END IF;
        DELETE FROM questions WHERE id = saved.id;
        RETURN jsonb_build_object('status',200,'deletedId',saved.id);
      END IF;
      IF NOT vm_valid_question_document(p_data) THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      IF saved.first_opened_at IS NOT NULL AND (p_data->>'anonymous')::boolean <> saved.anonymous THEN RETURN jsonb_build_object('status',409,'error','locked'); END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(p_data->'choices') LOOP
        IF item ? 'id' THEN
          option_id := (item->>'id')::uuid;
          IF NOT EXISTS (SELECT 1 FROM question_options WHERE id = option_id AND question_id = saved.id AND room_id = p_room) THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
        ELSE option_id := gen_random_uuid(); END IF;
        option_ids := array_append(option_ids,option_id);
        normalized := normalized || jsonb_build_array(jsonb_build_object('id',option_id,'content',item->>'content'));
      END LOOP;
      IF p_action = 'create' THEN INSERT INTO questions(room_id) VALUES (p_room) RETURNING * INTO saved; END IF;
      UPDATE questions SET content = p_data->>'content', choice_mode = p_data->>'choiceMode', min_choices = (p_data->>'minChoices')::integer, max_choices = (p_data->>'maxChoices')::integer,
        share_results = (p_data->>'shareResults')::boolean, publication = p_data->>'publication', hide_results_until_end = (p_data->>'hideResultsUntilEnd')::boolean,
        allow_answer_change = (p_data->>'allowAnswerChange')::boolean, anonymous = (p_data->>'anonymous')::boolean WHERE id = saved.id;
      DELETE FROM question_options WHERE question_id = saved.id AND NOT (id = ANY(option_ids));
      INSERT INTO question_options(id,question_id,room_id,position,content)
        SELECT (value->>'id')::uuid,saved.id,p_room,(ordinality - 1)::integer,value->>'content' FROM jsonb_array_elements(normalized) WITH ORDINALITY
        ON CONFLICT(id) DO UPDATE SET position = EXCLUDED.position, content = EXCLUDED.content
        WHERE (question_options.position,question_options.content) IS DISTINCT FROM (EXCLUDED.position,EXCLUDED.content);
      RETURN jsonb_build_object('status',CASE WHEN p_action = 'create' THEN 201 ELSE 200 END,'question',vm_question_data(saved.id));
    EXCEPTION
      WHEN check_violation OR not_null_violation OR unique_violation OR invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN
        RETURN jsonb_build_object('status',400,'error','invalid');
      WHEN foreign_key_violation THEN RETURN jsonb_build_object('status',409,'error','locked');
    END;
    $$;
    REVOKE ALL ON FUNCTION vm_question_data(uuid), vm_valid_question_document(jsonb), vm_question_guard(), vm_option_guard(), vm_question_choices_check(), vm_options_touch(), vm_question_changed(), vm_question_request(uuid,bytea,uuid,text,jsonb) FROM PUBLIC;
  `);
}

// Remove only question objects and keep existing room and link access
export function down(pgm) {
  pgm.sql(`
    DROP FUNCTION vm_question_request(uuid,bytea,uuid,text,jsonb);
    DROP FUNCTION vm_question_data(uuid);
    DROP FUNCTION vm_valid_question_document(jsonb);
    DROP TABLE question_options;
    DROP TABLE questions;
    DROP FUNCTION vm_question_guard();
    DROP FUNCTION vm_option_guard();
    DROP FUNCTION vm_question_choices_check();
    DROP FUNCTION vm_options_touch();
    DROP FUNCTION vm_question_changed();
    ALTER TABLE rooms DROP COLUMN lock_questions_after_open;
  `);
}
