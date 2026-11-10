// Keep saved policies and votes through the upgrade
const signatures = [
  'vm_store_question_before_reset(uuid,bytea,uuid,text,jsonb)',
  'vm_ballot_guard()',
  'vm_ballot_choice_guard()',
  'vm_ballot_choices_touch()',
  'vm_room_report_before_history(uuid,bytea,boolean,uuid,boolean)',
];

export function up(pgm) {
  pgm.sql(`
    ALTER TABLE rooms ALTER COLUMN lock_questions_after_open SET DEFAULT false;
    ALTER TABLE voting_links ADD COLUMN deleting boolean NOT NULL DEFAULT false CHECK(NOT deleting OR revoked_at IS NOT NULL);
    ALTER TABLE ballots ADD COLUMN retained_participant uuid;
    ALTER TABLE ballots DROP CONSTRAINT ballot_context;
    ALTER TABLE ballots ADD CONSTRAINT ballot_context CHECK(
      (retained_participant IS NOT NULL AND source<>'admin_manual' AND link_id IS NULL AND run_id IS NULL AND origin_session_id IS NULL AND actor_session_id IS NULL)
      OR (retained_participant IS NULL AND (
        (source='personal' AND link_id IS NOT NULL AND run_id IS NULL AND actor_session_id IS NULL) OR
        (source='admin_personal' AND link_id IS NOT NULL AND run_id IS NULL AND actor_session_id IS NOT NULL) OR
        (source='reusable' AND link_id IS NOT NULL AND run_id IS NOT NULL AND actor_session_id IS NULL) OR
        (source='admin_manual' AND link_id IS NULL AND run_id IS NULL AND actor_session_id IS NOT NULL)
      ))
    );
    -- A fixed electorate keeps the deleted slot until the question is reconfigured
    ALTER TABLE question_expected_links DROP CONSTRAINT question_expected_links_link_id_room_id_fkey;
    DO $$ DECLARE signature text; name text; definition text; BEGIN
      FOREACH signature IN ARRAY ARRAY[${signatures.map((item) => `'${item}'`).join(',')}] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||name||'_before_link_removal(');
        EXECUTE 'REVOKE ALL ON FUNCTION '||replace(signature,name,name||'_before_link_removal')||' FROM PUBLIC';
      END LOOP;

      -- Lifecycle snapshots include live capacity that cannot be edited
      definition:=pg_get_functiondef('vm_store_question_before_reset(uuid,bytea,uuid,text,jsonb)'::regprocedure);
      IF position($patch$= p_data->'choices';$patch$ IN definition)=0 THEN RAISE EXCEPTION 'Missing locked choices comparison'; END IF;
      EXECUTE replace(definition,$patch$= p_data->'choices';$patch$,$patch$= (SELECT COALESCE(jsonb_agg(item-'remaining' ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements(p_data->'choices') WITH ORDINALITY e(item,n));$patch$);

      definition:=pg_get_functiondef('vm_ballot_guard()'::regprocedure);
      EXECUTE replace(definition,$patch$IF TG_OP='DELETE' THEN RAISE check_violation; END IF;$patch$,$patch$
      IF TG_OP='DELETE' AND vm_link_answer_cleanup(OLD.link_id,OLD.question_id,false) THEN RETURN OLD; END IF;
      IF TG_OP='UPDATE' AND vm_link_answer_cleanup(OLD.link_id,OLD.question_id,true)
        AND NEW.retained_participant IS NOT NULL
        AND (to_jsonb(NEW)-ARRAY['link_id','run_id','origin_session_id','actor_session_id','retained_participant'])
          =(to_jsonb(OLD)-ARRAY['link_id','run_id','origin_session_id','actor_session_id','retained_participant']) THEN
        RETURN NEW;
      END IF;
      IF TG_OP='DELETE' OR NEW.retained_participant IS NOT NULL THEN RAISE check_violation; END IF;$patch$);

      definition:=pg_get_functiondef('vm_ballot_choice_guard()'::regprocedure);
      EXECUTE replace(definition,$patch$question := vm_ballot_lock$patch$,$patch$
      IF TG_OP='DELETE' AND vm_link_answer_cleanup(ballot.link_id,ballot.question_id,false) THEN RETURN OLD; END IF;
      IF ballot.retained_participant IS NOT NULL THEN RAISE check_violation; END IF;
      question := vm_ballot_lock$patch$);

      definition:=pg_get_functiondef('vm_ballot_choices_touch()'::regprocedure);
      EXECUTE replace(definition,'WHERE id IN (SELECT ballot_id FROM changed_choices);',
        'WHERE id IN (SELECT ballot_id FROM changed_choices) AND NOT vm_link_answer_cleanup(b.link_id,b.question_id,false);');

      definition:=pg_get_functiondef('vm_room_report_before_history(uuid,bytea,boolean,uuid,boolean)'::regprocedure);
      definition:=replace(definition,$patch$CASE WHEN b.source IN ('personal','admin_personal') THEN 'p:'$patch$,$patch$CASE WHEN b.retained_participant IS NOT NULL THEN 'a:'||b.retained_participant WHEN b.source IN ('personal','admin_personal') THEN 'p:'$patch$);
      EXECUTE replace(definition,
        'JOIN voting_links l ON l.id=b.link_id WHERE p_admin AND NOT q.anonymous',
        'JOIN voting_links own ON own.id=b.link_id JOIN voting_links l ON l.id=COALESCE(own.registration_group_id,own.id) WHERE p_admin AND NOT q.anonymous');
    END $$;

    -- Allow cleanup only for links marked inside the removal transaction
    CREATE FUNCTION vm_link_answer_cleanup(p_link uuid,p_question uuid,p_anonymous boolean) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS(SELECT 1 FROM voting_links l JOIN questions q ON q.room_id=l.room_id
        WHERE l.id=p_link AND l.deleting AND q.id=p_question AND q.anonymous=p_anonymous);
    $$;

    CREATE FUNCTION vm_delete_voting_link(p_room uuid,p_admin bytea,p_link uuid,p_revision text) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE saved voting_links; affected uuid[];
    BEGIN
      PERFORM 1 FROM rooms WHERE id=p_room AND EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      SELECT * INTO saved FROM voting_links WHERE room_id=p_room AND id=p_link AND registration_group_id IS NULL FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      IF saved.revoked_at IS NULL OR saved.revision::text IS DISTINCT FROM p_revision THEN
        RETURN jsonb_build_object('status',409,'error','conflict');
      END IF;
      SELECT array_agg(id) INTO affected FROM voting_links WHERE id=p_link OR registration_group_id=p_link;
      UPDATE voting_links SET deleting=true,revoked_at=COALESCE(revoked_at,statement_timestamp()) WHERE id=ANY(affected);

      -- Keep anonymous counts and the number of distinct voters without their old IDs
      WITH voters AS MATERIALIZED (
        SELECT identity,gen_random_uuid() AS retained
        FROM (SELECT DISTINCT COALESCE(b.run_id,b.link_id) AS identity FROM ballots b JOIN questions q ON q.id=b.question_id
          WHERE b.link_id=ANY(affected) AND q.anonymous) distinct_voters
      )
      UPDATE ballots b SET retained_participant=v.retained,link_id=NULL,run_id=NULL,origin_session_id=NULL,actor_session_id=NULL
      FROM voters v,questions q
      WHERE b.link_id=ANY(affected) AND q.id=b.question_id AND q.anonymous AND v.identity=COALESCE(b.run_id,b.link_id);

      DELETE FROM ballot_choices c USING ballots b WHERE b.id=c.ballot_id AND b.link_id=ANY(affected);
      DELETE FROM ballots WHERE link_id=ANY(affected);
      DELETE FROM admin_vote_requests WHERE room_id=p_room AND (payload->>'linkId')::uuid=ANY(affected);
      DELETE FROM vote_requests WHERE link_id=ANY(affected);
      DELETE FROM question_views WHERE link_id=ANY(affected);
      DELETE FROM registration_devices WHERE member_id IN (SELECT id FROM registration_members WHERE group_id=p_link);
      DELETE FROM registration_members WHERE group_id=p_link;
      DELETE FROM voting_runs WHERE link_id=ANY(affected);
      DELETE FROM voting_sessions WHERE link_id=ANY(affected);
      DELETE FROM voting_links WHERE registration_group_id=p_link;
      DELETE FROM voting_links WHERE id=p_link;
      RETURN jsonb_build_object('status',200,'deletedId',p_link);
    END $$;

    REVOKE ALL ON FUNCTION vm_link_answer_cleanup(uuid,uuid,boolean),vm_delete_voting_link(uuid,bytea,uuid,text) FROM PUBLIC;
  `);
}

