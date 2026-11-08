// Keep roster state and presence consistent across API instances
const signatures = [
  'vm_registration_admin(uuid,bytea,uuid,uuid,text,jsonb)',
  'vm_registration_online(uuid)',
  'vm_question_presence(uuid,bytea,jsonb)',
  'vm_admin_presence(uuid,bytea,jsonb)',
];

// Reuse per-tab presence instead of treating status polls as active devices
export function up(pgm) {
  pgm.sql(`
    DO $$ DECLARE signature text; name text; definition text; BEGIN
      FOREACH signature IN ARRAY ARRAY[${signatures.map((s) => `'${s}'`).join(',')}] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||name||'_before_roster(');
        EXECUTE 'REVOKE ALL ON FUNCTION '||replace(signature,name,name||'_before_roster')||' FROM PUBLIC';
      END LOOP;
      definition:=pg_get_functiondef('vm_question_presence(uuid,bytea,jsonb)'::regprocedure);
      definition:=replace(definition,'IF NOT EXISTS(SELECT 1 FROM vm_voting_access(p_link,p_session)) THEN', 'IF NOT EXISTS(SELECT 1 FROM vm_voting_access(p_link,p_session)) AND vm_registration_access(p_link,p_session) IS NULL THEN');
      definition:=replace(definition,'IF target IS NOT NULL THEN', $patch$IF target IS NOT NULL THEN
        IF EXISTS(SELECT 1 FROM voting_links WHERE id=p_link AND mode='registration') THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;$patch$);
      EXECUTE definition;
    END $$;
    CREATE OR REPLACE FUNCTION vm_registration_online(p_member uuid) RETURNS bigint LANGUAGE sql VOLATILE AS $$
      SELECT count(DISTINCT d.child_session_id) FROM registration_devices d JOIN question_views v ON v.session_id=d.root_session_id
      WHERE d.member_id=p_member AND v.active AND v.seen_at>clock_timestamp()-interval '35 seconds';
    $$;
    CREATE OR REPLACE FUNCTION vm_registration_admin(p_room uuid,p_admin bytea,p_group uuid,p_member uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE g voting_links; m registration_members; page jsonb; next_page text; after_key bigint; filter text;
    BEGIN
      PERFORM 1 FROM rooms WHERE id=p_room AND EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401); END IF;
      SELECT * INTO g FROM voting_links WHERE id=p_group AND room_id=p_room AND mode='registration';
      IF NOT FOUND THEN RETURN jsonb_build_object('status',404); END IF;
      IF p_action='list' THEN
        after_key:=COALESCE((p_data->>'after')::bigint,0);filter:=COALESCE(p_data->>'filter','registered');
        IF after_key<0 OR filter NOT IN ('registered','pending','all') THEN RETURN jsonb_build_object('status',400); END IF;
        WITH selected AS MATERIALIZED (
          SELECT * FROM registration_members WHERE group_id=p_group AND (after_key=0 OR ordinal<after_key) AND (filter='all' OR (filter='pending' AND state='pending') OR (filter='registered' AND state='approved')) ORDER BY ordinal DESC LIMIT 51
        ), visible AS (SELECT * FROM selected ORDER BY ordinal DESC LIMIT 50)
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'state',v.state,'blocked',v.blocked,'revision',v.revision::text,'ordinal',v.ordinal::text,'online',vm_registration_online(v.id),
          'questions',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',q.id,'preview',left(q.content,240)) ORDER BY q.ordinal) FROM questions q WHERE EXISTS(SELECT 1 FROM question_views p JOIN voting_sessions s ON s.id=p.session_id WHERE p.link_id=v.link_id AND s.generation=(SELECT generation FROM voting_links WHERE id=v.link_id) AND p.question_id=q.id AND p.active AND p.seen_at>clock_timestamp()-interval '35 seconds')),'[]'::jsonb)) ORDER BY v.ordinal DESC),'[]'::jsonb),CASE WHEN (SELECT count(*) FROM selected)>50 THEN min(v.ordinal)::text END INTO page,next_page FROM visible v;
        RETURN jsonb_build_object('status',200,'members',page,'nextCursor',next_page,'pendingCount',(SELECT count(*) FROM registration_members WHERE group_id=p_group AND state='pending'),'registeredCount',(SELECT count(*) FROM registration_members WHERE group_id=p_group AND state='approved'));
      END IF;
      IF p_action='settings' THEN
        IF jsonb_typeof(p_data->'enabled') IS DISTINCT FROM 'boolean' THEN RETURN jsonb_build_object('status',400); END IF;
        UPDATE voting_links SET require_moderation=(p_data->>'enabled')::boolean WHERE id=g.id;
        RETURN jsonb_build_object('status',200);
      END IF;
      SELECT * INTO m FROM registration_members WHERE id=p_member AND group_id=p_group FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',404); END IF;
      IF p_action='secret' THEN RETURN (SELECT jsonb_build_object('status',200,'cipher',encode(secret_cipher,'hex'),'hash',encode(secret_hash,'hex')) FROM voting_links WHERE id=m.link_id); END IF;
      IF p_data->>'revision' IS DISTINCT FROM m.revision::text THEN RETURN jsonb_build_object('status',409,'error','conflict'); END IF;
      IF p_action='rename' THEN
        IF jsonb_typeof(p_data->'name') IS DISTINCT FROM 'string' OR char_length(btrim(p_data->>'name')) NOT BETWEEN 1 AND 200 THEN RETURN jsonb_build_object('status',400); END IF;
        UPDATE voting_links SET name=btrim(p_data->>'name') WHERE id=m.link_id;
        UPDATE registration_members SET name=btrim(p_data->>'name') WHERE id=m.id;
      ELSIF p_action='approve' THEN UPDATE registration_members SET state='approved' WHERE id=m.id;
      ELSIF p_action='reject' THEN
        IF m.state<>'pending' THEN RETURN jsonb_build_object('status',409); END IF;
        UPDATE registration_members SET state='rejected' WHERE id=m.id;
      ELSIF p_action='block' THEN UPDATE registration_members SET blocked=true WHERE id=m.id;
      ELSIF p_action='unblock' THEN UPDATE registration_members SET blocked=false WHERE id=m.id;
      ELSIF p_action='call' THEN UPDATE registration_members SET call_sequence=call_sequence+1,called_at=clock_timestamp() WHERE id=m.id;
      ELSE RETURN jsonb_build_object('status',400); END IF;
      RETURN jsonb_build_object('status',200);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN jsonb_build_object('status',400); END $$;

    CREATE OR REPLACE FUNCTION vm_admin_presence(p_room uuid,p_session bytea,p_ids jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; page jsonb;
    BEGIN
      result:=vm_admin_presence_before_roster(p_room,p_session,p_ids);
      IF (result->>'status')::integer<>200 THEN RETURN result; END IF;
      SELECT COALESCE(jsonb_agg(CASE WHEN l.mode='registration' THEN item||jsonb_build_object(
        'pendingCount',(SELECT count(*) FROM registration_members WHERE group_id=l.id AND state='pending'),
        'registeredCount',(SELECT count(*) FROM registration_members WHERE group_id=l.id AND state='approved')) ELSE item END ORDER BY n),'[]'::jsonb) INTO page
      FROM jsonb_array_elements(result->'links') WITH ORDINALITY e(item,n) JOIN voting_links l ON l.id=(item->>'id')::uuid;
      RETURN result||jsonb_build_object('links',page);
    END $$;
  `);
}

// Restore the previous roster without deleting members or answers
export function down(pgm) {
  pgm.sql(`
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY[${signatures.map((s) => `'${s}'`).join(',')}] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(replace(signature,name,name||'_before_roster')::regprocedure),'FUNCTION public.'||name||'_before_roster(','FUNCTION public.'||name||'(');
        EXECUTE 'DROP FUNCTION '||replace(signature,name,name||'_before_roster');
      END LOOP;
    END $$;
  `);
}
