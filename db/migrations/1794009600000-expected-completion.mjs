// Finish a question only after its saved electorate has answered
export function up(pgm) {
  pgm.sql(`
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_question_guard()','vm_store_question(uuid,bytea,uuid,text,jsonb)','vm_question_request(uuid,bytea,uuid,text,jsonb)','vm_question_lifecycle(uuid,bytea,uuid,jsonb)','vm_question_data(uuid)'] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||name||'_before_completion(');
        EXECUTE 'REVOKE ALL ON FUNCTION '||replace(signature,name,name||'_before_completion')||' FROM PUBLIC';
      END LOOP;
    END $$;
    ALTER TABLE questions ADD COLUMN close_when_all_answered boolean NOT NULL DEFAULT false;
    ALTER TABLE questions ADD COLUMN expected_link_ids uuid[] NOT NULL DEFAULT '{}';
    ALTER TABLE questions DROP CONSTRAINT questions_closed_reason_check;
    ALTER TABLE questions ADD CONSTRAINT questions_closed_reason_check CHECK(closed_reason IN ('manual','deadline','all_voted'));
    CREATE TABLE question_expected_links (
      question_id uuid NOT NULL,
      room_id uuid NOT NULL,
      link_id uuid NOT NULL,
      PRIMARY KEY(question_id,link_id),
      FOREIGN KEY(question_id,room_id) REFERENCES questions(id,room_id) ON DELETE CASCADE,
      FOREIGN KEY(link_id,room_id) REFERENCES voting_links(id,room_id) ON DELETE RESTRICT
    );
    CREATE FUNCTION vm_expected_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target uuid; saved questions;
    BEGIN
      IF TG_OP='UPDATE' THEN RAISE check_violation USING MESSAGE='Expected identities cannot change'; END IF;
      target:=CASE WHEN TG_OP='DELETE' THEN OLD.question_id ELSE NEW.question_id END;
      SELECT * INTO saved FROM questions WHERE id=target;
      IF pg_trigger_depth()=1 AND (saved.state='open' OR saved.scheduled_at IS NOT NULL) AND NOT saved.deleting THEN RAISE check_violation USING MESSAGE='Expected set is fixed'; END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      IF NOT EXISTS(SELECT 1 FROM voting_links WHERE id=NEW.link_id AND room_id=NEW.room_id AND mode='personal') THEN RAISE check_violation USING MESSAGE='Expected link must be personal'; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER expected_link_guard BEFORE INSERT OR UPDATE OR DELETE ON question_expected_links FOR EACH ROW EXECUTE FUNCTION vm_expected_link_guard();
    CREATE FUNCTION vm_all_expected_answered(p_question uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
      SELECT EXISTS(SELECT 1 FROM question_expected_links WHERE question_id=p_question) AND NOT EXISTS(
        SELECT 1 FROM question_expected_links e WHERE e.question_id=p_question AND NOT EXISTS(
          SELECT 1 FROM ballots b JOIN questions q ON q.id=b.question_id WHERE b.question_id=p_question AND b.link_id=e.link_id AND b.source IN ('personal','admin_personal')
          AND (SELECT count(*) FROM ballot_choices WHERE ballot_id=b.id) BETWEEN q.min_choices AND q.max_choices
        )
      );
    $$;
    DO $$ DECLARE definition text; BEGIN
      definition:=pg_get_functiondef('vm_question_guard()'::regprocedure);
      definition:=replace(definition,$patch$IF OLD.first_opened_at IS NOT NULL AND ($patch$,$patch$IF (OLD.state='open' OR OLD.scheduled_at IS NOT NULL) AND NEW.hide_results_until_end IS DISTINCT FROM OLD.hide_results_until_end THEN RAISE check_violation USING MESSAGE='Hidden result rule is fixed'; END IF;
      IF (OLD.state='open' OR OLD.scheduled_at IS NOT NULL) AND ROW(NEW.close_when_all_answered,NEW.expected_link_ids) IS DISTINCT FROM ROW(OLD.close_when_all_answered,OLD.expected_link_ids) THEN RAISE check_violation USING MESSAGE='Expected links are fixed during this opening'; END IF;
      IF OLD.first_opened_at IS NOT NULL AND ($patch$);
      definition:=replace(definition,$patch$NEW.opened_at := clock_timestamp();$patch$,$patch$
        IF NEW.close_when_all_answered THEN
          IF cardinality(NEW.expected_link_ids)=0 THEN RAISE check_violation USING MESSAGE='Expected links are empty'; END IF;
          DELETE FROM question_expected_links WHERE question_id=NEW.id;
          INSERT INTO question_expected_links(question_id,room_id,link_id) SELECT NEW.id,NEW.room_id,id FROM unnest(NEW.expected_link_ids) id;
          IF vm_all_expected_answered(NEW.id) THEN RAISE check_violation USING MESSAGE='Expected links have already answered'; END IF;
        ELSE DELETE FROM question_expected_links WHERE question_id=NEW.id; END IF;
        NEW.opened_at := clock_timestamp();$patch$);
      definition:=replace(definition,$patch$THEN 'deadline' ELSE 'manual' END;$patch$,$patch$THEN 'deadline' ELSE CASE WHEN NEW.closed_reason='all_voted' AND OLD.close_when_all_answered AND vm_all_expected_answered(NEW.id) THEN 'all_voted' ELSE 'manual' END END;$patch$);
      definition:=replace(definition,'NEW.max_choices,NEW.hide_results_until_end','NEW.max_choices');
      definition:=replace(definition,'OLD.max_choices,OLD.hide_results_until_end','OLD.max_choices');
      EXECUTE definition;
    END $$;
    CREATE FUNCTION vm_complete_answers() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE item record;
    BEGIN
      FOR item IN SELECT DISTINCT room_id,question_id FROM completed_choices ORDER BY room_id,question_id LOOP
        PERFORM 1 FROM rooms WHERE id=item.room_id FOR UPDATE;
        UPDATE questions SET state='closed',closed_reason='all_voted' WHERE id=item.question_id AND state='open' AND close_when_all_answered AND vm_all_expected_answered(id);
      END LOOP;
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER zz_complete_answers AFTER INSERT ON ballot_choices REFERENCING NEW TABLE AS completed_choices FOR EACH STATEMENT EXECUTE FUNCTION vm_complete_answers();
    CREATE OR REPLACE FUNCTION vm_question_data(p_id uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
      SELECT vm_question_data_before_completion(p_id)||jsonb_build_object('closeWhenAllAnswered',close_when_all_answered) FROM questions WHERE id=p_id;
    $$;
    CREATE FUNCTION vm_completion_admin(p_id uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
      SELECT jsonb_build_object('closeWhenAllAnswered',close_when_all_answered,'expectedLinkIds',to_jsonb(expected_link_ids),'expectedTotal',(SELECT count(*) FROM question_expected_links WHERE question_id=p_id),'expectedAnswered',(SELECT count(*) FROM question_expected_links e WHERE e.question_id=p_id AND EXISTS(SELECT 1 FROM ballots WHERE question_id=p_id AND link_id=e.link_id AND source IN ('personal','admin_personal')))) FROM questions WHERE id=p_id;
    $$;
    CREATE OR REPLACE FUNCTION vm_store_question(p_room uuid,p_admin bytea,p_id uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE saved questions; enabled boolean; ids uuid[]; result jsonb; abort_reply jsonb; opening boolean; desired text; document jsonb;
    BEGIN
      PERFORM 1 FROM rooms WHERE id=p_room AND EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF p_action='save' THEN
        SELECT * INTO saved FROM questions WHERE id=p_id AND room_id=p_room FOR UPDATE;
        IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
        IF p_data->>'revision' IS DISTINCT FROM saved.revision::text THEN RETURN vm_store_question_before_completion(p_room,p_admin,p_id,p_action,p_data); END IF;
      END IF;
      IF p_data ? 'closeWhenAllAnswered' AND jsonb_typeof(p_data->'closeWhenAllAnswered') IS DISTINCT FROM 'boolean' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      enabled:=COALESCE((p_data->>'closeWhenAllAnswered')::boolean,saved.close_when_all_answered,false);
      ids:=COALESCE(saved.expected_link_ids,'{}');
      IF p_data ? 'expectedLinkIds' THEN
        IF jsonb_typeof(p_data->'expectedLinkIds') IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'expectedLinkIds') value WHERE jsonb_typeof(value)<>'string') THEN RETURN jsonb_build_object('status',400,'error','electorate'); END IF;
        SELECT COALESCE(array_agg((value#>>'{}')::uuid ORDER BY (value#>>'{}')::uuid),'{}') INTO ids FROM jsonb_array_elements(p_data->'expectedLinkIds') value;
        IF cardinality(ids)<>(SELECT count(DISTINCT id) FROM unnest(ids) id) THEN RETURN jsonb_build_object('status',400,'error','electorate'); END IF;
      END IF;
      desired:=COALESCE(p_data->>'state',saved.state,'draft');
      opening:=p_data->>'state'='open' AND COALESCE(saved.state,'draft')<>'open';
      IF (saved.state='open' OR saved.scheduled_at IS NOT NULL) AND ROW(enabled,ids) IS DISTINCT FROM ROW(saved.close_when_all_answered,saved.expected_link_ids) THEN RETURN jsonb_build_object('status',409,'error','electorate_locked'); END IF;
      IF (ROW(enabled,ids) IS DISTINCT FROM ROW(saved.close_when_all_answered,saved.expected_link_ids) OR opening) AND enabled THEN
        IF cardinality(ids)=0 OR EXISTS(SELECT 1 FROM unnest(ids) selected(id) WHERE NOT EXISTS(SELECT 1 FROM voting_links l WHERE l.id=selected.id AND l.room_id=p_room AND l.mode='personal' AND l.revoked_at IS NULL)) THEN RETURN jsonb_build_object('status',400,'error','electorate'); END IF;
        IF opening AND NOT EXISTS(SELECT 1 FROM unnest(ids) selected(id) WHERE NOT EXISTS(SELECT 1 FROM ballots WHERE question_id=p_id AND link_id=selected.id AND source IN ('personal','admin_personal'))) THEN RETURN jsonb_build_object('status',409,'error','complete'); END IF;
      END IF;
      IF (saved.state='open' OR saved.scheduled_at IS NOT NULL) AND (p_data->>'hideResultsUntilEnd')::boolean IS DISTINCT FROM saved.hide_results_until_end THEN RETURN jsonb_build_object('status',409,'error','locked'); END IF;
      IF saved.id IS NOT NULL THEN UPDATE questions SET close_when_all_answered=enabled,expected_link_ids=ids WHERE id=p_id AND ROW(close_when_all_answered,expected_link_ids) IS DISTINCT FROM ROW(enabled,ids); END IF;
      result:=vm_store_question_before_completion(p_room,p_admin,p_id,p_action,CASE WHEN saved.id IS NOT NULL THEN p_data||jsonb_build_object('revision',(SELECT revision::text FROM questions WHERE id=p_id)) ELSE p_data||jsonb_build_object('state','draft') END);
      IF result->>'status' NOT IN ('200','201') THEN abort_reply:=result;RAISE EXCEPTION USING ERRCODE='P0001'; END IF;
      p_id:=(result#>>'{question,id}')::uuid;
      IF saved.id IS NULL THEN
        UPDATE questions SET close_when_all_answered=enabled,expected_link_ids=ids WHERE id=p_id;
        IF desired<>'draft' THEN
          document:=p_data||vm_question_data(p_id)||jsonb_build_object('state',desired,'revision',(SELECT revision::text FROM questions WHERE id=p_id));
          result:=vm_store_question_before_completion(p_room,p_admin,p_id,'save',document);
          IF result->>'status'<>'200' THEN abort_reply:=result;RAISE EXCEPTION USING ERRCODE='P0001'; END IF;
        END IF;
      END IF;
      RETURN jsonb_build_object('status',CASE WHEN p_action='create' THEN 201 ELSE 200 END,'question',vm_question_data(p_id)||vm_admin_question_metrics(p_id)||vm_completion_admin(p_id));
    EXCEPTION WHEN raise_exception THEN RETURN abort_reply;
      WHEN check_violation OR foreign_key_violation OR invalid_text_representation OR numeric_value_out_of_range THEN RETURN jsonb_build_object('status',400,'error','electorate');
    END;
    $$;
    CREATE OR REPLACE FUNCTION vm_question_request(p_room uuid,p_admin bytea,p_id uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb;
    BEGIN
      IF p_action IN ('create','save') AND p_data ? 'closeWhenAllAnswered' THEN result:=vm_store_question(p_room,p_admin,p_id,p_action,p_data);
      ELSE result:=vm_question_request_before_completion(p_room,p_admin,p_id,p_action,p_data); END IF;
      IF result->>'status' IN ('200','201') AND result ? 'question' THEN result:=jsonb_set(result,'{question}',result->'question'||vm_completion_admin((result#>>'{question,id}')::uuid)); END IF;
      RETURN result;
    END;
    $$;
    CREATE OR REPLACE FUNCTION vm_question_lifecycle(p_room uuid,p_admin bytea,p_id uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb;
    BEGIN
      result:=vm_question_lifecycle_before_completion(p_room,p_admin,p_id,p_data);
      IF result->>'status'='200' THEN result:=jsonb_set(result,'{question}',result->'question'||vm_completion_admin(p_id)); END IF;
      RETURN result;
    END;
    $$;
    REVOKE ALL ON FUNCTION vm_expected_link_guard(),vm_all_expected_answered(uuid),vm_complete_answers(),vm_completion_admin(uuid) FROM PUBLIC;
  `);
}
// Require an explicit recovery decision before dropping completion history
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM questions WHERE close_when_all_answered OR closed_reason='all_voted') OR EXISTS(SELECT 1 FROM question_expected_links) THEN RAISE EXCEPTION 'Recover completion questions before rollback'; END IF; END $$;
    DROP TRIGGER zz_complete_answers ON ballot_choices;
    DROP FUNCTION vm_complete_answers();
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_question_guard_before_completion()','vm_store_question_before_completion(uuid,bytea,uuid,text,jsonb)','vm_question_request_before_completion(uuid,bytea,uuid,text,jsonb)','vm_question_lifecycle_before_completion(uuid,bytea,uuid,jsonb)','vm_question_data_before_completion(uuid)'] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||replace(name,'_before_completion','')||'(');
        EXECUTE 'DROP FUNCTION '||signature;
      END LOOP;
    END $$;
    DROP FUNCTION vm_completion_admin(uuid),vm_all_expected_answered(uuid);
    DROP TABLE question_expected_links;
    DROP FUNCTION vm_expected_link_guard();
    ALTER TABLE questions DROP COLUMN close_when_all_answered,DROP COLUMN expected_link_ids;
    ALTER TABLE questions DROP CONSTRAINT questions_closed_reason_check;
    ALTER TABLE questions ADD CONSTRAINT questions_closed_reason_check CHECK(closed_reason IN ('manual','deadline'));
  `);
}