// Require data recovery before restoring references that no longer exist
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM ballots WHERE retained_participant IS NOT NULL)
        OR EXISTS(SELECT 1 FROM question_expected_links e LEFT JOIN voting_links l ON l.id=e.link_id WHERE l.id IS NULL)
      THEN RAISE EXCEPTION 'Recover deleted link references before rollback'; END IF;
    END $$;
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY[${signatures.map((item) => `'${item}'`).join(',')}] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(replace(signature,name,name||'_before_link_removal')::regprocedure),'FUNCTION public.'||name||'_before_link_removal(','FUNCTION public.'||name||'(');
        EXECUTE 'DROP FUNCTION '||replace(signature,name,name||'_before_link_removal');
      END LOOP;
    END $$;
    DROP FUNCTION vm_delete_voting_link(uuid,bytea,uuid,text),vm_link_answer_cleanup(uuid,uuid,boolean);
    ALTER TABLE question_expected_links ADD CONSTRAINT question_expected_links_link_id_room_id_fkey FOREIGN KEY(link_id,room_id) REFERENCES voting_links(id,room_id) ON DELETE RESTRICT;
    ALTER TABLE ballots DROP CONSTRAINT ballot_context;
    ALTER TABLE ballots DROP COLUMN retained_participant;
    ALTER TABLE ballots ADD CONSTRAINT ballot_context CHECK(
      (source='personal' AND link_id IS NOT NULL AND run_id IS NULL AND actor_session_id IS NULL) OR
      (source='admin_personal' AND link_id IS NOT NULL AND run_id IS NULL AND actor_session_id IS NOT NULL) OR
      (source='reusable' AND link_id IS NOT NULL AND run_id IS NOT NULL AND actor_session_id IS NULL) OR
      (source='admin_manual' AND link_id IS NULL AND run_id IS NULL AND actor_session_id IS NOT NULL)
    );
    ALTER TABLE voting_links DROP COLUMN deleting;
    ALTER TABLE rooms ALTER COLUMN lock_questions_after_open SET DEFAULT true;
  `);
}
