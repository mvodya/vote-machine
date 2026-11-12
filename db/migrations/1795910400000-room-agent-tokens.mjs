// Keep one independent API credential per room
export function up(pgm) {
  pgm.sql(`
    CREATE TABLE room_agent_tokens (
      room_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
      secret_hash bytea NOT NULL UNIQUE CHECK(octet_length(secret_hash)=32),
      encrypted_token bytea NOT NULL
    );
    CREATE TABLE room_agent_question_batches (
      room_id uuid REFERENCES rooms(id) ON DELETE CASCADE,
      request_id uuid,
      document_hash bytea NOT NULL CHECK(octet_length(document_hash)=32),
      response jsonb NOT NULL,
      PRIMARY KEY(room_id,request_id)
    );

    -- Keep the first issued token unless the admin asks to rotate it
    CREATE FUNCTION vm_room_agent_token(p_room uuid,p_session bytea,p_action text,p_hash bytea,p_encrypted bytea)
      RETURNS TABLE(status integer,encrypted text) LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM 1 FROM rooms WHERE id=p_room FOR UPDATE;
      IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM room_admin_sessions WHERE room_id=p_room AND secret_hash=p_session) THEN
        RETURN QUERY SELECT 401,NULL::text;
        RETURN;
      END IF;
      INSERT INTO room_agent_tokens(room_id,secret_hash,encrypted_token) VALUES(p_room,p_hash,p_encrypted)
        ON CONFLICT(room_id) DO UPDATE SET secret_hash=excluded.secret_hash,encrypted_token=excluded.encrypted_token
        WHERE p_action='rotate';
      RETURN QUERY SELECT 200,encode(t.encrypted_token,'hex') FROM room_agent_tokens t WHERE t.room_id=p_room;
    END $$;

    -- Check the current token under the same room lock used by rotation
    CREATE FUNCTION vm_room_agent_operation(p_room uuid,p_secret bytea,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE owner bytea; category text; item jsonb; result jsonb; failed jsonb;
      created jsonb:='[]'; target uuid; saved questions; receipt room_agent_question_batches;
      fingerprint bytea; batch_id uuid; index_number integer:=0; retry integer;
    BEGIN
      IF p_room IS NULL THEN
        SELECT room_id INTO p_room FROM room_agent_tokens WHERE secret_hash=p_secret;
      END IF;
      PERFORM 1 FROM rooms WHERE id=p_room FOR UPDATE;
      IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM room_agent_tokens WHERE room_id=p_room AND secret_hash=p_secret) THEN
        RETURN jsonb_build_object('status',401,'error','invalid_token');
      END IF;
      IF p_action='access' THEN RETURN jsonb_build_object('status',200,'room',p_room); END IF;
      category:=CASE
        WHEN p_action IN ('questions_list','questions_get') THEN 'questions:read'
        WHEN p_action IN ('questions_create_batch','questions_update') THEN 'questions:write'
        WHEN p_action IN ('media_access','media_reserve','media_finish') THEN 'media:write'
      END;
      IF category IS NULL THEN RETURN jsonb_build_object('status',403,'error','unknown_operation'); END IF;
      retry:=vm_take_rate('mcp_'||category,sha256(uuid_send(p_room)),CASE WHEN category='questions:read' THEN 120 ELSE 60 END,60);
      IF retry>0 THEN RETURN jsonb_build_object('status',429,'error','rate_limited'); END IF;
      SELECT secret_hash INTO owner FROM room_admin_sessions WHERE room_id=p_room ORDER BY id LIMIT 1;
      IF owner IS NULL THEN RETURN jsonb_build_object('status',401); END IF;

      IF p_action='questions_list' THEN RETURN vm_question_request(p_room,owner,NULL,'list',p_data); END IF;
      IF p_action='questions_get' THEN RETURN vm_question_request(p_room,owner,(p_data->>'id')::uuid,'get','{}'); END IF;
      IF p_action LIKE 'media_%' THEN
        RETURN vm_asset_request(p_room,owner,(p_data->>'id')::uuid,substring(p_action FROM 7),p_data-'id');
      END IF;
      IF p_action='questions_update' THEN
        target:=(p_data->>'id')::uuid;
        SELECT * INTO saved FROM questions WHERE room_id=p_room AND id=target FOR UPDATE;
        IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
        -- Keep the current state and scheduling while saving the editor document
        RETURN vm_question_request(p_room,owner,target,'save',p_data->'question'||jsonb_build_object(
          'revision',p_data->>'revision','state',saved.state,'deadlineMode',saved.deadline_mode,
          'startMode',saved.start_mode));
      END IF;

      IF jsonb_typeof(p_data->'questions') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'questions') NOT BETWEEN 1 AND 20 THEN
        RETURN jsonb_build_object('status',400,'error','invalid');
      END IF;
      batch_id:=(p_data->>'requestId')::uuid;
      IF batch_id IS NULL THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
      fingerprint:=sha256(convert_to((p_data->'questions')::text,'UTF8'));
      SELECT * INTO receipt FROM room_agent_question_batches b WHERE b.room_id=p_room AND b.request_id=batch_id;
      IF FOUND THEN
        IF receipt.document_hash=fingerprint THEN RETURN receipt.response; END IF;
        RETURN jsonb_build_object('status',409,'error','idempotency_conflict');
      END IF;

      -- A failed question rolls the whole batch back
      BEGIN
        FOR item IN SELECT value FROM jsonb_array_elements(p_data->'questions') LOOP
          result:=vm_question_request(p_room,owner,NULL,'create',item||jsonb_build_object('state','draft','deadlineMode','none','startMode','none'));
          IF result->>'status' IS DISTINCT FROM '201' THEN
            failed:=result||jsonb_build_object('index',index_number);
            RAISE EXCEPTION USING ERRCODE='P0001';
          END IF;
          created:=created||jsonb_build_array(jsonb_build_object('id',result#>>'{question,id}','revision',result#>>'{question,revision}'));
          index_number:=index_number+1;
        END LOOP;
      EXCEPTION WHEN raise_exception THEN
        IF failed IS NULL THEN RAISE; END IF;
        RETURN failed;
      END;
      result:=jsonb_build_object('status',201,'questions',created);
      INSERT INTO room_agent_question_batches(room_id,request_id,document_hash,response) VALUES(p_room,batch_id,fingerprint,result);
      RETURN result;
    EXCEPTION WHEN data_exception OR integrity_constraint_violation THEN RETURN jsonb_build_object('status',400,'error','invalid');
    END $$;

    REVOKE ALL ON room_agent_tokens,room_agent_question_batches FROM PUBLIC;
    REVOKE ALL ON FUNCTION vm_room_agent_token(uuid,bytea,text,bytea,bytea),vm_room_agent_operation(uuid,bytea,text,jsonb) FROM PUBLIC;
  `);
}

// Preserve issued credentials and batch receipts if rollback is attempted
export function down(pgm) {
  pgm.sql(`
    LOCK TABLE room_agent_tokens IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM room_agent_tokens) THEN
        RAISE EXCEPTION 'Room API tokens must be cleared before rollback';
      END IF;
    END $$;
    DROP FUNCTION vm_room_agent_token(uuid,bytea,text,bytea,bytea),vm_room_agent_operation(uuid,bytea,text,jsonb);
    DROP TABLE room_agent_question_batches,room_agent_tokens;
  `);
}
