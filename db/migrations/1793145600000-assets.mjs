// Keep media state and references shared by all app instances
export function up(pgm) {
  pgm.sql(`
    CREATE TABLE assets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
      state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','deleting')),
      source_bytes integer NOT NULL CHECK (source_bytes BETWEEN 1 AND 10485760),
      mime text CHECK (mime IN ('image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm')),
      width integer CHECK (width > 0),
      height integer CHECK (height > 0),
      bytes integer CHECK (bytes BETWEEN 1 AND 10485760),
      sha256 bytea CHECK (octet_length(sha256) = 32),
      created_at timestamptz NOT NULL DEFAULT statement_timestamp() CHECK (isfinite(created_at)),
      unused_since timestamptz DEFAULT statement_timestamp() CHECK (isfinite(unused_since)),
      cleanup_token uuid,
      cleanup_until timestamptz CHECK (isfinite(cleanup_until)),
      UNIQUE(id,room_id),
      CHECK (width::bigint * height::bigint <= 25000000),
      CHECK (state <> 'ready' OR (mime IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND bytes IS NOT NULL AND sha256 IS NOT NULL)),
      CHECK ((state = 'deleting' AND cleanup_token IS NOT NULL AND cleanup_until IS NOT NULL) OR (state <> 'deleting' AND cleanup_token IS NULL AND cleanup_until IS NULL))
    );
    CREATE INDEX assets_room ON assets(room_id);
    CREATE INDEX assets_unused ON assets(unused_since) WHERE unused_since IS NOT NULL;
    CREATE INDEX assets_cleanup ON assets(cleanup_until) WHERE state = 'deleting';
    ALTER TABLE question_options ADD CONSTRAINT option_reference_owner UNIQUE(id,question_id,room_id);
    CREATE TABLE question_asset_refs (
      question_id uuid NOT NULL,
      room_id uuid NOT NULL,
      option_id uuid,
      asset_id uuid NOT NULL,
      FOREIGN KEY (question_id,room_id) REFERENCES questions(id,room_id) ON DELETE CASCADE,
      FOREIGN KEY (option_id,question_id,room_id) REFERENCES question_options(id,question_id,room_id) ON DELETE CASCADE,
      FOREIGN KEY (asset_id,room_id) REFERENCES assets(id,room_id) ON DELETE RESTRICT,
      UNIQUE NULLS NOT DISTINCT(question_id,option_id,asset_id)
    );
    CREATE INDEX asset_references ON question_asset_refs(asset_id);

    CREATE FUNCTION vm_asset_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id <> OLD.id OR NEW.room_id <> OLD.room_id OR NEW.created_at <> OLD.created_at OR NEW.source_bytes <> OLD.source_bytes THEN RAISE check_violation; END IF;
      IF OLD.state <> 'pending' AND ROW(NEW.mime,NEW.width,NEW.height,NEW.bytes,NEW.sha256) IS DISTINCT FROM ROW(OLD.mime,OLD.width,OLD.height,OLD.bytes,OLD.sha256) THEN RAISE check_violation; END IF;
      IF (OLD.state = 'deleting' AND NEW.state <> 'deleting') OR (OLD.state = 'ready' AND NEW.state = 'pending') THEN RAISE check_violation; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER asset_guard BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION vm_asset_guard();

    CREATE FUNCTION vm_asset_ref_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN RAISE check_violation; END IF;
      IF TG_OP = 'DELETE' THEN
        PERFORM 1 FROM rooms WHERE id = OLD.room_id FOR UPDATE;
        IF EXISTS (SELECT 1 FROM questions WHERE id = OLD.question_id AND edit_locked) THEN RAISE check_violation; END IF;
        RETURN OLD;
      END IF;
      PERFORM 1 FROM rooms WHERE id = NEW.room_id FOR UPDATE;
      IF EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND edit_locked) THEN RAISE check_violation; END IF;
      PERFORM 1 FROM assets WHERE id = NEW.asset_id AND room_id = NEW.room_id AND state = 'ready' FOR UPDATE;
      IF NOT FOUND THEN RAISE foreign_key_violation; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER asset_ref_guard BEFORE INSERT OR UPDATE OR DELETE ON question_asset_refs FOR EACH ROW EXECUTE FUNCTION vm_asset_ref_guard();
    CREATE FUNCTION vm_asset_ref_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        UPDATE assets SET unused_since = NULL WHERE id = NEW.asset_id;
      ELSE
        UPDATE assets a SET unused_since = statement_timestamp() WHERE id = OLD.asset_id AND NOT EXISTS (SELECT 1 FROM question_asset_refs r WHERE r.asset_id = a.id);
      END IF;
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER asset_ref_changed AFTER INSERT OR DELETE ON question_asset_refs FOR EACH ROW EXECUTE FUNCTION vm_asset_ref_changed();
    CREATE FUNCTION vm_asset_refs_touch() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE questions q SET revision = q.revision WHERE q.id IN (SELECT question_id FROM changed_refs);
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER asset_refs_inserted AFTER INSERT ON question_asset_refs REFERENCING NEW TABLE AS changed_refs FOR EACH STATEMENT EXECUTE FUNCTION vm_asset_refs_touch();
    CREATE TRIGGER asset_refs_deleted AFTER DELETE ON question_asset_refs REFERENCING OLD TABLE AS changed_refs FOR EACH STATEMENT EXECUTE FUNCTION vm_asset_refs_touch();

    CREATE FUNCTION vm_asset_data(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT jsonb_build_object('id',id,'objectKey','rooms/' || room_id::text || '/' || id::text,'mime',mime,'width',width,'height',height,'bytes',bytes,'kind',CASE WHEN mime LIKE 'video/%' THEN 'video' ELSE 'image' END) FROM assets WHERE id = p_id;
    $$;
    CREATE FUNCTION vm_asset_request(p_room uuid,p_admin bytea,p_id uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE asset assets; item jsonb; asset_id uuid;
    BEGIN
      IF p_action IN ('get','access') THEN PERFORM 1 FROM vm_admin_room(p_room,p_admin);
      ELSE PERFORM 1 FROM rooms WHERE id = p_room AND EXISTS (SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE; END IF;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF p_action = 'access' THEN RETURN jsonb_build_object('status',200); END IF;
      IF p_action = 'reserve' THEN
        IF jsonb_typeof(p_data->'bytes') IS DISTINCT FROM 'number' OR (p_data->>'bytes') !~ '^[0-9]{1,8}$' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
        INSERT INTO assets(room_id,source_bytes) VALUES(p_room,(p_data->>'bytes')::integer) RETURNING * INTO asset;
        RETURN jsonb_build_object('status',201,'asset',vm_asset_data(asset.id));
      END IF;
      IF p_action = 'keepalive' THEN
        IF jsonb_typeof(p_data->'ids') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'ids') > 12000 THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
        FOR item IN SELECT value FROM jsonb_array_elements(p_data->'ids') LOOP
          IF jsonb_typeof(item) IS DISTINCT FROM 'string' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
          asset_id := (item#>>'{}')::uuid;
          IF NOT EXISTS (SELECT 1 FROM assets WHERE id = asset_id AND room_id = p_room AND state = 'ready') THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
        END LOOP;
        UPDATE assets SET unused_since = statement_timestamp() WHERE room_id = p_room AND state = 'ready' AND unused_since IS NOT NULL AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(p_data->'ids'));
        RETURN jsonb_build_object('status',200);
      END IF;
      SELECT * INTO asset FROM assets WHERE id = p_id AND room_id = p_room FOR UPDATE;
      IF NOT FOUND OR asset.state = 'deleting' THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      IF p_action = 'finish' THEN
        IF asset.state <> 'pending' THEN RETURN jsonb_build_object('status',409,'error','conflict'); END IF;
        UPDATE assets SET mime = p_data->>'mime', width = (p_data->>'width')::integer, height = (p_data->>'height')::integer, bytes = (p_data->>'bytes')::integer, sha256 = decode(p_data->>'sha256','hex'), state = 'ready', unused_since = statement_timestamp() WHERE id = p_id;
      ELSIF p_action <> 'get' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      IF p_action = 'get' AND asset.state <> 'ready' THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      RETURN jsonb_build_object('status',200,'asset',vm_asset_data(p_id));
    EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN RETURN jsonb_build_object('status',400,'error','invalid');
    END;
    $$;
    CREATE FUNCTION vm_participant_asset(p_link uuid,p_session bytea,p_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM vm_voting_access(p_link,p_session)) THEN jsonb_build_object('status',401,'error','access')
      WHEN EXISTS (SELECT 1 FROM vm_voting_access(p_link,p_session) v JOIN question_asset_refs r ON r.room_id = v.room_id JOIN questions q ON q.id = r.question_id JOIN assets a ON a.id = r.asset_id WHERE a.id = p_id AND a.state = 'ready' AND q.state = 'open') THEN jsonb_build_object('status',200,'asset',vm_asset_data(p_id))
      ELSE jsonb_build_object('status',404,'error','missing') END;
    $$;

    DO $$ BEGIN
      EXECUTE replace(pg_get_functiondef('vm_question_request(uuid,bytea,uuid,text,jsonb)'::regprocedure),'FUNCTION public.vm_question_request(','FUNCTION public.vm_question_request_v6(');
    END $$;
    CREATE OR REPLACE FUNCTION vm_question_request(p_room uuid,p_admin bytea,p_id uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE reply jsonb; item jsonb; refs jsonb; position integer; asset uuid; question uuid;
    BEGIN
      IF p_action NOT IN ('create','save') THEN RETURN vm_question_request_v6(p_room,p_admin,p_id,p_action,p_data); END IF;
      PERFORM 1 FROM rooms WHERE id = p_room AND EXISTS (SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      refs := COALESCE(p_data->'assetRefs','[]');
      IF jsonb_typeof(refs) IS DISTINCT FROM 'array' OR jsonb_array_length(refs) > 12000 THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(refs) LOOP
        IF jsonb_typeof(item->'assetId') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'position') IS DISTINCT FROM 'number' OR (item->>'position') !~ '^(-1|[0-9]{1,2})$' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
        position := (item->>'position')::integer; asset := (item->>'assetId')::uuid;
        IF position >= COALESCE(jsonb_array_length(p_data->'choices'),0) THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
        IF NOT EXISTS (SELECT 1 FROM assets WHERE id = asset AND room_id = p_room AND state = 'ready') THEN RETURN jsonb_build_object('status',409,'error','asset'); END IF;
      END LOOP;
      reply := vm_question_request_v6(p_room,p_admin,p_id,p_action,p_data);
      IF (reply->>'status')::integer NOT IN (200,201) THEN RETURN reply; END IF;
      question := (reply#>>'{question,id}')::uuid;
      DELETE FROM question_asset_refs WHERE question_id = question;
      INSERT INTO question_asset_refs(question_id,room_id,option_id,asset_id)
        SELECT DISTINCT question,p_room,CASE WHEN (value->>'position')::integer = -1 THEN NULL ELSE (reply->'question'->'choices'->((value->>'position')::integer)->>'id')::uuid END,(value->>'assetId')::uuid FROM jsonb_array_elements(refs);
      RETURN jsonb_set(reply,'{question}',vm_question_data(question));
    EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN RETURN jsonb_build_object('status',400,'error','invalid');
      WHEN foreign_key_violation THEN RETURN jsonb_build_object('status',409,'error','asset');
    END;
    $$;

    CREATE FUNCTION vm_asset_cleanup(p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE owner uuid; jobs jsonb; limit_count integer := 25;
    BEGIN
      IF p_action = 'ack' THEN
        SELECT room_id INTO owner FROM assets WHERE id = (p_data->>'id')::uuid;
        IF FOUND THEN
          PERFORM 1 FROM rooms WHERE id = owner FOR UPDATE;
          DELETE FROM assets a WHERE id = (p_data->>'id')::uuid AND state = 'deleting' AND cleanup_token = (p_data->>'token')::uuid AND NOT EXISTS (SELECT 1 FROM question_asset_refs r WHERE r.asset_id = a.id);
        END IF;
        RETURN jsonb_build_object('status',200);
      END IF;
      IF p_action <> 'claim' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      WITH owners AS MATERIALIZED (
        SELECT r.id FROM rooms r WHERE EXISTS (SELECT 1 FROM assets a WHERE a.room_id = r.id AND ((a.state <> 'deleting' AND a.unused_since <= statement_timestamp() - interval '24 hours') OR (a.state = 'deleting' AND a.cleanup_until <= statement_timestamp()))) ORDER BY r.id FOR UPDATE SKIP LOCKED LIMIT 10
      ), candidates AS (
        SELECT a.id FROM assets a JOIN owners r ON r.id = a.room_id WHERE ((a.state <> 'deleting' AND a.unused_since <= statement_timestamp() - interval '24 hours') OR (a.state = 'deleting' AND a.cleanup_until <= statement_timestamp())) AND NOT EXISTS (SELECT 1 FROM question_asset_refs ref WHERE ref.asset_id = a.id) ORDER BY a.created_at,a.id FOR UPDATE OF a SKIP LOCKED LIMIT limit_count
      ), claimed AS (
        UPDATE assets a SET state = 'deleting',cleanup_token = gen_random_uuid(),cleanup_until = statement_timestamp() + interval '5 minutes' WHERE a.id IN (SELECT id FROM candidates) RETURNING a.*
      ) SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'token',cleanup_token,'objectKey','rooms/' || room_id::text || '/' || id::text)),'[]') INTO jobs FROM claimed;
      RETURN jsonb_build_object('status',200,'jobs',jobs);
    END;
    $$;
    REVOKE ALL ON FUNCTION vm_asset_guard(), vm_asset_ref_guard(), vm_asset_ref_changed(), vm_asset_refs_touch(), vm_asset_data(uuid), vm_asset_request(uuid,bytea,uuid,text,jsonb), vm_participant_asset(uuid,bytea,uuid), vm_asset_cleanup(text,jsonb), vm_question_request_v6(uuid,bytea,uuid,text,jsonb) FROM PUBLIC;
  `);
}

// Restore the prior question function before removing media state
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      EXECUTE replace(pg_get_functiondef('vm_question_request_v6(uuid,bytea,uuid,text,jsonb)'::regprocedure),'FUNCTION public.vm_question_request_v6(','FUNCTION public.vm_question_request(');
    END $$;
    DROP FUNCTION vm_question_request_v6(uuid,bytea,uuid,text,jsonb);
    DROP FUNCTION vm_asset_cleanup(text,jsonb);
    DROP FUNCTION vm_participant_asset(uuid,bytea,uuid);
    DROP FUNCTION vm_asset_request(uuid,bytea,uuid,text,jsonb);
    DROP FUNCTION vm_asset_data(uuid);
    DROP TABLE question_asset_refs;
    DROP TABLE assets;
    ALTER TABLE question_options DROP CONSTRAINT option_reference_owner;
    DROP FUNCTION vm_asset_refs_touch();
    DROP FUNCTION vm_asset_ref_changed();
    DROP FUNCTION vm_asset_ref_guard();
    DROP FUNCTION vm_asset_guard();
  `);
}
