// Keep personal rights and retries in shared PostgreSQL state
export function up(pgm) {
  pgm.sql(`
    ALTER TABLE voting_links ADD CONSTRAINT link_room_owner UNIQUE(id,room_id);
    CREATE TABLE ballots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      room_id uuid NOT NULL,
      question_id uuid NOT NULL,
      link_id uuid NOT NULL,
      source text NOT NULL DEFAULT 'personal' CHECK (source = 'personal'),
      revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(updated_at)),
      created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
      FOREIGN KEY(question_id,room_id) REFERENCES questions(id,room_id) ON DELETE RESTRICT,
      FOREIGN KEY(link_id,room_id) REFERENCES voting_links(id,room_id) ON DELETE RESTRICT,
      UNIQUE(link_id,question_id), UNIQUE(id,question_id,room_id)
    );
    CREATE INDEX ballots_question ON ballots(question_id);
    CREATE TABLE ballot_choices (
      ballot_id uuid NOT NULL,
      question_id uuid NOT NULL,
      room_id uuid NOT NULL,
      option_id uuid NOT NULL,
      PRIMARY KEY(ballot_id,option_id),
      FOREIGN KEY(ballot_id,question_id,room_id) REFERENCES ballots(id,question_id,room_id) ON DELETE RESTRICT,
      FOREIGN KEY(option_id,question_id,room_id) REFERENCES question_options(id,question_id,room_id) ON DELETE RESTRICT
    );
    CREATE INDEX ballot_choices_option ON ballot_choices(option_id);
    CREATE TABLE vote_requests (
      link_id uuid NOT NULL REFERENCES voting_links(id) ON DELETE RESTRICT,
      request_id uuid NOT NULL,
      payload jsonb NOT NULL,
      response jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(link_id,request_id)
    );
    CREATE FUNCTION vm_ballot_lock(p_room uuid,p_question uuid,p_link uuid) RETURNS questions LANGUAGE plpgsql AS $$
    DECLARE question questions; link voting_links;
    BEGIN
      PERFORM 1 FROM rooms WHERE id = p_room FOR UPDATE;
      SELECT * INTO question FROM questions WHERE id = p_question AND room_id = p_room FOR UPDATE;
      IF NOT FOUND OR question.state <> 'open' OR question.closes_at <= clock_timestamp() THEN RAISE check_violation USING MESSAGE = 'Question is closed'; END IF;
      SELECT * INTO link FROM voting_links WHERE id = p_link AND room_id = p_room FOR SHARE;
      IF NOT FOUND OR link.revoked_at IS NOT NULL OR link.mode <> 'personal' THEN RAISE check_violation USING MESSAGE = 'Personal access required'; END IF;
      RETURN question;
    END;
    $$;
    CREATE FUNCTION vm_ballot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE question questions;
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE check_violation USING MESSAGE = 'Ballots cannot be deleted'; END IF;
      question := vm_ballot_lock(NEW.room_id,NEW.question_id,NEW.link_id);
      IF TG_OP = 'UPDATE' THEN
        IF ROW(NEW.id,NEW.room_id,NEW.question_id,NEW.link_id,NEW.source,NEW.created_at,NEW.created_xid) IS DISTINCT FROM ROW(OLD.id,OLD.room_id,OLD.question_id,OLD.link_id,OLD.source,OLD.created_at,OLD.created_xid) THEN RAISE check_violation; END IF;
        IF OLD.created_xid <> pg_current_xact_id() AND NOT question.allow_answer_change THEN RAISE check_violation USING MESSAGE = 'Answer is fixed'; END IF;
        NEW.revision := OLD.revision + 1;
        NEW.updated_at := clock_timestamp();
      ELSE
        NEW.created_xid := pg_current_xact_id(); NEW.revision := 0;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER ballot_guard BEFORE INSERT OR UPDATE OR DELETE ON ballots FOR EACH ROW EXECUTE FUNCTION vm_ballot_guard();
    CREATE FUNCTION vm_ballot_choice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE ballot ballots; question questions; target uuid;
    BEGIN
      IF TG_OP = 'UPDATE' THEN RAISE check_violation USING MESSAGE = 'Replace choices instead'; END IF;
      IF TG_OP = 'DELETE' THEN target := OLD.ballot_id; ELSE target := NEW.ballot_id; END IF;
      SELECT * INTO ballot FROM ballots WHERE id = target;
      IF NOT FOUND THEN RAISE foreign_key_violation; END IF;
      question := vm_ballot_lock(ballot.room_id,ballot.question_id,ballot.link_id);
      PERFORM 1 FROM ballots WHERE id = target FOR UPDATE;
      IF ballot.created_xid <> pg_current_xact_id() AND NOT question.allow_answer_change THEN RAISE check_violation USING MESSAGE = 'Answer is fixed'; END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER ballot_choice_guard BEFORE INSERT OR UPDATE OR DELETE ON ballot_choices FOR EACH ROW EXECUTE FUNCTION vm_ballot_choice_guard();
    CREATE FUNCTION vm_ballot_check() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target uuid; question questions; amount integer;
    BEGIN
      IF TG_TABLE_NAME = 'questions' THEN
        question := NEW;
        IF EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = question.id AND (SELECT count(*) FROM ballot_choices c WHERE c.ballot_id = b.id) NOT BETWEEN question.min_choices AND question.max_choices) THEN RAISE check_violation USING MESSAGE = 'Existing ballots must stay valid'; END IF;
        RETURN NULL;
      END IF;
      IF TG_TABLE_NAME = 'ballots' THEN target := NEW.id;
      ELSIF TG_OP = 'DELETE' THEN target := OLD.ballot_id; ELSE target := NEW.ballot_id; END IF;
      SELECT q.* INTO question FROM questions q JOIN ballots b ON b.question_id = q.id WHERE b.id = target;
      SELECT count(*) INTO amount FROM ballot_choices WHERE ballot_id = target;
      IF amount NOT BETWEEN question.min_choices AND question.max_choices THEN RAISE check_violation USING MESSAGE = 'Invalid selection'; END IF;
      RETURN NULL;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER ballot_check AFTER INSERT OR UPDATE ON ballots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vm_ballot_check();
    CREATE CONSTRAINT TRIGGER ballot_choices_check AFTER INSERT OR DELETE ON ballot_choices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vm_ballot_check();
    CREATE CONSTRAINT TRIGGER question_ballots_check AFTER UPDATE ON questions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vm_ballot_check();
    CREATE FUNCTION vm_ballot_choices_touch() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE ballots b SET revision = revision WHERE id IN (SELECT ballot_id FROM changed_choices);
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER ballot_choices_inserted AFTER INSERT ON ballot_choices REFERENCING NEW TABLE AS changed_choices FOR EACH STATEMENT EXECUTE FUNCTION vm_ballot_choices_touch();
    CREATE TRIGGER ballot_choices_deleted AFTER DELETE ON ballot_choices REFERENCING OLD TABLE AS changed_choices FOR EACH STATEMENT EXECUTE FUNCTION vm_ballot_choices_touch();
    CREATE FUNCTION vm_ballot_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_notify('ballot_changes',jsonb_build_object('roomId',NEW.room_id,'questionId',NEW.question_id,'revision',NEW.revision::text)::text);
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER ballot_changed AFTER INSERT OR UPDATE ON ballots FOR EACH ROW EXECUTE FUNCTION vm_ballot_changed();
    CREATE FUNCTION vm_ballot_data(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT jsonb_build_object('id',id,'questionId',question_id,'revision',revision::text,'createdAt',created_at,'updatedAt',updated_at,
        'choices',coalesce((SELECT jsonb_agg(option_id ORDER BY option_id) FROM ballot_choices WHERE ballot_id = b.id),'[]')) FROM ballots b WHERE id = p_id;
    $$;
    CREATE FUNCTION vm_personal_answer(p_link uuid,p_session bytea,p_question uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE owner uuid;
    BEGIN
      SELECT room_id INTO owner FROM vm_voting_access(p_link,p_session);
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF NOT EXISTS(SELECT 1 FROM questions WHERE id = p_question AND room_id = owner AND first_opened_at IS NOT NULL) THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      RETURN jsonb_build_object('status',200,'answer',(SELECT vm_ballot_data(id) FROM ballots WHERE question_id = p_question AND link_id = p_link));
    END;
    $$;
    CREATE FUNCTION vm_cast_personal(p_link uuid,p_session bytea,p_question uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE owner uuid; question questions; ballot ballots; ids uuid[]; payload jsonb; cached vote_requests; response jsonb; request uuid;
    BEGIN
      SELECT room_id INTO owner FROM voting_links WHERE id = p_link;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      PERFORM 1 FROM rooms WHERE id = owner FOR UPDATE;
      SELECT * INTO question FROM questions WHERE id = p_question AND room_id = owner FOR UPDATE;
      PERFORM 1 FROM voting_links WHERE id = p_link FOR SHARE;
      IF NOT EXISTS(SELECT 1 FROM vm_voting_access(p_link,p_session)) THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF NOT EXISTS(SELECT 1 FROM voting_links WHERE id = p_link AND mode = 'personal') THEN RETURN jsonb_build_object('status',409,'error','mode'); END IF;
      IF question.id IS NULL THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      IF jsonb_typeof(p_data->'requestId') IS DISTINCT FROM 'string' OR (p_data->>'requestId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(p_data->'choices') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'choices') > 100 THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      IF jsonb_typeof(p_data->'questionRevision') IS DISTINCT FROM 'string' OR (p_data->>'questionRevision') !~ '^(0|[1-9][0-9]{0,18})$' OR jsonb_typeof(p_data->'ballotRevision') IS DISTINCT FROM 'string' OR (p_data->>'ballotRevision') !~ '^(0|[1-9][0-9]{0,18})$' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'choices') value WHERE jsonb_typeof(value) <> 'string' OR (value#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      SELECT coalesce(array_agg((value#>>'{}')::uuid ORDER BY (value#>>'{}')::uuid),'{}') INTO ids FROM jsonb_array_elements(p_data->'choices') value;
      IF cardinality(ids) <> (SELECT count(DISTINCT x) FROM unnest(ids) x) THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      request := (p_data->>'requestId')::uuid;
      payload := jsonb_build_object('questionId',p_question,'choices',to_jsonb(ids),'questionRevision',p_data->'questionRevision','ballotRevision',p_data->'ballotRevision');
      SELECT * INTO cached FROM vote_requests WHERE link_id = p_link AND request_id = request;
      IF FOUND THEN
        IF cached.payload IS DISTINCT FROM payload THEN RETURN jsonb_build_object('status',409,'error','idempotency'); END IF;
        RETURN cached.response;
      END IF;
      IF question.state <> 'open' OR question.closes_at <= clock_timestamp() THEN RETURN jsonb_build_object('status',409,'error','closed'); END IF;
      IF question.revision <> (p_data->>'questionRevision')::bigint THEN RETURN jsonb_build_object('status',409,'error','changed'); END IF;
      IF cardinality(ids) NOT BETWEEN question.min_choices AND question.max_choices OR EXISTS(SELECT 1 FROM unnest(ids) id WHERE NOT EXISTS(SELECT 1 FROM question_options o WHERE o.id = id AND o.question_id = p_question AND o.room_id = owner)) THEN RETURN jsonb_build_object('status',400,'error','choices'); END IF;
      SELECT * INTO ballot FROM ballots WHERE link_id = p_link AND question_id = p_question FOR UPDATE;
      IF FOUND THEN
        IF NOT question.allow_answer_change THEN RETURN jsonb_build_object('status',409,'error','used'); END IF;
        IF ballot.revision <> (p_data->>'ballotRevision')::bigint THEN RETURN jsonb_build_object('status',409,'error','answer_changed'); END IF;
        DELETE FROM ballot_choices WHERE ballot_id = ballot.id;
      ELSE
        IF p_data->>'ballotRevision' <> '0' THEN RETURN jsonb_build_object('status',409,'error','answer_changed'); END IF;
        INSERT INTO ballots(room_id,question_id,link_id) VALUES(owner,p_question,p_link) RETURNING * INTO ballot;
      END IF;
      INSERT INTO ballot_choices(ballot_id,question_id,room_id,option_id) SELECT ballot.id,p_question,owner,id FROM unnest(ids) id;
      response := jsonb_build_object('status',200,'answer',vm_ballot_data(ballot.id));
      INSERT INTO vote_requests(link_id,request_id,payload,response) VALUES(p_link,request,payload,response);
      RETURN response;
    EXCEPTION WHEN check_violation OR foreign_key_violation OR unique_violation OR invalid_text_representation OR numeric_value_out_of_range THEN
      RETURN jsonb_build_object('status',400,'error','invalid');
    END;
    $$;
    DO $$ BEGIN
      EXECUTE replace(pg_get_functiondef('vm_question_request(uuid,bytea,uuid,text,jsonb)'::regprocedure),'FUNCTION public.vm_question_request(','FUNCTION public.vm_question_request_pre9(');
    END $$;
    CREATE OR REPLACE FUNCTION vm_question_request(p_room uuid,p_admin bytea,p_id uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
      IF p_action = 'save' THEN
        PERFORM 1 FROM rooms WHERE id = p_room AND EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
        IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
        IF jsonb_typeof(p_data->'choices') = 'array' THEN
          IF EXISTS(SELECT 1 FROM ballot_choices c WHERE c.question_id = p_id AND c.room_id = p_room AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'choices') item WHERE item->>'id' = c.option_id::text)) THEN RETURN jsonb_build_object('status',409,'error','used_options'); END IF;
          IF EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = p_id AND b.room_id = p_room AND (SELECT count(*) FROM ballot_choices c WHERE c.ballot_id = b.id) NOT BETWEEN (p_data->>'minChoices')::integer AND (p_data->>'maxChoices')::integer) THEN RETURN jsonb_build_object('status',409,'error','ballots'); END IF;
        END IF;
      END IF;
      RETURN vm_question_request_pre9(p_room,p_admin,p_id,p_action,p_data);
    END;
    $$;
    REVOKE ALL ON FUNCTION vm_ballot_lock(uuid,uuid,uuid),vm_ballot_guard(),vm_ballot_choice_guard(),vm_ballot_check(),vm_ballot_choices_touch(),vm_ballot_changed(),vm_ballot_data(uuid),vm_personal_answer(uuid,bytea,uuid),vm_cast_personal(uuid,bytea,uuid,jsonb),vm_question_request_pre9(uuid,bytea,uuid,text,jsonb) FROM PUBLIC;
  `);
}

// Remove voting state without changing question or link identity
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      EXECUTE replace(pg_get_functiondef('vm_question_request_pre9(uuid,bytea,uuid,text,jsonb)'::regprocedure),'FUNCTION public.vm_question_request_pre9(','FUNCTION public.vm_question_request(');
    END $$;
    DROP FUNCTION vm_question_request_pre9(uuid,bytea,uuid,text,jsonb);
    DROP FUNCTION vm_cast_personal(uuid,bytea,uuid,jsonb),vm_personal_answer(uuid,bytea,uuid),vm_ballot_data(uuid);
    DROP TRIGGER question_ballots_check ON questions;
    DROP TABLE vote_requests,ballot_choices,ballots;
    DROP FUNCTION vm_ballot_lock(uuid,uuid,uuid),vm_ballot_guard(),vm_ballot_choice_guard(),vm_ballot_check(),vm_ballot_choices_touch(),vm_ballot_changed();
    ALTER TABLE voting_links DROP CONSTRAINT link_room_owner;
  `);
}
