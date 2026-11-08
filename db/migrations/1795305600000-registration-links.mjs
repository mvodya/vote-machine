// Preserve ordinary voting while adding browser-owned group registrations
const signatures = [
  'vm_voting_access(uuid,bytea)',
  'vm_exchange_voting_session(uuid,bytea,bytea,bytea)',
  'vm_list_voting_links(uuid,bytea,bigint,integer)',
  'vm_add_voting_links(uuid,bytea,jsonb)',
  'vm_ballot_lock(uuid,uuid,uuid)',
  'vm_delete_room(uuid,bytea,jsonb)',
  'vm_event_state(uuid,bytea,boolean)',
  'vm_results(uuid,bytea,boolean,uuid,jsonb)',
  'vm_room_report(uuid,bytea,boolean,uuid,boolean)',
  'vm_admin_presence(uuid,bytea,jsonb)',
];

// New members use private personal rights, independent of their group's secret
export function up(pgm) {
  pgm.sql(`
    ALTER TABLE voting_links DROP CONSTRAINT voting_links_mode_check;
    ALTER TABLE voting_links ADD CONSTRAINT voting_links_mode_check CHECK(mode IN ('personal','reusable','registration'));
    ALTER TABLE voting_links ADD COLUMN require_moderation boolean NOT NULL DEFAULT false CHECK(mode='registration' OR NOT require_moderation);
    ALTER TABLE voting_links ADD COLUMN registration_group_id uuid REFERENCES voting_links(id) ON DELETE RESTRICT CHECK(registration_group_id IS NULL OR mode='personal');
    CREATE INDEX voting_links_registration_group ON voting_links(registration_group_id) WHERE registration_group_id IS NOT NULL;
    CREATE TABLE registration_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
      group_id uuid NOT NULL,
      link_id uuid NOT NULL UNIQUE,
      name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 200),
      state text NOT NULL CHECK(state IN ('pending','approved','rejected')),
      blocked boolean NOT NULL DEFAULT false,
      revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
      call_sequence bigint NOT NULL DEFAULT 0 CHECK(call_sequence>=0),
      called_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY(group_id,room_id) REFERENCES voting_links(id,room_id) ON DELETE RESTRICT,
      FOREIGN KEY(link_id,room_id) REFERENCES voting_links(id,room_id) ON DELETE RESTRICT
    );
    CREATE INDEX registration_members_group_order ON registration_members(group_id,ordinal DESC);
    CREATE TABLE registration_devices (
      root_session_id uuid PRIMARY KEY REFERENCES voting_sessions(id) ON DELETE RESTRICT,
      member_id uuid NOT NULL REFERENCES registration_members(id) ON DELETE RESTRICT,
      child_session_id uuid NOT NULL UNIQUE REFERENCES voting_sessions(id) ON DELETE RESTRICT,
      session_cipher bytea NOT NULL CHECK(octet_length(session_cipher)=92),
      seen_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX registration_devices_member ON registration_devices(member_id,seen_at);
    DO $$ DECLARE signature text; name text; definition text; BEGIN
      FOREACH signature IN ARRAY ARRAY[${signatures.map((s) => `'${s}'`).join(',')}] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||name||'_before_registration(');
        EXECUTE 'REVOKE ALL ON FUNCTION '||replace(signature,name,name||'_before_registration')||' FROM PUBLIC';
      END LOOP;
      definition:=pg_get_functiondef('vm_list_voting_links(uuid,bytea,bigint,integer)'::regprocedure);
      EXECUTE replace(definition,'WHERE room_id = p_room AND','WHERE registration_group_id IS NULL AND room_id = p_room AND');
      definition:=pg_get_functiondef('vm_add_voting_links(uuid,bytea,jsonb)'::regprocedure);
      definition:=replace(definition,'secret_cipher, allow_run_history)','secret_cipher, allow_run_history, require_moderation)');
      EXECUTE replace(definition,$patch$COALESCE((item->>'allowRunHistory')::boolean,false)) RETURNING$patch$,$patch$COALESCE((item->>'allowRunHistory')::boolean,false),COALESCE((item->>'requireModeration')::boolean,false)) RETURNING$patch$);
      definition:=pg_get_functiondef('vm_ballot_lock(uuid,uuid,uuid)'::regprocedure);
      EXECUTE replace(definition,'IF p_link IS NOT NULL THEN', $patch$IF p_link IS NOT NULL THEN
        IF EXISTS(SELECT 1 FROM registration_members WHERE link_id=p_link AND (state<>'approved' OR blocked)) THEN RAISE check_violation USING MESSAGE='Registration access required'; END IF;$patch$);
      definition:=pg_get_functiondef('vm_delete_room(uuid,bytea,jsonb)'::regprocedure);
      definition:=replace(definition,'DELETE FROM voting_sessions WHERE', $patch$DELETE FROM registration_devices WHERE member_id IN (SELECT id FROM registration_members WHERE room_id=p_room);
      DELETE FROM registration_members WHERE room_id=p_room;
      DELETE FROM voting_sessions WHERE$patch$);
      EXECUTE replace(definition,'DELETE FROM voting_links WHERE room_id=p_room;', 'DELETE FROM voting_links WHERE room_id=p_room AND registration_group_id IS NOT NULL; DELETE FROM voting_links WHERE room_id=p_room;');
    END $$;

    CREATE FUNCTION vm_edit_voting_link(p_room uuid,p_admin bytea,p_link uuid,p_action text,p_name text,p_hash bytea,p_cipher bytea,p_history boolean,p_moderation boolean) RETURNS SETOF voting_links LANGUAGE plpgsql AS $$
    DECLARE saved voting_links;
    BEGIN
      SELECT * INTO saved FROM vm_edit_voting_link(p_room,p_admin,p_link,p_action,p_name,p_hash,p_cipher,p_history);
      IF saved.id IS NULL THEN RETURN; END IF;
      IF p_moderation IS NOT NULL THEN
        IF p_action<>'rename' OR saved.mode<>'registration' THEN RAISE check_violation; END IF;
        UPDATE voting_links SET require_moderation=p_moderation WHERE id=saved.id RETURNING * INTO saved;
      END IF;
      RETURN NEXT saved;
    END $$;
    REVOKE ALL ON FUNCTION vm_edit_voting_link(uuid,bytea,uuid,text,text,bytea,bytea,boolean,boolean) FROM PUBLIC;

    -- These checks also cover writes from another API instance or direct SQL
    CREATE FUNCTION vm_registration_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' AND NEW.registration_group_id IS DISTINCT FROM OLD.registration_group_id THEN RAISE check_violation; END IF;
      IF NEW.registration_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM voting_links WHERE id=NEW.registration_group_id AND room_id=NEW.room_id AND mode='registration') THEN RAISE check_violation; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER registration_link_guard BEFORE INSERT OR UPDATE ON voting_links FOR EACH ROW EXECUTE FUNCTION vm_registration_link_guard();
    CREATE FUNCTION vm_registration_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_TABLE_NAME='registration_members' THEN
        IF NOT EXISTS(SELECT 1 FROM voting_links g JOIN voting_links c ON c.registration_group_id=g.id WHERE g.id=NEW.group_id AND c.id=NEW.link_id AND g.mode='registration' AND c.mode='personal' AND g.room_id=NEW.room_id AND c.room_id=NEW.room_id) THEN RAISE check_violation; END IF;
        IF TG_OP='UPDATE' THEN
          IF ROW(NEW.id,NEW.ordinal,NEW.room_id,NEW.group_id,NEW.link_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.ordinal,OLD.room_id,OLD.group_id,OLD.link_id,OLD.created_at) THEN RAISE check_violation; END IF;
          NEW.revision:=OLD.revision+1;
        END IF;
      ELSE
        IF TG_OP='UPDATE' AND ROW(NEW.root_session_id,NEW.member_id,NEW.child_session_id,NEW.session_cipher) IS DISTINCT FROM ROW(OLD.root_session_id,OLD.member_id,OLD.child_session_id,OLD.session_cipher) THEN RAISE check_violation; END IF;
        IF NOT EXISTS(SELECT 1 FROM registration_members m JOIN voting_sessions r ON r.id=NEW.root_session_id JOIN voting_sessions c ON c.id=NEW.child_session_id WHERE m.id=NEW.member_id AND r.link_id=m.group_id AND c.link_id=m.link_id) THEN RAISE check_violation; END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER registration_guard BEFORE INSERT OR UPDATE ON registration_members FOR EACH ROW EXECUTE FUNCTION vm_registration_guard();
    CREATE TRIGGER registration_guard BEFORE INSERT OR UPDATE ON registration_devices FOR EACH ROW EXECUTE FUNCTION vm_registration_guard();
    CREATE TRIGGER registration_signal AFTER INSERT OR UPDATE OR DELETE ON registration_members FOR EACH ROW EXECUTE FUNCTION vm_live_signal();

    CREATE FUNCTION vm_registration_access(p_group uuid,p_session bytea) RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT s.id FROM voting_sessions s JOIN voting_links g ON g.id=s.link_id WHERE g.id=p_group AND g.mode='registration' AND s.secret_hash=p_session
        AND ((g.revoked_at IS NULL AND s.generation=g.generation) OR EXISTS(SELECT 1 FROM registration_devices WHERE root_session_id=s.id));
    $$;
    CREATE OR REPLACE FUNCTION vm_voting_access(p_link uuid,p_session bytea)
      RETURNS TABLE(room_id uuid,room_name text,link_id uuid,name text,mode text) LANGUAGE sql STABLE AS $$
      SELECT access.* FROM vm_voting_access_before_registration(p_link,p_session) access WHERE access.mode<>'registration'
        AND NOT EXISTS(SELECT 1 FROM registration_members m WHERE m.link_id=p_link AND (m.state<>'approved' OR m.blocked));
    $$;
    CREATE FUNCTION vm_voting_entry(p_link uuid,p_session bytea)
      RETURNS TABLE(room_id uuid,room_name text,link_id uuid,name text,mode text) LANGUAGE sql STABLE AS $$
      SELECT * FROM vm_voting_access(p_link,p_session)
      UNION ALL SELECT r.id,r.name,g.id,g.name,g.mode FROM voting_links g JOIN rooms r ON r.id=g.room_id WHERE g.id=p_link AND vm_registration_access(g.id,p_session) IS NOT NULL;
    $$;
    CREATE OR REPLACE FUNCTION vm_exchange_voting_session(p_link uuid,p_key bytea,p_new bytea,p_old bytea)
      RETURNS TABLE(room_id uuid,room_name text,link_id uuid,name text,mode text,reused boolean) LANGUAGE plpgsql AS $$
    DECLARE g voting_links;
    BEGIN
      SELECT * INTO g FROM voting_links WHERE id=p_link;
      IF g.mode IS DISTINCT FROM 'registration' THEN RETURN QUERY SELECT * FROM vm_exchange_voting_session_before_registration(p_link,p_key,p_new,p_old); RETURN; END IF;
      PERFORM 1 FROM rooms WHERE id=g.room_id FOR UPDATE;
      SELECT * INTO g FROM voting_links WHERE id=p_link;
      IF vm_registration_access(p_link,p_old) IS NOT NULL THEN
        RETURN QUERY SELECT r.id,r.name,g.id,g.name,g.mode,true FROM rooms r WHERE r.id=g.room_id;
      ELSIF g.revoked_at IS NULL AND g.secret_hash=p_key THEN
        INSERT INTO voting_sessions(link_id,generation,secret_hash) VALUES(g.id,g.generation,p_new);
        RETURN QUERY SELECT r.id,r.name,g.id,g.name,g.mode,false FROM rooms r WHERE r.id=g.room_id;
      END IF;
    END $$;

    -- Recovery creates a browser binding for the same member, never a new person
    CREATE FUNCTION vm_recover_registration(p_group uuid,p_member uuid,p_key bytea,p_root bytea,p_child bytea,p_cipher bytea)
      RETURNS TABLE(room_id uuid,room_name text,link_id uuid,name text,mode text,reused boolean) LANGUAGE plpgsql AS $$
    DECLARE m registration_members; g voting_links; root_id uuid; child_id uuid;
    BEGIN
      SELECT l.* INTO g FROM voting_links l WHERE l.id=p_group AND l.mode='registration';
      IF NOT FOUND THEN RETURN; END IF;
      PERFORM 1 FROM rooms WHERE id=g.room_id FOR UPDATE;
      SELECT * INTO m FROM registration_members WHERE id=p_member AND group_id=g.id;
      IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM voting_links WHERE id=m.link_id AND secret_hash=p_key) THEN RETURN; END IF;
      INSERT INTO voting_sessions(link_id,generation,secret_hash) VALUES(g.id,g.generation,p_root) RETURNING id INTO root_id;
      INSERT INTO voting_sessions(link_id,generation,secret_hash) SELECT id,generation,p_child FROM voting_links WHERE id=m.link_id RETURNING id INTO child_id;
      INSERT INTO registration_devices(root_session_id,member_id,child_session_id,session_cipher) VALUES(root_id,m.id,child_id,p_cipher);
      RETURN QUERY SELECT r.id,r.name,g.id,g.name,g.mode,false FROM rooms r WHERE r.id=g.room_id;
    END $$;

    CREATE FUNCTION vm_registration_request(p_group uuid,p_session bytea,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE g voting_links; m registration_members; root_id uuid; child_id uuid; new_link uuid; d registration_devices; label text;
    BEGIN
      SELECT l.* INTO g FROM voting_links l WHERE l.id=p_group AND l.mode='registration';
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401); END IF;
      PERFORM 1 FROM rooms WHERE id=g.room_id FOR UPDATE;
      SELECT * INTO g FROM voting_links WHERE id=p_group;
      root_id:=vm_registration_access(p_group,p_session);
      IF root_id IS NULL THEN RETURN jsonb_build_object('status',401); END IF;
      SELECT * INTO d FROM registration_devices WHERE root_session_id=root_id;
      SELECT * INTO m FROM registration_members WHERE id=d.member_id;
      IF p_data ? 'name' AND (m.id IS NULL OR (m.state='rejected' AND NOT m.blocked)) THEN
        IF g.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('status',409,'error','registration_closed'); END IF;
        IF jsonb_typeof(p_data->'name') IS DISTINCT FROM 'string' OR char_length(btrim(p_data->>'name')) NOT BETWEEN 1 AND 200 THEN RETURN jsonb_build_object('status',400); END IF;
        label:=btrim(p_data->>'name');
        IF m.state='rejected' AND lower(label)=lower(btrim(m.name)) THEN RETURN jsonb_build_object('status',400,'error','same_name'); END IF;
        IF m.id IS NULL THEN
          INSERT INTO voting_links(room_id,name,mode,secret_hash,secret_cipher,registration_group_id)
            VALUES(g.room_id,label,'personal',decode(p_data->>'hash','hex'),decode(p_data->>'cipher','hex'),g.id) RETURNING id INTO new_link;
          INSERT INTO registration_members(room_id,group_id,link_id,name,state) VALUES(g.room_id,g.id,new_link,label,CASE WHEN g.require_moderation THEN 'pending' ELSE 'approved' END) RETURNING * INTO m;
          INSERT INTO voting_sessions(link_id,generation,secret_hash) SELECT id,generation,decode(p_data->>'sessionHash','hex') FROM voting_links WHERE id=new_link RETURNING id INTO child_id;
          INSERT INTO registration_devices(root_session_id,member_id,child_session_id,session_cipher) VALUES(root_id,m.id,child_id,decode(p_data->>'sessionCipher','hex')) RETURNING * INTO d;
        ELSE
          UPDATE voting_links SET name=label WHERE id=m.link_id;
          UPDATE registration_members SET name=label,state=CASE WHEN g.require_moderation THEN 'pending' ELSE 'approved' END WHERE id=m.id RETURNING * INTO m;
        END IF;
      END IF;
      UPDATE registration_devices SET seen_at=clock_timestamp() WHERE root_session_id=root_id;
      RETURN jsonb_build_object('status',200,'groupName',g.name,'moderation',g.require_moderation,'closed',g.revoked_at IS NOT NULL,'accent',(SELECT accent FROM rooms WHERE id=g.room_id),'serverTime',clock_timestamp(),
        'member',CASE WHEN m.id IS NULL THEN NULL ELSE jsonb_build_object('id',m.id,'name',m.name,'state',m.state,'blocked',m.blocked,'revision',m.revision::text,'callSequence',m.call_sequence::text,'calledAt',m.called_at) END)
        || CASE WHEN m.state='approved' AND NOT m.blocked THEN jsonb_build_object('votingId',m.link_id,'sessionCipher',encode(d.session_cipher,'hex'),'sessionHash',(SELECT encode(secret_hash,'hex') FROM voting_sessions WHERE id=d.child_session_id)) ELSE '{}'::jsonb END;
    EXCEPTION WHEN check_violation OR invalid_text_representation OR numeric_value_out_of_range THEN RETURN jsonb_build_object('status',400); END $$;

    CREATE FUNCTION vm_registration_online(p_member uuid) RETURNS bigint LANGUAGE sql VOLATILE AS $$
      SELECT count(DISTINCT child_session_id) FROM registration_devices WHERE member_id=p_member AND seen_at>clock_timestamp()-interval '35 seconds';
    $$;
    CREATE FUNCTION vm_registration_admin(p_room uuid,p_admin bytea,p_group uuid,p_member uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
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
          SELECT * FROM registration_members WHERE group_id=p_group AND (after_key=0 OR ordinal<after_key) AND (filter='all' OR (filter='pending' AND state='pending') OR (filter='registered' AND state<>'pending')) ORDER BY ordinal DESC LIMIT 51
        ), visible AS (SELECT * FROM selected ORDER BY ordinal DESC LIMIT 50)
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'state',v.state,'blocked',v.blocked,'revision',v.revision::text,'ordinal',v.ordinal::text,'online',vm_registration_online(v.id),
          'questions',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',q.id,'preview',left(q.content,240)) ORDER BY q.ordinal) FROM questions q WHERE EXISTS(SELECT 1 FROM question_views p JOIN voting_sessions s ON s.id=p.session_id WHERE p.link_id=v.link_id AND s.generation=(SELECT generation FROM voting_links WHERE id=v.link_id) AND p.question_id=q.id AND p.active AND p.seen_at>clock_timestamp()-interval '35 seconds')),'[]'::jsonb)) ORDER BY v.ordinal DESC),'[]'::jsonb),CASE WHEN (SELECT count(*) FROM selected)>50 THEN min(v.ordinal)::text END INTO page,next_page FROM visible v;
        RETURN jsonb_build_object('status',200,'members',page,'nextCursor',next_page,'pendingCount',(SELECT count(*) FROM registration_members WHERE group_id=p_group AND state='pending'));
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
      IF p_action='approve' THEN UPDATE registration_members SET state='approved' WHERE id=m.id;
      ELSIF p_action='reject' THEN
        IF m.state<>'pending' THEN RETURN jsonb_build_object('status',409); END IF;
        UPDATE registration_members SET state='rejected' WHERE id=m.id;
      ELSIF p_action='block' THEN UPDATE registration_members SET blocked=true WHERE id=m.id;
      ELSIF p_action='unblock' THEN UPDATE registration_members SET blocked=false WHERE id=m.id;
      ELSIF p_action='call' THEN UPDATE registration_members SET call_sequence=call_sequence+1,called_at=clock_timestamp() WHERE id=m.id;
      ELSE RETURN jsonb_build_object('status',400); END IF;
      RETURN jsonb_build_object('status',200);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN jsonb_build_object('status',400); END $$;

    CREATE OR REPLACE FUNCTION vm_event_state(p_identity uuid,p_session bytea,p_admin boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; root_id uuid; m registration_members; version text; owner uuid;
    BEGIN
      IF NOT p_admin THEN root_id:=vm_registration_access(p_identity,p_session); END IF;
      IF root_id IS NOT NULL THEN
        SELECT r.* INTO m FROM registration_members r JOIN registration_devices d ON d.member_id=r.id WHERE d.root_session_id=root_id;
        SELECT room_id INTO owner FROM voting_links WHERE id=p_identity;
        RETURN jsonb_build_object('status',200,'roomId',owner,'version',md5(COALESCE(m.revision::text,'')||':'||(SELECT revision::text FROM voting_links WHERE id=p_identity)));
      END IF;
      result:=vm_event_state_before_registration(p_identity,p_session,p_admin);
      IF p_admin AND result->>'status'='200' THEN
        SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(id,revision::text,vm_registration_online(id)) ORDER BY ordinal)::text,'')) INTO version FROM registration_members WHERE room_id=p_identity;
        result:=jsonb_set(result,'{version}',to_jsonb(md5((result->>'version')||version)));
      END IF;
      RETURN result;
    END $$;
    CREATE OR REPLACE FUNCTION vm_admin_presence(p_room uuid,p_session bytea,p_ids jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; page jsonb;
    BEGIN
      result:=vm_admin_presence_before_registration(p_room,p_session,p_ids);
      IF result->>'status'<>'200' THEN RETURN result; END IF;
      SELECT COALESCE(jsonb_agg(CASE WHEN l.mode='registration' THEN item||jsonb_build_object('online',(SELECT count(*) FROM registration_members WHERE group_id=l.id AND vm_registration_online(id)>0),'questions','[]'::jsonb) ELSE item END ORDER BY n),'[]'::jsonb) INTO page
        FROM jsonb_array_elements(result->'links') WITH ORDINALITY e(item,n) JOIN voting_links l ON l.id=(item->>'id')::uuid;
      RETURN jsonb_set(result,'{links}',page);
    END $$;
    CREATE OR REPLACE FUNCTION vm_results(p_identity uuid,p_session bytea,p_admin boolean,p_question uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; page jsonb;
    BEGIN
      result:=vm_results_before_registration(p_identity,p_session,p_admin,p_question,p_data);
      IF p_admin AND result->>'status'='200' AND jsonb_typeof(result#>'{result,people}')='array' THEN
        SELECT COALESCE(jsonb_agg(item||CASE WHEN g.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('groupName',g.name) END ORDER BY n),'[]'::jsonb) INTO page
          FROM jsonb_array_elements(result#>'{result,people}') WITH ORDINALITY e(item,n) LEFT JOIN registration_members m ON m.link_id=(item->>'linkId')::uuid LEFT JOIN voting_links g ON g.id=m.group_id;
        result:=jsonb_set(result,'{result,people}',page);
      END IF;
      RETURN result;
    END $$;
    CREATE OR REPLACE FUNCTION vm_room_report(p_identity uuid,p_session bytea,p_admin boolean,p_run uuid,p_export boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; page jsonb;
    BEGIN
      result:=vm_room_report_before_registration(p_identity,p_session,p_admin,p_run,p_export);
      IF p_admin AND result->>'status'='200' AND jsonb_typeof(result#>'{report,people}')='array' THEN
        SELECT COALESCE(jsonb_agg(item||CASE WHEN g.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('groupName',g.name) END ORDER BY n),'[]'::jsonb) INTO page
          FROM jsonb_array_elements(result#>'{report,people}') WITH ORDINALITY e(item,n) LEFT JOIN registration_members m ON item->>'id'='p:'||m.link_id::text LEFT JOIN voting_links g ON g.id=m.group_id;
        result:=jsonb_set(result,'{report,people}',page);
      END IF;
      RETURN result;
    END $$;
    REVOKE ALL ON FUNCTION vm_registration_link_guard(),vm_registration_guard(),vm_registration_access(uuid,bytea),vm_voting_entry(uuid,bytea),vm_recover_registration(uuid,uuid,bytea,bytea,bytea,bytea),vm_registration_request(uuid,bytea,jsonb),vm_registration_online(uuid),vm_registration_admin(uuid,bytea,uuid,uuid,text,jsonb) FROM PUBLIC;
  `);
}

