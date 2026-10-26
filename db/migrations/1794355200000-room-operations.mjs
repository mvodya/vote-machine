// Delete room data atomically and keep durable object cleanup jobs
export function up(pgm) {
  pgm.sql(`
    CREATE TABLE object_deletions (
      id uuid PRIMARY KEY,
      object_key text NOT NULL UNIQUE CHECK(object_key ~ '^rooms/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
      available_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
      token uuid,
      lease_until timestamptz,
      CHECK((token IS NULL)=(lease_until IS NULL))
    );
    CREATE INDEX object_deletions_due ON object_deletions(available_at,lease_until);
    CREATE FUNCTION vm_delete_room(p_room uuid,p_admin bytea,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE saved rooms; item record; response jsonb;
    BEGIN
      SELECT r.* INTO saved FROM rooms r WHERE r.id=p_room AND EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF p_data->>'confirmation' IS DISTINCT FROM p_room::text THEN RETURN jsonb_build_object('status',400,'error','confirmation'); END IF;
      IF jsonb_typeof(p_data->'revision') IS DISTINCT FROM 'string' THEN RETURN jsonb_build_object('status',400,'error','revision'); END IF;
      IF p_data->>'revision' IS DISTINCT FROM saved.revision::text THEN RETURN jsonb_build_object('status',409,'error','conflict'); END IF;
      FOR item IN SELECT id,revision FROM questions WHERE room_id=p_room ORDER BY ordinal FOR UPDATE LOOP
        response:=vm_delete_question(p_room,p_admin,item.id,jsonb_build_object('revision',item.revision::text));
        IF response->>'status'<>'200' THEN RAISE check_violation USING MESSAGE='Room deletion failed'; END IF;
      END LOOP;
      INSERT INTO object_deletions(id,object_key)
        SELECT id,'rooms/'||room_id::text||'/'||id::text FROM assets WHERE room_id=p_room;
      DELETE FROM assets WHERE room_id=p_room;
      DELETE FROM question_views WHERE room_id=p_room;
      DELETE FROM admin_vote_requests WHERE room_id=p_room;
      DELETE FROM vote_requests WHERE link_id IN (SELECT id FROM voting_links WHERE room_id=p_room);
      DELETE FROM voting_runs WHERE room_id=p_room;
      DELETE FROM voting_sessions WHERE link_id IN (SELECT id FROM voting_links WHERE room_id=p_room);
      DELETE FROM voting_links WHERE room_id=p_room;
      DELETE FROM room_admin_sessions WHERE room_id=p_room;
      DELETE FROM rooms WHERE id=p_room;
      RETURN jsonb_build_object('status',200,'deletedId',p_room);
    END $$;
    ALTER FUNCTION vm_asset_cleanup(text,jsonb) RENAME TO vm_asset_cleanup_before_operations;
    CREATE FUNCTION vm_asset_cleanup(p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE response jsonb; pending jsonb;
    BEGIN
      response:=vm_asset_cleanup_before_operations(p_action,p_data);
      IF p_action='ack' THEN
        DELETE FROM object_deletions WHERE id=(p_data->>'id')::uuid AND token=(p_data->>'token')::uuid;
      ELSIF p_action='claim' THEN
        WITH candidates AS (
          SELECT id FROM object_deletions WHERE available_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
          ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 25
        ), claimed AS (
          UPDATE object_deletions SET token=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes'
          WHERE id IN (SELECT id FROM candidates) RETURNING *
        ) SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'token',token,'objectKey',object_key)),'[]') INTO pending FROM claimed;
        response:=jsonb_set(response,'{jobs}',COALESCE(response->'jobs','[]')||pending);
      END IF;
      RETURN response;
    END $$;
    REVOKE ALL ON TABLE object_deletions FROM PUBLIC;
    REVOKE ALL ON FUNCTION vm_delete_room(uuid,bytea,jsonb),vm_asset_cleanup(text,jsonb),vm_asset_cleanup_before_operations(text,jsonb) FROM PUBLIC;
  `);
}
// Keep pending storage jobs rather than silently losing them on rollback
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM object_deletions) THEN RAISE check_violation USING MESSAGE='Finish object deletion jobs before rollback'; END IF; END $$;
    DROP FUNCTION vm_delete_room(uuid,bytea,jsonb),vm_asset_cleanup(text,jsonb);
    ALTER FUNCTION vm_asset_cleanup_before_operations(text,jsonb) RENAME TO vm_asset_cleanup;
    DROP TABLE object_deletions;
  `);
}
