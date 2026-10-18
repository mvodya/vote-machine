// Keep link identity separate from its replaceable secret
export function up(pgm) {
  pgm.sql(`
    CREATE TABLE voting_links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
      ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
      mode text NOT NULL CHECK (mode IN ('personal', 'reusable')),
      secret_hash bytea NOT NULL UNIQUE CHECK (octet_length(secret_hash) = 32),
      secret_cipher bytea NOT NULL CHECK (octet_length(secret_cipher) = 92),
      generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
      revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
      revoked_at timestamptz CHECK (isfinite(revoked_at)),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (isfinite(created_at))
    );
    CREATE INDEX voting_links_room_order ON voting_links(room_id, ordinal DESC);
    CREATE TABLE voting_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      link_id uuid NOT NULL REFERENCES voting_links(id) ON DELETE RESTRICT,
      generation bigint NOT NULL CHECK (generation > 0),
      secret_hash bytea NOT NULL UNIQUE CHECK (octet_length(secret_hash) = 32),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (isfinite(created_at))
    );
    CREATE INDEX voting_sessions_link ON voting_sessions(link_id);

    CREATE FUNCTION vm_link_before_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id <> OLD.id OR NEW.room_id <> OLD.room_id OR NEW.mode <> OLD.mode OR NEW.ordinal <> OLD.ordinal OR NEW.created_at <> OLD.created_at THEN
        RAISE check_violation USING MESSAGE = 'Link identity and mode cannot change';
      END IF;
      NEW.revision := OLD.revision + 1;
      IF NEW.secret_hash IS DISTINCT FROM OLD.secret_hash OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        NEW.generation := OLD.generation + 1;
      ELSE NEW.generation := OLD.generation; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER voting_link_before_change BEFORE UPDATE ON voting_links FOR EACH ROW EXECUTE FUNCTION vm_link_before_change();
    CREATE FUNCTION vm_link_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_notify('voting_link_changes', json_build_object('roomId', NEW.room_id, 'linkId', NEW.id, 'revision', NEW.revision::text)::text);
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER voting_link_changed AFTER INSERT OR UPDATE ON voting_links FOR EACH ROW EXECUTE FUNCTION vm_link_changed();

    CREATE FUNCTION vm_add_voting_links(p_room uuid, p_admin bytea, p_items jsonb) RETURNS SETOF voting_links LANGUAGE plpgsql AS $$
    DECLARE item jsonb; saved voting_links;
    BEGIN
      PERFORM 1 FROM rooms r WHERE r.id = p_room AND EXISTS (SELECT 1 FROM vm_admin_room(p_room, p_admin)) FOR UPDATE;
      IF NOT FOUND THEN RETURN; END IF;
      IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN RAISE check_violation; END IF;
      IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 100 THEN RAISE check_violation; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
        IF jsonb_typeof(item->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'mode') IS DISTINCT FROM 'string' THEN RAISE check_violation; END IF;
        INSERT INTO voting_links(room_id, name, mode, secret_hash, secret_cipher)
          VALUES (p_room, COALESCE(NULLIF(btrim(item->>'name'), ''), 'Респондент'), item->>'mode', decode(item->>'hash', 'hex'), decode(item->>'cipher', 'hex')) RETURNING * INTO saved;
        RETURN NEXT saved;
      END LOOP;
    END;
    $$;
    CREATE FUNCTION vm_list_voting_links(p_room uuid, p_admin bytea, p_after bigint, p_limit integer) RETURNS SETOF voting_links LANGUAGE plpgsql STABLE AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM vm_admin_room(p_room, p_admin)) THEN RETURN; END IF;
      IF p_after IS NULL OR p_limit IS NULL OR p_after < 0 OR p_limit NOT BETWEEN 1 AND 51 THEN RAISE check_violation; END IF;
      RETURN QUERY SELECT * FROM voting_links WHERE room_id = p_room AND (p_after = 0 OR ordinal < p_after) ORDER BY ordinal DESC LIMIT p_limit;
    END;
    $$;
    CREATE FUNCTION vm_edit_voting_link(p_room uuid, p_admin bytea, p_link uuid, p_action text, p_name text, p_hash bytea, p_cipher bytea) RETURNS SETOF voting_links LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM 1 FROM rooms r WHERE r.id = p_room AND EXISTS (SELECT 1 FROM vm_admin_room(p_room, p_admin)) FOR UPDATE;
      IF NOT FOUND THEN RETURN; END IF;
      IF p_action = 'rename' THEN
        RETURN QUERY UPDATE voting_links SET name = COALESCE(NULLIF(btrim(p_name), ''), 'Респондент') WHERE id = p_link AND room_id = p_room RETURNING *;
      ELSIF p_action = 'revoke' THEN
        RETURN QUERY UPDATE voting_links SET revoked_at = COALESCE(revoked_at, statement_timestamp()) WHERE id = p_link AND room_id = p_room RETURNING *;
      ELSIF p_action = 'rotate' THEN
        RETURN QUERY UPDATE voting_links SET secret_hash = p_hash, secret_cipher = p_cipher, revoked_at = NULL WHERE id = p_link AND room_id = p_room RETURNING *;
      ELSE RAISE check_violation; END IF;
    END;
    $$;
    CREATE FUNCTION vm_voting_link_secret(p_room uuid, p_admin bytea, p_link uuid) RETURNS SETOF voting_links LANGUAGE plpgsql STABLE AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM vm_admin_room(p_room, p_admin)) THEN RETURN; END IF;
      RETURN QUERY SELECT * FROM voting_links WHERE id = p_link AND room_id = p_room AND revoked_at IS NULL;
    END;
    $$;
    CREATE FUNCTION vm_open_voting_session(p_link uuid, p_key bytea, p_session bytea)
      RETURNS TABLE(room_id uuid, room_name text, link_id uuid, name text, mode text) LANGUAGE plpgsql AS $$
    DECLARE link voting_links;
    BEGIN
      SELECT * INTO link FROM voting_links WHERE id = p_link FOR SHARE;
      IF NOT FOUND OR link.revoked_at IS NOT NULL OR link.secret_hash IS DISTINCT FROM p_key THEN RETURN; END IF;
      INSERT INTO voting_sessions(link_id, generation, secret_hash) VALUES (p_link, link.generation, p_session);
      RETURN QUERY SELECT r.id, r.name, link.id, link.name, link.mode FROM rooms r WHERE r.id = link.room_id;
    END;
    $$;
    CREATE FUNCTION vm_voting_access(p_link uuid, p_session bytea)
      RETURNS TABLE(room_id uuid, room_name text, link_id uuid, name text, mode text) LANGUAGE sql STABLE AS $$
      SELECT r.id, r.name, l.id, l.name, l.mode FROM voting_links l JOIN rooms r ON r.id = l.room_id
      WHERE l.id = p_link AND l.revoked_at IS NULL AND EXISTS (
        SELECT 1 FROM voting_sessions s WHERE s.link_id = l.id AND s.secret_hash = p_session AND s.generation = l.generation
      );
    $$;
    REVOKE ALL ON FUNCTION vm_link_before_change(), vm_link_changed(), vm_add_voting_links(uuid,bytea,jsonb),
      vm_list_voting_links(uuid,bytea,bigint,integer), vm_edit_voting_link(uuid,bytea,uuid,text,text,bytea,bytea),
      vm_voting_link_secret(uuid,bytea,uuid), vm_open_voting_session(uuid,bytea,bytea), vm_voting_access(uuid,bytea) FROM PUBLIC;
  `);
}

// Remove only link objects and keep room access
export function down(pgm) {
  pgm.sql(`
    DROP FUNCTION vm_voting_access(uuid,bytea);
    DROP FUNCTION vm_open_voting_session(uuid,bytea,bytea);
    DROP FUNCTION vm_voting_link_secret(uuid,bytea,uuid);
    DROP FUNCTION vm_edit_voting_link(uuid,bytea,uuid,text,text,bytea,bytea);
    DROP FUNCTION vm_list_voting_links(uuid,bytea,bigint,integer);
    DROP FUNCTION vm_add_voting_links(uuid,bytea,jsonb);
    DROP TABLE voting_sessions;
    DROP TABLE voting_links;
    DROP FUNCTION vm_link_changed();
    DROP FUNCTION vm_link_before_change();
  `);
}
