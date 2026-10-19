// Share request budgets between every API and web replica
export function up(pgm) {
  pgm.sql(`
    CREATE TABLE request_limits (
      scope text NOT NULL,
      key_hash bytea NOT NULL CHECK(octet_length(key_hash)=32),
      tokens double precision NOT NULL CHECK(tokens>=0),
      updated_at timestamptz NOT NULL,
      PRIMARY KEY(scope,key_hash)
    );
    CREATE INDEX request_limits_cleanup ON request_limits(updated_at);
    CREATE FUNCTION vm_take_rate(p_scope text,p_key bytea,p_capacity integer,p_period integer) RETURNS integer LANGUAGE plpgsql AS $$
    DECLARE saved request_limits; available double precision; now_at timestamptz;
    BEGIN
      IF p_capacity<1 OR p_period<1 OR length(p_scope)>40 THEN RAISE check_violation; END IF;
      INSERT INTO request_limits(scope,key_hash,tokens,updated_at) VALUES(p_scope,p_key,p_capacity,clock_timestamp()) ON CONFLICT DO NOTHING;
      SELECT * INTO saved FROM request_limits WHERE scope=p_scope AND key_hash=p_key FOR UPDATE;
      now_at:=GREATEST(clock_timestamp(),saved.updated_at);
      available:=LEAST(p_capacity,saved.tokens+extract(epoch FROM now_at-saved.updated_at)*p_capacity/p_period);
      IF available<1 THEN
        UPDATE request_limits SET tokens=available,updated_at=now_at WHERE scope=p_scope AND key_hash=p_key;
        RETURN GREATEST(1,ceil((1-available)*p_period/p_capacity)::integer);
      END IF;
      UPDATE request_limits SET tokens=available-1,updated_at=now_at WHERE scope=p_scope AND key_hash=p_key;
      RETURN 0;
    END;
    $$;
    CREATE FUNCTION vm_request_admission(p_network bytea,p_identity uuid,p_session bytea,p_role text,p_action text,p_limits jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE wait_seconds integer; owner uuid;
    BEGIN
      wait_seconds:=vm_take_rate('network',p_network,(p_limits->>'network')::integer,60);
      IF wait_seconds>0 THEN RETURN jsonb_build_object('allowed',false,'retryAfter',wait_seconds); END IF;
      IF p_action='create' THEN
        wait_seconds:=vm_take_rate('create',p_network,(p_limits->>'create')::integer,3600);
        IF wait_seconds>0 THEN RETURN jsonb_build_object('allowed',false,'retryAfter',wait_seconds); END IF;
      END IF;
      IF p_role='admin' THEN SELECT id INTO owner FROM vm_admin_room(p_identity,p_session);
      ELSIF p_role='vote' THEN SELECT room_id INTO owner FROM vm_voting_access(p_identity,p_session); END IF;
      IF owner IS NOT NULL THEN
        wait_seconds:=vm_take_rate(CASE WHEN p_action='read' THEN 'session_read' ELSE 'session_write' END,p_session,(p_limits->>CASE WHEN p_action='read' THEN 'read' ELSE 'write' END)::integer,60);
        IF wait_seconds>0 THEN RETURN jsonb_build_object('allowed',false,'retryAfter',wait_seconds); END IF;
        IF p_action<>'read' THEN
          wait_seconds:=vm_take_rate('room',decode(md5(owner::text)||md5('room:'||owner::text),'hex'),(p_limits->>'room')::integer,60);
          IF wait_seconds>0 THEN RETURN jsonb_build_object('allowed',false,'retryAfter',wait_seconds); END IF;
        END IF;
      END IF;
      RETURN jsonb_build_object('allowed',true);
    END;
    $$;
    CREATE FUNCTION vm_security_cleanup() RETURNS void LANGUAGE sql AS $$
      DELETE FROM request_limits WHERE (scope,key_hash) IN (SELECT scope,key_hash FROM request_limits WHERE updated_at<clock_timestamp()-interval '2 days' ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1000);
    $$;
    REVOKE ALL ON TABLE request_limits FROM PUBLIC;
    REVOKE ALL ON FUNCTION vm_take_rate(text,bytea,integer,integer),vm_request_admission(bytea,uuid,bytea,text,text,jsonb),vm_security_cleanup() FROM PUBLIC;
  `);
}
// Remove only transient request budgets
export function down(pgm) {
  pgm.sql(`
    DROP FUNCTION vm_security_cleanup(),vm_request_admission(bytea,uuid,bytea,text,text,jsonb),vm_take_rate(text,bytea,integer,integer);
    DROP TABLE request_limits;
  `);
}
