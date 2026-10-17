// Development baseline, replace it only while data resets are allowed
export function up(pgm) {
  pgm.sql(`
    CREATE TABLE rooms (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL DEFAULT 'Новая комната' CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
      admin_secret_hash bytea NOT NULL UNIQUE CHECK (octet_length(admin_secret_hash) = 32),
      admin_secret_cipher bytea NOT NULL CHECK (octet_length(admin_secret_cipher) = 92),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (isfinite(created_at)),
      revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
    );
    CREATE TABLE room_admin_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
      secret_hash bytea NOT NULL UNIQUE CHECK (octet_length(secret_hash) = 32),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (isfinite(created_at))
    );
    CREATE INDEX admin_sessions_room ON room_admin_sessions(room_id);

    CREATE FUNCTION vm_room_revision() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.revision := OLD.revision + 1; RETURN NEW; END;
    $$;
    CREATE TRIGGER room_revision BEFORE UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION vm_room_revision();
    CREATE FUNCTION vm_room_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_notify('room_changes', json_build_object('roomId', NEW.id, 'revision', NEW.revision::text)::text);
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER room_changed AFTER INSERT OR UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION vm_room_changed();

    CREATE FUNCTION vm_create_room(p_name text, p_hash bytea, p_cipher bytea) RETURNS SETOF rooms LANGUAGE sql AS $$
      INSERT INTO rooms(name, admin_secret_hash, admin_secret_cipher)
        VALUES (COALESCE(NULLIF(btrim(p_name), ''), 'Новая комната'), p_hash, p_cipher) RETURNING *;
    $$;
    CREATE FUNCTION vm_open_admin_session(p_room uuid, p_key bytea, p_session bytea) RETURNS SETOF rooms LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM rooms WHERE id = p_room AND admin_secret_hash = p_key) THEN RETURN; END IF;
      INSERT INTO room_admin_sessions(room_id, secret_hash) VALUES (p_room, p_session);
      RETURN QUERY SELECT * FROM rooms WHERE id = p_room;
    END;
    $$;
    CREATE FUNCTION vm_admin_room(p_room uuid, p_session bytea) RETURNS SETOF rooms LANGUAGE sql STABLE AS $$
      SELECT r.* FROM rooms r WHERE r.id = p_room AND EXISTS (
        SELECT 1 FROM room_admin_sessions s WHERE s.room_id = r.id AND s.secret_hash = p_session
      );
    $$;
    CREATE FUNCTION vm_rename_room(p_room uuid, p_session bytea, p_name text) RETURNS SETOF rooms LANGUAGE sql AS $$
      UPDATE rooms r SET name = COALESCE(NULLIF(btrim(p_name), ''), 'Новая комната') WHERE r.id = p_room AND EXISTS (
        SELECT 1 FROM room_admin_sessions s WHERE s.room_id = r.id AND s.secret_hash = p_session
      ) RETURNING r.*;
    $$;
    REVOKE ALL ON FUNCTION vm_create_room(text, bytea, bytea), vm_open_admin_session(uuid, bytea, bytea),
      vm_admin_room(uuid, bytea), vm_rename_room(uuid, bytea, text), vm_room_revision(), vm_room_changed() FROM PUBLIC;
  `);
}

// Drop child objects first, without removing unrelated objects
export function down(pgm) {
  pgm.sql(`
    DROP FUNCTION vm_create_room(text, bytea, bytea);
    DROP FUNCTION vm_open_admin_session(uuid, bytea, bytea);
    DROP FUNCTION vm_admin_room(uuid, bytea);
    DROP FUNCTION vm_rename_room(uuid, bytea, text);
    DROP TABLE room_admin_sessions;
    DROP TABLE rooms;
    DROP FUNCTION vm_room_revision();
    DROP FUNCTION vm_room_changed();
  `);
}
