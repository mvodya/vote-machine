// Apply session and room budgets to registration lobbies too
export function up(pgm) {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION vm_request_admission(p_network bytea,p_identity uuid,p_session bytea,p_role text,p_action text,p_limits jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE wait_seconds integer; owner uuid;
    BEGIN
      wait_seconds:=vm_take_rate('network',p_network,(p_limits->>'network')::integer,60);
      IF wait_seconds>0 THEN RETURN jsonb_build_object('allowed',false,'retryAfter',wait_seconds); END IF;
      IF p_action='create' THEN
        wait_seconds:=vm_take_rate('create',p_network,(p_limits->>'create')::integer,3600);
        IF wait_seconds>0 THEN RETURN jsonb_build_object('allowed',false,'retryAfter',wait_seconds); END IF;
      END IF;
      IF p_role='admin' THEN SELECT id INTO owner FROM vm_admin_room(p_identity,p_session);
      ELSIF p_role='vote' THEN SELECT room_id INTO owner FROM vm_voting_entry(p_identity,p_session); END IF;
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
  `);
}

// Restore the access lookup used before registration
export function down(pgm) {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION vm_request_admission(p_network bytea,p_identity uuid,p_session bytea,p_role text,p_action text,p_limits jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
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
  `);
}
