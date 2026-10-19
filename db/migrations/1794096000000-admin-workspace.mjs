// Keep online metadata and projector snapshots behind admin access
export function up(pgm) {
  pgm.sql(`
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_results(uuid,bytea,boolean,uuid,jsonb)','vm_event_state(uuid,bytea,boolean)','vm_question_presence(uuid,bytea,jsonb)'] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||name||'_before_workspace15(');
        EXECUTE 'REVOKE ALL ON FUNCTION '||replace(signature,name,name||'_before_workspace15')||' FROM PUBLIC';
      END LOOP;
    END $$;
    ALTER TABLE question_views ADD COLUMN active boolean NOT NULL DEFAULT true;
    DO $$ DECLARE definition text; BEGIN
      definition:=pg_get_functiondef('vm_question_presence(uuid,bytea,jsonb)'::regprocedure);
      definition:=replace(definition,'target:=(p_data->>''questionId'')::uuid;', 'IF p_data ? ''active'' AND jsonb_typeof(p_data->''active'') IS DISTINCT FROM ''boolean'' THEN RETURN jsonb_build_object(''status'',400,''error'',''invalid''); END IF; target:=CASE WHEN p_data->>''active''=''false'' THEN NULL ELSE (p_data->>''questionId'')::uuid END;');
      definition:=replace(definition,'tab_id,sequence,question_id) VALUES(owner,p_link,current_session,tab,serial,target)', 'tab_id,sequence,question_id,active) VALUES(owner,p_link,current_session,tab,serial,target,COALESCE((p_data->>''active'')::boolean,target IS NOT NULL))');
      definition:=replace(definition,'sequence=EXCLUDED.sequence,question_id=EXCLUDED.question_id,seen_at=', 'sequence=EXCLUDED.sequence,question_id=EXCLUDED.question_id,active=EXCLUDED.active,seen_at=');
      EXECUTE definition;
    END $$;
    CREATE FUNCTION vm_admin_presence(p_room uuid,p_session bytea,p_ids jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE items jsonb;
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_session)) THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF jsonb_typeof(p_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(p_ids)>50 THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',l.id,'online',CASE WHEN l.revoked_at IS NOT NULL THEN 0 WHEN l.mode='personal' THEN LEAST(1,(SELECT count(*) FROM question_views v JOIN voting_sessions s ON s.id=v.session_id WHERE v.link_id=l.id AND s.generation=l.generation AND v.active AND v.seen_at>clock_timestamp()-interval '35 seconds')) ELSE (SELECT count(DISTINCT v.session_id) FROM question_views v JOIN voting_sessions s ON s.id=v.session_id WHERE v.link_id=l.id AND s.generation=l.generation AND v.active AND v.seen_at>clock_timestamp()-interval '35 seconds') END,
        'questions',CASE WHEN l.mode='personal' AND l.revoked_at IS NULL THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('id',q.id,'preview',left(q.content,240)) ORDER BY q.ordinal) FROM questions q WHERE EXISTS(SELECT 1 FROM question_views v JOIN voting_sessions s ON s.id=v.session_id WHERE v.link_id=l.id AND s.generation=l.generation AND v.question_id=q.id AND v.seen_at>clock_timestamp()-interval '35 seconds')),'[]'::jsonb) ELSE '[]'::jsonb END) ORDER BY l.ordinal),'[]') INTO items FROM voting_links l WHERE l.room_id=p_room AND l.id IN (SELECT (value#>>'{}')::uuid FROM jsonb_array_elements(p_ids) value);
      RETURN jsonb_build_object('status',200,'links',items);
    EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('status',400,'error','invalid');
    END;
    $$;
    CREATE OR REPLACE FUNCTION vm_results(p_identity uuid,p_session bytea,p_admin boolean,p_question uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb;
    BEGIN
      result:=vm_results_before_workspace15(p_identity,p_session,p_admin,p_question,p_data);
      IF p_admin AND p_data->>'view'='projector' AND result ? 'result' THEN result:=jsonb_set(result,'{result}',((result->'result')-'people'-'nextPeopleCursor'-'sources')||(SELECT jsonb_build_object('content',content,'state',vm_effective_state(id),'closesAt',closes_at,'scheduledAt',scheduled_at,'answerCount',(SELECT count(*) FROM ballots WHERE question_id=p_question)) FROM questions WHERE id=p_question)); END IF;
      RETURN result;
    END;
    $$;
    DO $$ DECLARE definition text; BEGIN
      definition:=pg_get_functiondef('vm_event_state(uuid,bytea,boolean)'::regprocedure);
      EXECUTE replace(definition,$patch$'metrics',CASE WHEN p_admin$patch$,$patch$'online',CASE WHEN p_admin THEN (SELECT jsonb_agg(to_jsonb(online_row) ORDER BY online_row.link_id,online_row.question_id) FROM (SELECT v.link_id,v.question_id,count(DISTINCT CASE WHEN l.mode='personal' THEN l.id ELSE v.session_id END) AS viewers FROM question_views v JOIN voting_links l ON l.id=v.link_id JOIN voting_sessions s ON s.id=v.session_id WHERE v.room_id=owner AND l.revoked_at IS NULL AND s.generation=l.generation AND v.active AND v.seen_at>clock_timestamp()-interval '35 seconds' GROUP BY v.link_id,v.question_id) online_row) END,
        'metrics',CASE WHEN p_admin$patch$);
    END $$;
    REVOKE ALL ON FUNCTION vm_admin_presence(uuid,bytea,jsonb) FROM PUBLIC;
  `);
}
// Drop only presentation functions, all room data stays intact
export function down(pgm) {
  pgm.sql(`
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY['vm_results_before_workspace15(uuid,bytea,boolean,uuid,jsonb)','vm_event_state_before_workspace15(uuid,bytea,boolean)','vm_question_presence_before_workspace15(uuid,bytea,jsonb)'] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||replace(name,'_before_workspace15','')||'(');
        EXECUTE 'DROP FUNCTION '||signature;
      END LOOP;
    END $$;
    DROP FUNCTION vm_admin_presence(uuid,bytea,jsonb);
    ALTER TABLE question_views DROP COLUMN active;
  `);
}