// Require explicit recovery before removing registered people and their access
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM voting_links WHERE mode='registration') THEN RAISE EXCEPTION 'Recover registration groups before rollback'; END IF; END $$;
    DROP TRIGGER registration_link_guard ON voting_links;
    DROP TRIGGER registration_signal ON registration_members;
    DROP TRIGGER registration_guard ON registration_members;
    DROP TRIGGER registration_guard ON registration_devices;
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY[${signatures.map((s) => `'${s}'`).join(',')}] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(replace(signature,name,name||'_before_registration')::regprocedure),'FUNCTION public.'||name||'_before_registration(','FUNCTION public.'||name||'(');
        EXECUTE 'DROP FUNCTION '||replace(signature,name,name||'_before_registration');
      END LOOP;
    END $$;
    DROP FUNCTION vm_edit_voting_link(uuid,bytea,uuid,text,text,bytea,bytea,boolean,boolean);
    DROP FUNCTION vm_registration_admin(uuid,bytea,uuid,uuid,text,jsonb),vm_registration_request(uuid,bytea,jsonb),vm_recover_registration(uuid,uuid,bytea,bytea,bytea,bytea),vm_voting_entry(uuid,bytea),vm_registration_access(uuid,bytea),vm_registration_online(uuid),vm_registration_guard(),vm_registration_link_guard();
    DROP TABLE registration_devices,registration_members;
    ALTER TABLE voting_links DROP COLUMN registration_group_id;
    ALTER TABLE voting_links DROP COLUMN require_moderation;
    ALTER TABLE voting_links DROP CONSTRAINT voting_links_mode_check;
    ALTER TABLE voting_links ADD CONSTRAINT voting_links_mode_check CHECK(mode IN ('personal','reusable'));
  `);
}
