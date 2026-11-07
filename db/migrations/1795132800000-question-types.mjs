// Save the old definitions so rollback restores every changed rule
const signatures = [
  'vm_question_data(uuid)',
  'vm_question_request(uuid,bytea,uuid,text,jsonb)',
  'vm_question_request_v6(uuid,bytea,uuid,text,jsonb)',
  'vm_question_request_before_workspace(uuid,bytea,uuid,text,jsonb)',
  'vm_store_question_before_reset(uuid,bytea,uuid,text,jsonb)',
  'vm_ballot_guard()',
  'vm_ballot_choice_guard()',
  'vm_ballot_check()',
  'vm_cast_personal(uuid,bytea,uuid,jsonb)',
  'vm_cast_ballot(uuid,uuid,bytea,boolean,uuid,jsonb)',
  'vm_navigation_allowed(uuid,uuid)',
  'vm_run_navigation(uuid,uuid,uuid)',
  'vm_journey_with_starts(uuid,bytea,jsonb)',
  'vm_participant_journey(uuid,bytea,jsonb)',
  'vm_results_allowed(uuid,uuid,uuid,boolean)',
  'vm_results_before_review(uuid,bytea,boolean,uuid,jsonb)',
  'vm_room_report_before_history(uuid,bytea,boolean,uuid,boolean)',
  'vm_admin_question_metrics(uuid)',
  'vm_event_state(uuid,bytea,boolean)',
  'vm_manual_context(uuid,bytea,uuid,uuid)',
];

