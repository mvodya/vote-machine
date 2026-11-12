// Store revocable room connections for remote agents
export function up(pgm) {
  pgm.sql(`
    CREATE TABLE mcp_clients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 100),
      redirects text[] NOT NULL CHECK(cardinality(redirects) BETWEEN 1 AND 5),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE mcp_connections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      admin_id uuid NOT NULL REFERENCES room_admin_sessions(id) ON DELETE CASCADE,
      client_id uuid NOT NULL REFERENCES mcp_clients(id),
      resource text NOT NULL CHECK(char_length(resource) BETWEEN 1 AND 512),
      scopes text[] NOT NULL CHECK(cardinality(scopes)>0 AND scopes <@ ARRAY['questions:read','questions:write','media:write']),
      redirect_uri text NOT NULL,
      challenge text NOT NULL CHECK(challenge ~ '^[A-Za-z0-9_-]{43}$'),
      code_hash bytea UNIQUE CHECK(octet_length(code_hash)=32),
      code_until timestamptz NOT NULL,
      access_hash bytea UNIQUE CHECK(octet_length(access_hash)=32),
      access_until timestamptz,
      refresh_hash bytea UNIQUE CHECK(octet_length(refresh_hash)=32),
      refresh_until timestamptz,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX mcp_connections_room ON mcp_connections(room_id,created_at DESC);
    CREATE INDEX mcp_connections_client ON mcp_connections(client_id);
    CREATE INDEX mcp_connections_admin ON mcp_connections(admin_id);
    CREATE TABLE mcp_question_batches (
      connection_id uuid REFERENCES mcp_connections(id) ON DELETE CASCADE,
      request_id uuid,
      document_hash bytea NOT NULL CHECK(octet_length(document_hash)=32),
      response jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(connection_id,request_id)
    );

    -- The web server validates redirect URLs before storing public clients
    CREATE FUNCTION vm_mcp_oauth(p_room uuid,p_secret bytea,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE client mcp_clients; grant_row mcp_connections; owner room_admin_sessions; label text; rights text[];
    BEGIN
      IF p_action='register' THEN
        IF vm_take_rate('mcp_register',decode(p_data->>'network','hex'),30,3600)>0 THEN RETURN jsonb_build_object('status',429); END IF;
        PERFORM pg_advisory_xact_lock(13071346);
        DELETE FROM mcp_clients c WHERE c.created_at<clock_timestamp()-interval '1 day'
          AND NOT EXISTS(SELECT 1 FROM mcp_connections m WHERE m.client_id=c.id);
        IF (SELECT count(*) FROM mcp_clients)>=10000 THEN RETURN jsonb_build_object('status',429); END IF;
        INSERT INTO mcp_clients(name,redirects) VALUES(p_data->>'name',ARRAY(SELECT jsonb_array_elements_text(p_data->'redirects'))) RETURNING * INTO client;
        RETURN jsonb_build_object('status',201,'clientId',client.id);
      END IF;

      -- Keep consent, token exchange and revocation in the same lock order
      IF p_action NOT IN ('consent','connections','authorize','revoke','token') THEN RETURN jsonb_build_object('status',400); END IF;
      PERFORM 1 FROM rooms WHERE id=p_room FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401); END IF;
      IF p_action='token' THEN
        SELECT * INTO grant_row FROM mcp_connections WHERE room_id=p_room AND resource=p_data->>'resource'
          AND client_id=(p_data->>'clientId')::uuid AND revoked_at IS NULL AND
          ((p_data->>'grant'='authorization_code' AND code_hash=p_secret AND code_until>clock_timestamp()
            AND challenge=p_data->>'challenge' AND redirect_uri=p_data->>'redirect')
           OR (p_data->>'grant'='refresh_token' AND refresh_hash=p_secret AND refresh_until>clock_timestamp())) FOR UPDATE;
        IF NOT FOUND THEN RETURN jsonb_build_object('status',400,'error','invalid_grant'); END IF;
        UPDATE mcp_connections SET code_hash=NULL,access_hash=decode(p_data->>'accessHash','hex'),
          refresh_hash=decode(p_data->>'refreshHash','hex'),access_until=clock_timestamp()+interval '1 hour',
          refresh_until=clock_timestamp()+interval '30 days' WHERE id=grant_row.id;
        RETURN jsonb_build_object('status',200,'scope',array_to_string(grant_row.scopes,' '));
      END IF;

      SELECT * INTO owner FROM room_admin_sessions WHERE room_id=p_room AND secret_hash=p_secret;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401); END IF;
      IF p_action='connections' THEN
        RETURN jsonb_build_object('status',200,'connections',COALESCE((
          SELECT jsonb_agg(jsonb_build_object('id',m.id,'name',c.name,'scopes',m.scopes,'createdAt',m.created_at) ORDER BY m.created_at DESC)
          FROM mcp_connections m JOIN mcp_clients c ON c.id=m.client_id
          WHERE m.room_id=p_room AND m.revoked_at IS NULL AND (m.code_until>clock_timestamp() OR m.refresh_until>clock_timestamp())
        ),'[]'::jsonb));
      END IF;
      IF p_action='revoke' THEN
        UPDATE mcp_connections SET revoked_at=clock_timestamp(),code_hash=NULL,access_hash=NULL,refresh_hash=NULL
          WHERE room_id=p_room AND id=(p_data->>'id')::uuid AND revoked_at IS NULL;
        RETURN jsonb_build_object('status',200);
      END IF;
      SELECT * INTO client FROM mcp_clients WHERE id=(p_data->>'clientId')::uuid AND p_data->>'redirect'=ANY(redirects);
      IF NOT FOUND THEN RETURN jsonb_build_object('status',400); END IF;
      IF p_action='consent' THEN
        SELECT name INTO label FROM rooms WHERE id=p_room;
        RETURN jsonb_build_object('status',200,'roomName',label,'clientName',client.name);
      END IF;
      rights:=ARRAY(SELECT DISTINCT value FROM jsonb_array_elements_text(p_data->'scopes') ORDER BY value);
      IF (SELECT count(*) FROM mcp_connections WHERE room_id=p_room AND revoked_at IS NULL
          AND (code_until>clock_timestamp() OR refresh_until>clock_timestamp()))>=40 THEN RETURN jsonb_build_object('status',409); END IF;
      INSERT INTO mcp_connections(room_id,admin_id,client_id,resource,scopes,redirect_uri,challenge,code_hash,code_until)
        VALUES(p_room,owner.id,client.id,p_data->>'resource',rights,p_data->>'redirect',p_data->>'challenge',
          decode(p_data->>'codeHash','hex'),clock_timestamp()+interval '5 minutes');
      RETURN jsonb_build_object('status',200);
    EXCEPTION WHEN data_exception OR integrity_constraint_violation THEN RETURN jsonb_build_object('status',400);
    END $$;

    -- Check each operation before borrowing the room owner's database context
    CREATE FUNCTION vm_mcp_operation(p_room uuid,p_secret bytea,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE grant_row mcp_connections; owner bytea; required text; item jsonb; result jsonb; failed jsonb;
      created jsonb:='[]'; target uuid; saved questions; receipt mcp_question_batches;
      fingerprint bytea; batch_id uuid; index_number integer:=0; retry integer;
    BEGIN
      PERFORM 1 FROM rooms WHERE id=p_room FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401); END IF;
      SELECT * INTO grant_row FROM mcp_connections WHERE room_id=p_room AND access_hash=p_secret AND resource=p_data->>'resource'
        AND access_until>clock_timestamp() AND revoked_at IS NULL;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401); END IF;
      IF p_action='access' THEN RETURN jsonb_build_object('status',200,'scopes',grant_row.scopes); END IF;
      required:=CASE
        WHEN p_action IN ('questions_list','questions_get') THEN 'questions:read'
        WHEN p_action IN ('questions_create_batch','questions_update') THEN 'questions:write'
        WHEN p_action IN ('media_access','media_reserve','media_finish') THEN 'media:write'
      END;
      IF required IS NULL OR NOT required=ANY(grant_row.scopes) THEN RETURN jsonb_build_object('status',403,'error','insufficient_scope'); END IF;
      retry:=vm_take_rate('mcp_'||required,sha256(uuid_send(grant_row.id)),CASE WHEN required='questions:read' THEN 120 ELSE 60 END,60);
      IF retry>0 THEN RETURN jsonb_build_object('status',429,'error','rate_limited'); END IF;
      SELECT secret_hash INTO owner FROM room_admin_sessions WHERE room_id=p_room AND id=grant_row.admin_id;
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
      SELECT * INTO receipt FROM mcp_question_batches b WHERE b.connection_id=grant_row.id AND b.request_id=batch_id;
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
      INSERT INTO mcp_question_batches(connection_id,request_id,document_hash,response) VALUES(grant_row.id,batch_id,fingerprint,result);
      RETURN result;
    EXCEPTION WHEN data_exception OR integrity_constraint_violation THEN RETURN jsonb_build_object('status',400,'error','invalid');
    END $$;

    REVOKE ALL ON mcp_clients,mcp_connections,mcp_question_batches FROM PUBLIC;
    REVOKE ALL ON FUNCTION vm_mcp_oauth(uuid,bytea,text,jsonb),vm_mcp_operation(uuid,bytea,text,jsonb) FROM PUBLIC;
  `);
}

// Refuse to drop issued credentials without an explicit revocation
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM mcp_connections WHERE revoked_at IS NULL AND
        (code_until>clock_timestamp() OR refresh_until>clock_timestamp())) THEN
        RAISE EXCEPTION 'Revoke active MCP connections before rollback';
      END IF;
    END $$;
    DROP FUNCTION vm_mcp_operation(uuid,bytea,text,jsonb),vm_mcp_oauth(uuid,bytea,text,jsonb);
    DROP TABLE mcp_question_batches,mcp_connections,mcp_clients;
  `);
}
