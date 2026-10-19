// Add explicit reusable runs and audited manual ballot sources
export function up(pgm) {
  pgm.sql(`
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_ballot_lock(uuid,uuid,uuid)','vm_ballot_guard()','vm_ballot_choice_guard()','vm_delete_question(uuid,bytea,uuid,jsonb)','vm_clear_answers(uuid)','vm_participant_journey(uuid,bytea,jsonb)','vm_cast_personal(uuid,bytea,uuid,jsonb)'] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||name||'_before_runs(');
      END LOOP;
    END $$;
    ALTER TABLE rooms ADD COLUMN allow_reusable_repeat boolean NOT NULL DEFAULT false;
    ALTER TABLE voting_sessions ADD CONSTRAINT voting_session_owner UNIQUE(id,link_id);
    ALTER TABLE ballots ADD COLUMN origin_session_id uuid;
    ALTER TABLE ballots ADD CONSTRAINT ballot_origin_owner FOREIGN KEY(origin_session_id,link_id) REFERENCES voting_sessions(id,link_id) ON DELETE RESTRICT;
    CREATE TABLE voting_runs (
      id uuid PRIMARY KEY,
      room_id uuid NOT NULL,
      link_id uuid NOT NULL,
      session_id uuid NOT NULL,
      FOREIGN KEY(session_id,link_id) REFERENCES voting_sessions(id,link_id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY(link_id,room_id) REFERENCES voting_links(id,room_id) ON DELETE RESTRICT,
      UNIQUE(id,link_id,room_id)
    );
    CREATE INDEX voting_runs_session ON voting_runs(session_id,created_at DESC,id);
    ALTER TABLE ballots DROP CONSTRAINT ballots_link_id_question_id_key;
    ALTER TABLE ballots DROP CONSTRAINT ballots_source_check;
    ALTER TABLE ballots ALTER COLUMN link_id DROP NOT NULL;
    ALTER TABLE ballots ADD COLUMN run_id uuid;
    ALTER TABLE ballots ADD COLUMN actor_session_id uuid REFERENCES room_admin_sessions(id) ON DELETE RESTRICT;
    ALTER TABLE ballots ADD CONSTRAINT ballot_source CHECK(source IN ('personal','admin_personal','reusable','admin_manual'));
    ALTER TABLE ballots ADD CONSTRAINT ballot_context CHECK(
      (source='personal' AND link_id IS NOT NULL AND run_id IS NULL AND actor_session_id IS NULL) OR
      (source='admin_personal' AND link_id IS NOT NULL AND run_id IS NULL AND actor_session_id IS NOT NULL) OR
      (source='reusable' AND link_id IS NOT NULL AND run_id IS NOT NULL AND actor_session_id IS NULL) OR
      (source='admin_manual' AND link_id IS NULL AND run_id IS NULL AND actor_session_id IS NOT NULL)
    );
    ALTER TABLE ballots ADD CONSTRAINT ballot_run_owner FOREIGN KEY(run_id,link_id,room_id) REFERENCES voting_runs(id,link_id,room_id) ON DELETE RESTRICT;
    CREATE UNIQUE INDEX personal_ballot_right ON ballots(link_id,question_id) WHERE source IN ('personal','admin_personal');
    CREATE UNIQUE INDEX reusable_ballot_right ON ballots(run_id,question_id) WHERE source='reusable';
    CREATE TABLE admin_vote_requests (
      room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
      request_id uuid NOT NULL,
      question_id uuid NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
      payload jsonb NOT NULL,
      response jsonb NOT NULL,
      PRIMARY KEY(room_id,request_id)
    );
    CREATE OR REPLACE FUNCTION vm_ballot_lock(p_room uuid,p_question uuid,p_link uuid) RETURNS questions LANGUAGE plpgsql AS $$
    DECLARE question questions;
    BEGIN
      PERFORM 1 FROM rooms WHERE id=p_room FOR UPDATE;
      SELECT * INTO question FROM questions WHERE id=p_question AND room_id=p_room FOR UPDATE;
      IF NOT FOUND OR question.state<>'open' OR question.closes_at<=clock_timestamp() THEN RAISE check_violation USING MESSAGE='Question is closed'; END IF;
      IF p_link IS NOT NULL THEN
        PERFORM 1 FROM voting_links WHERE id=p_link AND room_id=p_room AND revoked_at IS NULL FOR SHARE;
        IF NOT FOUND THEN RAISE check_violation USING MESSAGE='Link access required'; END IF;
      END IF;
      RETURN question;
    END;
    $$;
    CREATE OR REPLACE FUNCTION vm_ballot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE question questions;
    BEGIN
      IF EXISTS(SELECT 1 FROM questions WHERE id=OLD.question_id AND deleting) THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
      IF TG_OP='DELETE' THEN RAISE check_violation; END IF;
      question:=vm_ballot_lock(NEW.room_id,NEW.question_id,NEW.link_id);
      IF NEW.source IN ('personal','admin_personal') AND NOT EXISTS(SELECT 1 FROM voting_links WHERE id=NEW.link_id AND mode='personal') THEN RAISE check_violation; END IF;
      IF NEW.source='reusable' AND NOT EXISTS(SELECT 1 FROM voting_links WHERE id=NEW.link_id AND mode='reusable') THEN RAISE check_violation; END IF;
      IF NEW.actor_session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM room_admin_sessions WHERE id=NEW.actor_session_id AND room_id=NEW.room_id) THEN RAISE check_violation; END IF;
      IF TG_OP='UPDATE' THEN
        IF ROW(NEW.id,NEW.room_id,NEW.question_id,NEW.link_id,NEW.source,NEW.run_id,NEW.actor_session_id,NEW.created_at,NEW.created_xid) IS DISTINCT FROM ROW(OLD.id,OLD.room_id,OLD.question_id,OLD.link_id,OLD.source,OLD.run_id,OLD.actor_session_id,OLD.created_at,OLD.created_xid) THEN RAISE check_violation; END IF;
        IF OLD.created_xid<>pg_current_xact_id() AND NOT question.allow_answer_change THEN RAISE check_violation; END IF;
        NEW.revision:=OLD.revision+1;NEW.updated_at:=clock_timestamp();
      ELSE NEW.created_xid:=pg_current_xact_id();NEW.revision:=0; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE FUNCTION vm_exchange_voting_session(p_link uuid,p_key bytea,p_new bytea,p_old bytea)
      RETURNS TABLE(room_id uuid,room_name text,link_id uuid,name text,mode text,reused boolean) LANGUAGE plpgsql AS $$
    DECLARE link voting_links;
    BEGIN
      SELECT * INTO link FROM voting_links WHERE id=p_link FOR SHARE;
      IF NOT FOUND OR link.revoked_at IS NOT NULL OR link.secret_hash IS DISTINCT FROM p_key THEN RETURN; END IF;
      IF EXISTS(SELECT 1 FROM vm_voting_access(p_link,p_old)) THEN
        RETURN QUERY SELECT r.id,r.name,link.id,link.name,link.mode,true FROM rooms r WHERE r.id=link.room_id;
      ELSE RETURN QUERY SELECT access.room_id,access.room_name,access.link_id,access.name,access.mode,false FROM vm_open_voting_session(p_link,p_key,p_new) access; END IF;
    END;
    $$;
    REVOKE ALL ON FUNCTION vm_exchange_voting_session(uuid,bytea,bytea,bytea) FROM PUBLIC;
    CREATE FUNCTION vm_current_answer(p_link uuid,p_session bytea,p_question uuid,p_run uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE owner uuid; kind text;
    BEGIN
      SELECT access.room_id,access.mode INTO owner,kind FROM vm_voting_access(p_link,p_session) access;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF kind='personal' THEN RETURN vm_personal_answer(p_link,p_session,p_question); END IF;
      IF NOT EXISTS(SELECT 1 FROM voting_runs r JOIN voting_sessions s ON s.id=r.session_id WHERE r.id=p_run AND r.link_id=p_link AND s.secret_hash=p_session) THEN RETURN jsonb_build_object('status',404,'error','run'); END IF;
      IF NOT EXISTS(SELECT 1 FROM questions WHERE id=p_question AND room_id=owner AND first_opened_at IS NOT NULL AND state<>'draft') THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      RETURN jsonb_build_object('status',200,'answer',(SELECT vm_ballot_data(id) FROM ballots WHERE run_id=p_run AND question_id=p_question));
    END;
    $$;
    REVOKE ALL ON FUNCTION vm_current_answer(uuid,bytea,uuid,uuid) FROM PUBLIC;
    CREATE FUNCTION vm_begin_run(p_link uuid,p_session bytea,p_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE owner uuid; current_session uuid; saved voting_runs;
    BEGIN
      SELECT room_id INTO owner FROM voting_links WHERE id=p_link;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      PERFORM 1 FROM rooms WHERE id=owner FOR UPDATE;
      IF NOT EXISTS(SELECT 1 FROM vm_voting_access(p_link,p_session)) THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF NOT EXISTS(SELECT 1 FROM voting_links WHERE id=p_link AND mode='reusable') THEN RETURN jsonb_build_object('status',409,'error','mode'); END IF;
      SELECT id INTO current_session FROM voting_sessions WHERE link_id=p_link AND secret_hash=p_session;
      IF NOT EXISTS(SELECT 1 FROM voting_runs WHERE id=p_id AND session_id=current_session) AND EXISTS(SELECT 1 FROM voting_runs WHERE session_id=current_session AND id<>p_id) AND NOT (SELECT allow_reusable_repeat FROM rooms WHERE id=owner) THEN RETURN jsonb_build_object('status',409,'error','repeat'); END IF;
      INSERT INTO voting_runs(id,room_id,link_id,session_id) VALUES(p_id,owner,p_link,current_session) ON CONFLICT(id) DO NOTHING;
      SELECT * INTO saved FROM voting_runs WHERE id=p_id AND link_id=p_link AND voting_runs.session_id=current_session;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',409,'error','idempotency'); END IF;
      RETURN jsonb_build_object('status',200,'run',jsonb_build_object('id',saved.id,'createdAt',saved.created_at));
    END;
    $$;
    CREATE FUNCTION vm_cast_ballot(p_room uuid,p_identity uuid,p_session bytea,p_admin boolean,p_question uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE owner uuid; question questions; ballot ballots; ids uuid[]; payload jsonb; cached jsonb; response jsonb; request uuid; run uuid; target uuid; actor uuid; origin uuid; source text;
    BEGIN
      owner:=p_room;
      IF NOT p_admin THEN SELECT room_id INTO owner FROM voting_links WHERE id=p_identity; END IF;
      PERFORM 1 FROM rooms WHERE id=owner FOR UPDATE;
      IF p_admin THEN
        IF NOT EXISTS(SELECT 1 FROM vm_admin_room(owner,p_session)) THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
        SELECT id INTO actor FROM room_admin_sessions WHERE room_id=owner AND secret_hash=p_session;
        IF p_data->>'linkId' IS NOT NULL THEN target:=(p_data->>'linkId')::uuid; source:='admin_personal'; ELSE source:='admin_manual'; END IF;
      ELSE
        IF NOT EXISTS(SELECT 1 FROM vm_voting_access(p_identity,p_session)) THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
        target:=p_identity;source:='reusable';
        SELECT id INTO origin FROM voting_sessions WHERE link_id=p_identity AND secret_hash=p_session;
        IF NOT EXISTS(SELECT 1 FROM voting_links WHERE id=target AND mode='reusable') THEN RETURN jsonb_build_object('status',409,'error','mode'); END IF;
        run:=(p_data->>'runId')::uuid;
        IF run IS NULL OR NOT EXISTS(SELECT 1 FROM voting_runs r JOIN voting_sessions s ON s.id=r.session_id WHERE r.id=run AND r.link_id=target AND s.secret_hash=p_session) THEN RETURN jsonb_build_object('status',404,'error','run'); END IF;
      END IF;
      SELECT * INTO question FROM questions WHERE id=p_question AND room_id=owner FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      IF target IS NOT NULL THEN
        PERFORM 1 FROM voting_links WHERE id=target AND room_id=owner AND revoked_at IS NULL AND mode=CASE WHEN source='reusable' THEN 'reusable' ELSE 'personal' END FOR SHARE;
        IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','link'); END IF;
      END IF;
      IF jsonb_typeof(p_data->'requestId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_data->'choices') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'choices') NOT BETWEEN 1 AND 100 THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      request:=(p_data->>'requestId')::uuid;
      IF jsonb_typeof(p_data->'questionRevision') IS DISTINCT FROM 'string' OR (p_data->>'questionRevision') !~ '^(0|[1-9][0-9]{0,18})$' OR jsonb_typeof(p_data->'ballotRevision') IS DISTINCT FROM 'string' OR (p_data->>'ballotRevision') !~ '^(0|[1-9][0-9]{0,18})$' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'choices') value WHERE jsonb_typeof(value)<>'string') THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      SELECT array_agg((value#>>'{}')::uuid ORDER BY (value#>>'{}')::uuid) INTO ids FROM jsonb_array_elements(p_data->'choices') value;
      IF cardinality(ids)<>(SELECT count(DISTINCT id) FROM unnest(ids) id) THEN RETURN jsonb_build_object('status',400,'error','choices'); END IF;
      payload:=jsonb_build_object('questionId',p_question,'source',source,'runId',run,'linkId',target,'choices',to_jsonb(ids),'questionRevision',p_data->'questionRevision','ballotRevision',p_data->'ballotRevision');
      IF p_admin THEN SELECT jsonb_build_object('payload',r.payload,'response',r.response) INTO cached FROM admin_vote_requests r WHERE room_id=owner AND request_id=request;
      ELSE SELECT jsonb_build_object('payload',r.payload,'response',r.response) INTO cached FROM vote_requests r WHERE link_id=target AND request_id=request; END IF;
      IF cached IS NOT NULL THEN
        IF cached->'payload' IS DISTINCT FROM payload THEN RETURN jsonb_build_object('status',409,'error','idempotency'); END IF;
        RETURN cached->'response';
      END IF;
      IF question.state<>'open' OR question.closes_at<=clock_timestamp() THEN RETURN jsonb_build_object('status',409,'error','closed'); END IF;
      IF source='reusable' AND NOT vm_run_navigation(target,run,p_question) THEN RETURN jsonb_build_object('status',409,'error','sequence'); END IF;
      IF question.revision<>(p_data->>'questionRevision')::bigint THEN RETURN jsonb_build_object('status',409,'error','changed'); END IF;
      IF cardinality(ids) NOT BETWEEN question.min_choices AND question.max_choices OR EXISTS(SELECT 1 FROM unnest(ids) id WHERE NOT EXISTS(SELECT 1 FROM question_options WHERE question_id=p_question AND question_options.id=id)) THEN RETURN jsonb_build_object('status',400,'error','choices'); END IF;
      IF source='reusable' THEN SELECT * INTO ballot FROM ballots WHERE run_id=run AND question_id=p_question FOR UPDATE;
      ELSIF source='admin_personal' THEN SELECT * INTO ballot FROM ballots WHERE link_id=target AND question_id=p_question AND ballots.source IN ('personal','admin_personal') FOR UPDATE; END IF;
      IF ballot.id IS NOT NULL THEN
        IF NOT question.allow_answer_change THEN RETURN jsonb_build_object('status',409,'error','used'); END IF;
        IF ballot.revision<>(p_data->>'ballotRevision')::bigint THEN RETURN jsonb_build_object('status',409,'error','answer_changed'); END IF;
        UPDATE ballots SET origin_session_id=origin WHERE id=ballot.id;
        DELETE FROM ballot_choices WHERE ballot_id=ballot.id;
      ELSE
        IF p_data->>'ballotRevision'<>'0' THEN RETURN jsonb_build_object('status',409,'error','answer_changed'); END IF;
        INSERT INTO ballots(room_id,question_id,link_id,source,run_id,actor_session_id,origin_session_id) VALUES(owner,p_question,target,source,run,actor,origin) RETURNING * INTO ballot;
      END IF;
      INSERT INTO ballot_choices(ballot_id,question_id,room_id,option_id) SELECT ballot.id,p_question,owner,id FROM unnest(ids) id;
      response:=jsonb_build_object('status',200,'answer',vm_ballot_data(ballot.id));
      IF p_admin THEN INSERT INTO admin_vote_requests(room_id,request_id,question_id,payload,response) VALUES(owner,request,p_question,payload,response);
      ELSE INSERT INTO vote_requests(link_id,request_id,payload,response) VALUES(target,request,payload,response); END IF;
      RETURN response;
    EXCEPTION WHEN check_violation OR foreign_key_violation OR unique_violation OR invalid_text_representation OR numeric_value_out_of_range THEN RETURN jsonb_build_object('status',400,'error','invalid');
    END;
    $$;
    DO $$ DECLARE definition text; BEGIN
      definition:=pg_get_functiondef('vm_cast_personal(uuid,bytea,uuid,jsonb)'::regprocedure);
      definition:=replace(definition,'DELETE FROM ballot_choices WHERE ballot_id = ballot.id;', 'UPDATE ballots SET origin_session_id=(SELECT id FROM voting_sessions WHERE link_id=p_link AND secret_hash=p_session) WHERE id=ballot.id; DELETE FROM ballot_choices WHERE ballot_id = ballot.id;');
      EXECUTE replace(definition,'INSERT INTO ballots(room_id,question_id,link_id) VALUES(owner,p_question,p_link)', 'INSERT INTO ballots(room_id,question_id,link_id,origin_session_id) VALUES(owner,p_question,p_link,(SELECT id FROM voting_sessions WHERE link_id=p_link AND secret_hash=p_session))');
    END $$;
    DO $$ DECLARE definition text; BEGIN
      definition:=pg_get_functiondef('vm_delete_question(uuid,bytea,uuid,jsonb)'::regprocedure);
      EXECUTE replace(definition,'DELETE FROM vote_requests WHERE', 'DELETE FROM admin_vote_requests WHERE question_id=p_id; DELETE FROM vote_requests WHERE');
      definition:=pg_get_functiondef('vm_clear_answers(uuid)'::regprocedure);
      EXECUTE replace(definition,'DELETE FROM vote_requests WHERE', 'DELETE FROM admin_vote_requests WHERE question_id=p_id; DELETE FROM vote_requests WHERE');
    END $$;
    CREATE FUNCTION vm_reuse_policy(p_room uuid,p_admin bytea,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE saved rooms;
    BEGIN
      SELECT r.* INTO saved FROM rooms r WHERE r.id=p_room AND EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF p_data ? 'enabled' THEN
        IF jsonb_typeof(p_data->'enabled') IS DISTINCT FROM 'boolean' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
        IF p_data->>'revision' IS DISTINCT FROM saved.revision::text THEN RETURN jsonb_build_object('status',409,'error','conflict'); END IF;
        UPDATE rooms SET allow_reusable_repeat=(p_data->>'enabled')::boolean WHERE id=p_room RETURNING * INTO saved;
      END IF;
      RETURN jsonb_build_object('status',200,'policy',jsonb_build_object('enabled',saved.allow_reusable_repeat,'revision',saved.revision::text));
    END;
    $$;
    CREATE FUNCTION vm_manual_context(p_room uuid,p_admin bytea,p_question uuid,p_link uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE saved ballots;
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF NOT EXISTS(SELECT 1 FROM questions WHERE id=p_question AND room_id=p_room) THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      IF p_link IS NOT NULL THEN
        IF NOT EXISTS(SELECT 1 FROM voting_links WHERE id=p_link AND room_id=p_room AND mode='personal' AND revoked_at IS NULL) THEN RETURN jsonb_build_object('status',404,'error','link'); END IF;
        SELECT * INTO saved FROM ballots WHERE link_id=p_link AND question_id=p_question;
      END IF;
      RETURN jsonb_build_object('status',200,'question',vm_question_data(p_question),'answered',saved.id IS NOT NULL,'answerRevision',COALESCE(saved.revision::text,'0'));
    END;
    $$;
    REVOKE ALL ON FUNCTION vm_reuse_policy(uuid,bytea,jsonb),vm_manual_context(uuid,bytea,uuid,uuid) FROM PUBLIC;
    CREATE FUNCTION vm_run_navigation(p_link uuid,p_run uuid,p_question uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
      SELECT CASE WHEN p_run IS NULL THEN vm_navigation_allowed(p_link,p_question) ELSE EXISTS(
        SELECT 1 FROM questions q JOIN voting_links l ON l.room_id=q.room_id WHERE l.id=p_link AND q.id=p_question AND q.first_opened_at IS NOT NULL AND q.state<>'draft' AND (
          EXISTS(SELECT 1 FROM ballots WHERE run_id=p_run AND question_id=q.id) OR NOT EXISTS(
            SELECT 1 FROM questions prior WHERE prior.room_id=q.room_id AND vm_effective_state(prior.id)='open' AND NOT prior.allow_skip AND (prior.created_at,prior.ordinal)<(q.created_at,q.ordinal)
            AND NOT EXISTS(SELECT 1 FROM ballots WHERE run_id=p_run AND question_id=prior.id)
          )
        )
      ) END;
    $$;
    CREATE OR REPLACE FUNCTION vm_participant_journey(p_link uuid,p_session bytea,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE owner uuid; mode text; run_uuid uuid; run_data jsonb; current_session uuid; selected uuid; skipped questions; current questions; after_time timestamptz; after_key bigint; page jsonb; next_cursor text; progress jsonb;
    BEGIN
      SELECT room_id INTO owner FROM voting_links WHERE id = p_link;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      PERFORM 1 FROM rooms WHERE id = owner FOR UPDATE;
      SELECT access.mode INTO mode FROM vm_voting_access(p_link,p_session) access;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF mode='reusable' THEN
        SELECT id INTO current_session FROM voting_sessions WHERE link_id=p_link AND secret_hash=p_session;
        IF p_data->>'run' IS NOT NULL THEN run_uuid:=(p_data->>'run')::uuid;
        ELSE SELECT id INTO run_uuid FROM voting_runs WHERE session_id=current_session ORDER BY created_at DESC,id DESC LIMIT 1; END IF;
        IF run_uuid IS NULL THEN
          run_data:=vm_begin_run(p_link,p_session,gen_random_uuid());
          IF run_data->>'status'<>'200' THEN RETURN run_data; END IF;
          run_uuid:=(run_data#>>'{run,id}')::uuid;
        END IF;
        SELECT jsonb_build_object('id',id,'createdAt',created_at) INTO run_data FROM voting_runs WHERE id=run_uuid AND session_id=current_session;
        IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','run'); END IF;
      END IF;
      IF p_data->>'after' IS NOT NULL AND p_data->>'after' <> '0' THEN
        IF (p_data->>'after') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}.[0-9]{6}Z~[1-9][0-9]{0,18}$' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
        after_time := split_part(p_data->>'after','~',1)::timestamptz; after_key := split_part(p_data->>'after','~',2)::bigint;
      END IF;
      IF p_data->>'skip' IS NOT NULL THEN
        SELECT * INTO skipped FROM questions WHERE id = (p_data->>'skip')::uuid AND room_id = owner AND first_opened_at IS NOT NULL;
        IF NOT FOUND OR (vm_effective_state(skipped.id) = 'open' AND NOT skipped.allow_skip AND NOT EXISTS(SELECT 1 FROM ballots WHERE question_id = skipped.id AND link_id = p_link AND run_id IS NOT DISTINCT FROM run_uuid)) THEN RETURN jsonb_build_object('status',409,'error','skip'); END IF;
      END IF;
      IF p_data->>'selected' IS NOT NULL THEN
        SELECT * INTO current FROM questions q WHERE q.id = (p_data->>'selected')::uuid AND q.room_id = owner AND q.first_opened_at IS NOT NULL AND q.state<>'draft'
          AND (vm_effective_state(q.id) = 'open' OR EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = q.id AND b.link_id = p_link AND (b.run_id IS NOT DISTINCT FROM run_uuid)));
        IF FOUND AND NOT vm_run_navigation(p_link,run_uuid,current.id) THEN current := NULL; END IF;
      END IF;
      IF current.id IS NULL THEN
        SELECT * INTO current FROM questions q WHERE q.room_id = owner AND vm_effective_state(q.id) = 'open'
          AND NOT EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = q.id AND b.link_id = p_link AND (b.run_id IS NOT DISTINCT FROM run_uuid))
          AND (skipped.id IS NULL OR (q.created_at,q.ordinal) > (skipped.created_at,skipped.ordinal))
          AND vm_run_navigation(p_link,run_uuid,q.id)
          ORDER BY q.created_at,q.ordinal LIMIT 1;
      END IF;
      WITH selected AS MATERIALIZED (
        SELECT q.*,EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = q.id AND b.link_id = p_link AND (b.run_id IS NOT DISTINCT FROM run_uuid)) AS answered
          FROM questions q WHERE q.room_id = owner AND q.first_opened_at IS NOT NULL AND q.state<>'draft'
          AND (vm_effective_state(q.id) = 'open' OR EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = q.id AND b.link_id = p_link AND (b.run_id IS NOT DISTINCT FROM run_uuid)))
          AND (after_time IS NULL OR (q.created_at,q.ordinal) > (after_time,after_key)) ORDER BY q.created_at,q.ordinal LIMIT 51
      ), visible AS (SELECT * FROM selected ORDER BY created_at,ordinal LIMIT 50)
      SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'roomId',room_id,'preview',left(content,240),'state',vm_effective_state(id),'ordinal',ordinal::text,'revision',revision::text,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'editLocked',edit_locked,'choiceMode',choice_mode,'choiceCount',(SELECT count(*) FROM question_options WHERE question_id = visible.id),'answered',answered,'allowSkip',allow_skip,'canChoose',vm_run_navigation(p_link,run_uuid,id)) || vm_lifecycle_data(id) ORDER BY created_at,ordinal),'[]'),
        CASE WHEN (SELECT count(*) FROM selected) > 50 THEN (SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '~' || ordinal::text FROM visible ORDER BY created_at DESC,ordinal DESC LIMIT 1) END
        INTO page,next_cursor FROM visible;
      SELECT jsonb_build_object('total',count(*),'answered',count(*) FILTER(WHERE EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = q.id AND b.link_id = p_link AND (b.run_id IS NOT DISTINCT FROM run_uuid))),'pending',count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = q.id AND b.link_id = p_link AND (b.run_id IS NOT DISTINCT FROM run_uuid)))) INTO progress FROM questions q WHERE q.room_id = owner AND vm_effective_state(q.id) = 'open';
      RETURN jsonb_build_object('timeZone',COALESCE((SELECT time_zone FROM rooms WHERE id=owner),'UTC'),'run',run_data,'repeatAllowed',(SELECT allow_reusable_repeat FROM rooms WHERE id=owner),'runs',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'createdAt',created_at) ORDER BY created_at DESC) FROM (SELECT * FROM voting_runs WHERE session_id=current_session ORDER BY created_at DESC,id DESC LIMIT 50) recent),'[]')) || jsonb_build_object('status',200,'questions',page,'nextCursor',next_cursor,'current',vm_question_data(current.id),'answer',(SELECT vm_ballot_data(id) FROM ballots WHERE question_id = current.id AND link_id = p_link AND run_id IS NOT DISTINCT FROM run_uuid),'progress',progress);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN RETURN jsonb_build_object('status',400,'error','invalid');
    END;
    $$;
    REVOKE ALL ON FUNCTION vm_run_navigation(uuid,uuid,uuid) FROM PUBLIC;
    REVOKE ALL ON FUNCTION vm_begin_run(uuid,bytea,uuid),vm_cast_ballot(uuid,uuid,bytea,boolean,uuid,jsonb),vm_ballot_lock_before_runs(uuid,uuid,uuid),vm_ballot_guard_before_runs(),vm_ballot_choice_guard_before_runs(),vm_delete_question_before_runs(uuid,bytea,uuid,jsonb),vm_clear_answers_before_runs(uuid),vm_participant_journey_before_runs(uuid,bytea,jsonb),vm_cast_personal_before_runs(uuid,bytea,uuid,jsonb) FROM PUBLIC;
  `);
}
// Refuse to erase new ballot sources during a schema rollback
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM ballots WHERE source<>'personal') THEN RAISE EXCEPTION 'Remove or recover new ballot sources before rollback'; END IF; END $$;
    DO $$ DECLARE signature text;name text;BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_ballot_lock_before_runs(uuid,uuid,uuid)','vm_ballot_guard_before_runs()','vm_ballot_choice_guard_before_runs()','vm_delete_question_before_runs(uuid,bytea,uuid,jsonb)','vm_clear_answers_before_runs(uuid)','vm_participant_journey_before_runs(uuid,bytea,jsonb)','vm_cast_personal_before_runs(uuid,bytea,uuid,jsonb)'] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||replace(name,'_before_runs','')||'(');
      END LOOP;
    END $$;
    DROP FUNCTION vm_current_answer(uuid,bytea,uuid,uuid);
    DROP FUNCTION vm_begin_run(uuid,bytea,uuid),vm_cast_ballot(uuid,uuid,bytea,boolean,uuid,jsonb);
    DROP TABLE admin_vote_requests;
    DROP FUNCTION vm_exchange_voting_session(uuid,bytea,bytea,bytea);
    DROP FUNCTION vm_reuse_policy(uuid,bytea,jsonb),vm_manual_context(uuid,bytea,uuid,uuid);
    ALTER TABLE ballots DROP CONSTRAINT ballot_context,DROP CONSTRAINT ballot_source,DROP CONSTRAINT ballot_run_owner;
    DROP INDEX personal_ballot_right,reusable_ballot_right;
    ALTER TABLE ballots DROP COLUMN run_id,DROP COLUMN actor_session_id;
    ALTER TABLE ballots ALTER COLUMN link_id SET NOT NULL;
    ALTER TABLE ballots ADD CONSTRAINT ballots_source_check CHECK(source='personal');
    ALTER TABLE ballots ADD CONSTRAINT ballots_link_id_question_id_key UNIQUE(link_id,question_id);
    DROP TABLE voting_runs;
    DROP FUNCTION vm_run_navigation(uuid,uuid,uuid);
    ALTER TABLE ballots DROP CONSTRAINT ballot_origin_owner,DROP COLUMN origin_session_id;
    ALTER TABLE voting_sessions DROP CONSTRAINT voting_session_owner;
    ALTER TABLE rooms DROP COLUMN allow_reusable_repeat;
    DROP FUNCTION vm_ballot_lock_before_runs(uuid,uuid,uuid),vm_ballot_guard_before_runs(),vm_ballot_choice_guard_before_runs(),vm_delete_question_before_runs(uuid,bytea,uuid,jsonb),vm_clear_answers_before_runs(uuid),vm_participant_journey_before_runs(uuid,bytea,jsonb),vm_cast_personal_before_runs(uuid,bytea,uuid,jsonb);
  `);
}