// Add a question kind without changing any saved ordinary votes
export function up(pgm) {
  pgm.sql(`
    ALTER TABLE questions ADD COLUMN question_type text NOT NULL DEFAULT 'choice' CHECK (question_type IN ('choice','allocation'));
    ALTER TABLE question_options ADD COLUMN capacity integer NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 1000000);
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY[${signatures.map((s) => `'${s}'`).join(',')}] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||name||'_before_types(');
        EXECUTE 'REVOKE ALL ON FUNCTION '||replace(signature,name,name||'_before_types')||' FROM PUBLIC';
      END LOOP;
    END $$;

    -- Partial allocations hold places but do not finish a required question
    CREATE FUNCTION vm_ballot_complete(p_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT q.question_type='choice' OR (SELECT count(*) FROM ballot_choices WHERE ballot_id=b.id)>=q.min_choices
        FROM ballots b JOIN questions q ON q.id=b.question_id WHERE b.id=p_id;
    $$;
    CREATE OR REPLACE FUNCTION vm_question_data(p_id uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
      SELECT vm_question_data_before_types(p_id)||jsonb_build_object('questionType',q.question_type)||CASE WHEN q.question_type='allocation' THEN
        jsonb_build_object('choices',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',o.id,'content',o.content,'capacity',o.capacity,
          'remaining',o.capacity-(SELECT count(*) FROM ballot_choices WHERE option_id=o.id)) ORDER BY o.position) FROM question_options o WHERE o.question_id=q.id),'[]'::jsonb))
        ELSE '{}'::jsonb END FROM questions q WHERE q.id=p_id;
    $$;

    CREATE FUNCTION vm_question_type_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.question_type IS DISTINCT FROM OLD.question_type AND (OLD.edit_locked OR EXISTS(SELECT 1 FROM ballots WHERE question_id=OLD.id)) THEN
        RAISE check_violation USING MESSAGE='Question type is fixed';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER question_type_guard BEFORE UPDATE ON questions FOR EACH ROW EXECUTE FUNCTION vm_question_type_guard();

    -- Room and question locks are already held by the existing ballot guard
    CREATE FUNCTION vm_allocation_capacity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE limit_count integer; used_count bigint;
    BEGIN
      SELECT o.capacity INTO limit_count FROM question_options o JOIN questions q ON q.id=o.question_id WHERE o.id=NEW.option_id AND q.question_type='allocation';
      IF FOUND THEN
        SELECT count(*) INTO used_count FROM ballot_choices WHERE option_id=NEW.option_id;
        IF used_count>=limit_count THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Option is full'; END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER zz_allocation_capacity_guard BEFORE INSERT ON ballot_choices FOR EACH ROW EXECUTE FUNCTION vm_allocation_capacity_guard();
    CREATE FUNCTION vm_allocation_option_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.capacity<(SELECT count(*) FROM ballot_choices WHERE option_id=NEW.id) AND EXISTS(SELECT 1 FROM questions WHERE id=NEW.question_id AND question_type='allocation') THEN
        RAISE check_violation USING MESSAGE='Capacity is below existing claims';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER zz_allocation_option_guard BEFORE UPDATE ON question_options FOR EACH ROW EXECUTE FUNCTION vm_allocation_option_guard();

    -- Extend the existing storage path, including its edit locks and media checks
    DO $$ DECLARE definition text; BEGIN
      definition:=pg_get_functiondef('vm_question_request_v6(uuid,bytea,uuid,text,jsonb)'::regprocedure);
      IF position('UPDATE questions SET content =' IN definition)=0 THEN RAISE EXCEPTION 'Missing question storage'; END IF;
      definition:=replace(definition,'UPDATE questions SET content =', $patch$UPDATE questions SET question_type=COALESCE(p_data->>'questionType',question_type), content =$patch$);
      definition:=replace(definition,$patch$'content',item->>'content'$patch$,$patch$'content',item->>'content','capacity',COALESCE((item->>'capacity')::integer,1)$patch$);
      definition:=replace(definition,'INSERT INTO question_options(id,question_id,room_id,position,content)','INSERT INTO question_options(id,question_id,room_id,position,content,capacity)');
      definition:=replace(definition,$patch$value->>'content' FROM jsonb_array_elements(normalized)$patch$,$patch$value->>'content',(value->>'capacity')::integer FROM jsonb_array_elements(normalized)$patch$);
      definition:=replace(definition,'content = EXCLUDED.content','content = EXCLUDED.content, capacity = EXCLUDED.capacity');
      definition:=replace(definition,'(question_options.position,question_options.content) IS DISTINCT FROM (EXCLUDED.position,EXCLUDED.content)','(question_options.position,question_options.content,question_options.capacity) IS DISTINCT FROM (EXCLUDED.position,EXCLUDED.content,EXCLUDED.capacity)');
      EXECUTE definition;
      definition:=pg_get_functiondef('vm_store_question_before_reset(uuid,bytea,uuid,text,jsonb)'::regprocedure);
      definition:=replace(definition,$patch$(vm_question_data(saved.id)->'choices')$patch$,$patch$(SELECT COALESCE(jsonb_agg(item-'remaining' ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements(vm_question_data(saved.id)->'choices') WITH ORDINALITY e(item,n))$patch$);
      EXECUTE definition;
      definition:=pg_get_functiondef('vm_question_request_before_workspace(uuid,bytea,uuid,text,jsonb)'::regprocedure);
      definition:=replace(definition,$patch$NOT BETWEEN (p_data->>'minChoices')::integer$patch$,$patch$NOT BETWEEN (CASE WHEN (SELECT question_type FROM questions WHERE id=p_id)='allocation' THEN 0 ELSE (p_data->>'minChoices')::integer END)$patch$);
      EXECUTE definition;
      definition:=pg_get_functiondef('vm_ballot_check()'::regprocedure);
      definition:=replace(definition,'BETWEEN question.min_choices AND','BETWEEN (CASE WHEN question.question_type=''allocation'' THEN 0 ELSE question.min_choices END) AND');
      EXECUTE definition;
      definition:=pg_get_functiondef('vm_ballot_guard()'::regprocedure);
      definition:=replace(definition,'AND NOT question.allow_answer_change THEN','AND NOT question.allow_answer_change AND question.question_type<>''allocation'' THEN');
      EXECUTE definition;
      definition:=pg_get_functiondef('vm_ballot_choice_guard()'::regprocedure);
      definition:=replace(definition,'AND NOT question.allow_answer_change THEN','AND NOT question.allow_answer_change AND (question.question_type<>''allocation'' OR TG_OP=''DELETE'') THEN');
      EXECUTE definition;
    END $$;

    CREATE OR REPLACE FUNCTION vm_question_request(p_room uuid,p_admin bytea,p_id uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; page jsonb; kind text; saved questions;
    BEGIN
      IF p_action IN ('create','save') THEN
        PERFORM 1 FROM rooms WHERE id=p_room AND EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
        IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
        SELECT * INTO saved FROM questions WHERE id=p_id AND room_id=p_room FOR UPDATE;
        IF NOT vm_valid_question_document(p_data) THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
        kind:=COALESCE(p_data->>'questionType',saved.question_type,'choice');
        IF kind NOT IN ('choice','allocation') OR (p_data ? 'questionType' AND jsonb_typeof(p_data->'questionType') IS DISTINCT FROM 'string') THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
        IF kind IS DISTINCT FROM saved.question_type AND saved.id IS NOT NULL AND (saved.edit_locked OR EXISTS(SELECT 1 FROM ballots WHERE question_id=p_id)) THEN RETURN jsonb_build_object('status',409,'error','type_fixed'); END IF;
        IF kind='allocation' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'choices') item WHERE jsonb_typeof(item->'capacity') IS DISTINCT FROM 'number' OR (item->>'capacity') !~ '^[1-9][0-9]{0,6}$' OR (item->>'capacity')::numeric>1000000) THEN RETURN jsonb_build_object('status',400,'error','capacity'); END IF;
        IF kind='allocation' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'choices') item WHERE (item->>'capacity')::integer<(SELECT count(*) FROM ballot_choices WHERE option_id=(item->>'id')::uuid)) THEN RETURN jsonb_build_object('status',409,'error','capacity'); END IF;
      END IF;
      result:=vm_question_request_before_types(p_room,p_admin,p_id,p_action,p_data);
      IF result->>'status'='200' AND result ? 'questions' THEN
        SELECT COALESCE(jsonb_agg(item||jsonb_build_object('questionType',q.question_type) ORDER BY n),'[]'::jsonb) INTO page
          FROM jsonb_array_elements(result->'questions') WITH ORDINALITY e(item,n) JOIN questions q ON q.id=(item->>'id')::uuid;
        result:=jsonb_set(result,'{questions}',page);
      END IF;
      RETURN result;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN jsonb_build_object('status',400,'error','invalid');
    END $$;

    -- One transaction covers rights, retries, capacity and replacement
    CREATE FUNCTION vm_cast_allocation(p_room uuid,p_identity uuid,p_session bytea,p_admin boolean,p_question uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE owner uuid; q questions; saved ballots; ids uuid[]; request uuid; payload jsonb; cached jsonb; result jsonb;
      target uuid; actor uuid; origin uuid; run uuid; source_kind text; manual_id uuid;
    BEGIN
      owner:=p_room;
      IF NOT p_admin THEN SELECT room_id INTO owner FROM voting_links WHERE id=p_identity; END IF;
      PERFORM 1 FROM rooms WHERE id=owner FOR UPDATE;
      IF p_admin THEN
        IF NOT EXISTS(SELECT 1 FROM vm_admin_room(owner,p_session)) THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
        SELECT id INTO actor FROM room_admin_sessions WHERE room_id=owner AND secret_hash=p_session;
        target:=(p_data->>'linkId')::uuid;
        source_kind:=CASE WHEN target IS NULL THEN 'admin_manual' ELSE 'admin_personal' END;
        IF target IS NULL THEN manual_id:=(p_data->>'ballotId')::uuid; END IF;
      ELSE
        IF NOT EXISTS(SELECT 1 FROM vm_voting_access(p_identity,p_session)) THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
        target:=p_identity;
        SELECT id INTO origin FROM voting_sessions WHERE link_id=target AND secret_hash=p_session;
        SELECT CASE WHEN mode='personal' THEN 'personal' ELSE 'reusable' END INTO source_kind FROM voting_links WHERE id=target;
        IF source_kind='reusable' THEN
          run:=(p_data->>'runId')::uuid;
          IF run IS NULL OR NOT vm_run_readable(target,p_session,run) THEN RETURN jsonb_build_object('status',404,'error','run'); END IF;
        END IF;
      END IF;
      SELECT * INTO q FROM questions WHERE id=p_question AND room_id=owner FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      IF q.question_type<>'allocation' THEN RETURN jsonb_build_object('status',409,'error','changed'); END IF;
      IF target IS NOT NULL AND NOT EXISTS(SELECT 1 FROM voting_links WHERE id=target AND room_id=owner AND revoked_at IS NULL AND mode=CASE WHEN source_kind='reusable' THEN 'reusable' ELSE 'personal' END) THEN RETURN jsonb_build_object('status',404,'error','link'); END IF;
      IF jsonb_typeof(p_data->'requestId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_data->'choices') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'choices')>100
        OR jsonb_typeof(p_data->'questionRevision') IS DISTINCT FROM 'string' OR (p_data->>'questionRevision') !~ '^(0|[1-9][0-9]{0,18})$'
        OR jsonb_typeof(p_data->'ballotRevision') IS DISTINCT FROM 'string' OR (p_data->>'ballotRevision') !~ '^(0|[1-9][0-9]{0,18})$'
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'choices') item WHERE jsonb_typeof(item) IS DISTINCT FROM 'string') THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      request:=(p_data->>'requestId')::uuid;
      SELECT COALESCE(array_agg((item#>>'{}')::uuid ORDER BY (item#>>'{}')::uuid),'{}') INTO ids FROM jsonb_array_elements(p_data->'choices') item;
      IF cardinality(ids)<>(SELECT count(DISTINCT id) FROM unnest(ids) id) THEN RETURN jsonb_build_object('status',400,'error','choices'); END IF;
      payload:=jsonb_build_object('questionId',p_question,'source',source_kind,'runId',run,'linkId',target,'ballotId',manual_id,'choices',to_jsonb(ids),'questionRevision',p_data->'questionRevision','ballotRevision',p_data->'ballotRevision');
      IF p_admin THEN SELECT jsonb_build_object('payload',r.payload,'response',r.response) INTO cached FROM admin_vote_requests r WHERE room_id=owner AND request_id=request;
      ELSE SELECT jsonb_build_object('payload',r.payload,'response',r.response) INTO cached FROM vote_requests r WHERE link_id=target AND request_id=request; END IF;
      IF cached IS NOT NULL THEN
        IF cached->'payload' IS DISTINCT FROM payload THEN RETURN jsonb_build_object('status',409,'error','idempotency'); END IF;
        IF p_admin THEN RETURN cached->'response'; END IF;
        RETURN vm_session_receipt(cached->'response',p_session);
      END IF;
      IF q.state<>'open' OR q.closes_at<=clock_timestamp() THEN RETURN jsonb_build_object('status',409,'error','closed'); END IF;
      IF NOT p_admin AND NOT vm_run_navigation(target,run,p_question) THEN RETURN jsonb_build_object('status',409,'error','sequence'); END IF;
      IF q.revision<>(p_data->>'questionRevision')::bigint THEN RETURN jsonb_build_object('status',409,'error','changed'); END IF;
      IF cardinality(ids)>q.max_choices OR EXISTS(SELECT 1 FROM unnest(ids) id WHERE NOT EXISTS(SELECT 1 FROM question_options WHERE question_id=p_question AND question_options.id=id)) THEN RETURN jsonb_build_object('status',400,'error','choices'); END IF;
      IF source_kind='reusable' THEN SELECT * INTO saved FROM ballots WHERE run_id=run AND question_id=p_question FOR UPDATE;
      ELSIF target IS NOT NULL THEN SELECT * INTO saved FROM ballots WHERE link_id=target AND question_id=p_question AND source IN ('personal','admin_personal') FOR UPDATE;
      ELSIF manual_id IS NOT NULL THEN SELECT * INTO saved FROM ballots WHERE id=manual_id AND actor_session_id=actor AND question_id=p_question AND source='admin_manual' FOR UPDATE; END IF;
      IF saved.id IS NOT NULL THEN
        IF saved.revision<>(p_data->>'ballotRevision')::bigint THEN RETURN jsonb_build_object('status',409,'error','answer_changed'); END IF;
        IF NOT q.allow_answer_change AND (EXISTS(SELECT 1 FROM ballot_choices WHERE ballot_id=saved.id AND NOT(option_id=ANY(ids))) OR (NOT p_admin AND vm_session_answer(saved.id,p_session)->>'hidden'='true')) THEN RETURN jsonb_build_object('status',409,'error','used'); END IF;
        UPDATE ballots SET origin_session_id=origin WHERE id=saved.id;
        DELETE FROM ballot_choices WHERE ballot_id=saved.id AND NOT(option_id=ANY(ids));
      ELSE
        IF p_data->>'ballotRevision'<>'0' THEN RETURN jsonb_build_object('status',409,'error','answer_changed'); END IF;
        IF cardinality(ids)=0 THEN RETURN jsonb_build_object('status',400,'error','choices'); END IF;
        INSERT INTO ballots(id,room_id,question_id,link_id,source,run_id,actor_session_id,origin_session_id)
          VALUES(COALESCE(manual_id,gen_random_uuid()),owner,p_question,target,source_kind,run,actor,origin) RETURNING * INTO saved;
      END IF;
      INSERT INTO ballot_choices(ballot_id,question_id,room_id,option_id)
        SELECT saved.id,p_question,owner,id FROM unnest(ids) id WHERE NOT EXISTS(SELECT 1 FROM ballot_choices WHERE ballot_id=saved.id AND option_id=id);
      result:=jsonb_build_object('status',200,'answer',vm_ballot_data(saved.id));
      IF p_admin THEN INSERT INTO admin_vote_requests(room_id,request_id,question_id,payload,response) VALUES(owner,request,p_question,payload,result);
      ELSE INSERT INTO vote_requests(link_id,request_id,payload,response) VALUES(target,request,payload,result); END IF;
      RETURN result;
    EXCEPTION WHEN no_data_found THEN RETURN jsonb_build_object('status',409,'error','full');
      WHEN check_violation OR foreign_key_violation OR unique_violation OR invalid_text_representation OR numeric_value_out_of_range THEN RETURN jsonb_build_object('status',400,'error','invalid');
    END $$;
    CREATE OR REPLACE FUNCTION vm_cast_personal(p_link uuid,p_session bytea,p_question uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS(SELECT 1 FROM questions WHERE id=p_question AND question_type='allocation') THEN RETURN vm_cast_allocation(NULL,p_link,p_session,false,p_question,p_data); END IF;
      RETURN vm_cast_personal_before_types(p_link,p_session,p_question,p_data);
    END $$;
    CREATE OR REPLACE FUNCTION vm_cast_ballot(p_room uuid,p_identity uuid,p_session bytea,p_admin boolean,p_question uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS(SELECT 1 FROM questions WHERE id=p_question AND question_type='allocation') THEN RETURN vm_cast_allocation(p_room,p_identity,p_session,p_admin,p_question,p_data); END IF;
      RETURN vm_cast_ballot_before_types(p_room,p_identity,p_session,p_admin,p_question,p_data);
    END $$;

    -- Ordinary votes keep their old navigation and result rules
    DO $$ DECLARE definition text; signature text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_navigation_allowed(uuid,uuid)','vm_run_navigation(uuid,uuid,uuid)'] LOOP
        definition:=pg_get_functiondef(signature::regprocedure);
        definition:=replace(definition,'FROM ballots b WHERE','FROM ballots b WHERE vm_ballot_complete(b.id) AND');
        definition:=replace(definition,'FROM ballots WHERE','FROM ballots WHERE vm_ballot_complete(id) AND');
        EXECUTE definition;
      END LOOP;
      definition:=pg_get_functiondef('vm_journey_with_starts(uuid,bytea,jsonb)'::regprocedure);
      definition:=replace(definition,'AND NOT EXISTS(SELECT 1 FROM ballots b WHERE b.question_id = q.id','AND NOT EXISTS(SELECT 1 FROM ballots b WHERE vm_ballot_complete(b.id) AND b.question_id = q.id');
      definition:=replace(definition,$patch$AND (b.run_id IS NOT DISTINCT FROM run_uuid)) AS answered$patch$,$patch$AND (b.run_id IS NOT DISTINCT FROM run_uuid) AND vm_ballot_complete(b.id)) AS answered$patch$);
      definition:=replace(definition,'count(*) FILTER(WHERE EXISTS(SELECT 1 FROM ballots b WHERE','count(*) FILTER(WHERE EXISTS(SELECT 1 FROM ballots b WHERE vm_ballot_complete(b.id) AND');
      definition:=replace(definition,'count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM ballots b WHERE','count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM ballots b WHERE vm_ballot_complete(b.id) AND');
      definition:=replace(definition,'AND run_id IS NOT DISTINCT FROM run_uuid)) THEN','AND run_id IS NOT DISTINCT FROM run_uuid AND vm_ballot_complete(id))) THEN');
      EXECUTE definition;
      definition:=pg_get_functiondef('vm_results_allowed(uuid,uuid,uuid,boolean)'::regprocedure);
      EXECUTE replace(definition,'FROM ballots b WHERE','FROM ballots b WHERE vm_ballot_complete(b.id) AND');
      definition:=pg_get_functiondef('vm_results_before_review(uuid,bytea,boolean,uuid,jsonb)'::regprocedure);
      definition:=replace(definition,'FROM ballots WHERE question_id=saved.id','FROM ballots WHERE question_id=saved.id AND vm_ballot_complete(id)');
      definition:=replace(definition,'FROM ballots b WHERE b.question_id=saved.id','FROM ballots b WHERE vm_ballot_complete(b.id) AND b.question_id=saved.id');
      definition:=replace(definition,'WHERE option_id=o.id','WHERE option_id=o.id AND vm_ballot_complete(ballot_id)');
      EXECUTE definition;
      definition:=pg_get_functiondef('vm_room_report_before_history(uuid,bytea,boolean,uuid,boolean)'::regprocedure);
      definition:=replace(definition,'FROM ballots b JOIN visible q ON q.id=b.question_id','FROM ballots b JOIN visible q ON q.id=b.question_id WHERE vm_ballot_complete(b.id)');
      definition:=replace(definition,'WHERE option_id=o.id','WHERE option_id=o.id AND vm_ballot_complete(ballot_id)');
      EXECUTE definition;
      definition:=pg_get_functiondef('vm_admin_question_metrics(uuid)'::regprocedure);
      EXECUTE replace(definition,'FROM ballots WHERE question_id=p_question','FROM ballots WHERE vm_ballot_complete(id) AND question_id=p_question');
    END $$;

    CREATE OR REPLACE FUNCTION vm_participant_journey(p_link uuid,p_session bytea,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; page jsonb;
    BEGIN
      result:=vm_participant_journey_before_types(p_link,p_session,p_data);
      IF result->>'status'<>'200' THEN RETURN result; END IF;
      SELECT COALESCE(jsonb_agg(item||jsonb_build_object('questionType',q.question_type)||CASE WHEN q.question_type='allocation' THEN jsonb_build_object('selectedChoices',COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id',o.id,'content',o.content) ORDER BY o.position)
        FROM ballots b JOIN ballot_choices c ON c.ballot_id=b.id JOIN question_options o ON o.id=c.option_id
        WHERE b.question_id=q.id AND b.link_id=p_link AND b.run_id IS NOT DISTINCT FROM (result#>>'{run,id}')::uuid AND COALESCE(vm_session_answer(b.id,p_session)->>'hidden','false')<>'true'
      ),'[]'::jsonb)) ELSE '{}'::jsonb END ORDER BY n),'[]'::jsonb) INTO page
        FROM jsonb_array_elements(result->'questions') WITH ORDINALITY e(item,n) JOIN questions q ON q.id=(item->>'id')::uuid;
      RETURN jsonb_set(result,'{questions}',page);
    END $$;
    CREATE OR REPLACE FUNCTION vm_manual_context(p_room uuid,p_admin bytea,p_question uuid,p_link uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb;
    BEGIN
      result:=vm_manual_context_before_types(p_room,p_admin,p_question,p_link);
      IF result->>'status'='200' AND result#>>'{question,questionType}'='allocation' THEN
        result:=result||jsonb_build_object('answer',(SELECT vm_session_answer(id,p_admin) FROM ballots WHERE link_id=p_link AND question_id=p_question AND run_id IS NULL));
      END IF;
      RETURN result;
    END $$;
    CREATE OR REPLACE FUNCTION vm_event_state(p_identity uuid,p_session bytea,p_admin boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; availability jsonb;
    BEGIN
      result:=vm_event_state_before_types(p_identity,p_session,p_admin);
      IF result->>'status'<>'200' THEN RETURN result; END IF;
      SELECT jsonb_agg(jsonb_build_array(o.id,o.capacity-(SELECT count(*) FROM ballot_choices WHERE option_id=o.id)) ORDER BY o.id) INTO availability
        FROM question_options o JOIN questions q ON q.id=o.question_id WHERE q.room_id=(result->>'roomId')::uuid AND q.question_type='allocation' AND vm_effective_state(q.id)='open';
      RETURN jsonb_set(result,'{version}',to_jsonb(md5((result->>'version')||COALESCE(availability::text,''))));
    END $$;
    REVOKE ALL ON FUNCTION vm_ballot_complete(uuid),vm_cast_allocation(uuid,uuid,bytea,boolean,uuid,jsonb),vm_question_type_guard(),vm_allocation_capacity_guard(),vm_allocation_option_guard() FROM PUBLIC;
  `);
}

// Require a deliberate data conversion before removing allocation semantics
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM questions WHERE question_type<>'choice') THEN RAISE EXCEPTION 'Remove or recover allocation questions before rollback'; END IF; END $$;
    DROP TRIGGER question_type_guard ON questions;
    DROP TRIGGER zz_allocation_capacity_guard ON ballot_choices;
    DROP TRIGGER zz_allocation_option_guard ON question_options;
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY[${signatures.map((s) => `'${s}'`).join(',')}] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(replace(signature,name,name||'_before_types')::regprocedure),'FUNCTION public.'||name||'_before_types(','FUNCTION public.'||name||'(');
        EXECUTE 'DROP FUNCTION '||replace(signature,name,name||'_before_types');
      END LOOP;
    END $$;
    DROP FUNCTION vm_cast_allocation(uuid,uuid,bytea,boolean,uuid,jsonb),vm_ballot_complete(uuid),vm_question_type_guard(),vm_allocation_capacity_guard(),vm_allocation_option_guard();
    ALTER TABLE question_options DROP COLUMN capacity;
    ALTER TABLE questions DROP COLUMN question_type;
  `);
}
