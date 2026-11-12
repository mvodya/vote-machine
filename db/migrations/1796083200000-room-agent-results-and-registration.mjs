// Share result and roster rules with the room admin page
export function up(pgm) {
  pgm.sql(`
    ALTER FUNCTION vm_room_agent_operation(uuid,bytea,text,jsonb) RENAME TO vm_room_agent_question_operation;

    CREATE FUNCTION vm_room_agent_operation(p_room uuid,p_secret bytea,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE access jsonb; owner bytea; selected_group uuid; selected_question uuid; cursor_id uuid;
      after_key bigint; page jsonb; next_page text; write_action boolean;
    BEGIN
      IF p_action NOT IN ('results_list','results_get','results_summary','registration_groups_list',
        'registration_members_list','registration_member_rename','registration_member_moderate','registration_results') THEN
        RETURN vm_room_agent_question_operation(p_room,p_secret,p_action,p_data);
      END IF;

      -- Keep access and rotation in the same room lock order
      access:=vm_room_agent_question_operation(p_room,p_secret,'access','{}');
      IF access->>'status'<>'200' THEN RETURN access; END IF;
      p_room:=(access->>'room')::uuid;
      SELECT secret_hash INTO owner FROM room_admin_sessions WHERE room_id=p_room ORDER BY id LIMIT 1;
      IF owner IS NULL THEN RETURN jsonb_build_object('status',401,'error','invalid_token'); END IF;
      write_action:=p_action IN ('registration_member_rename','registration_member_moderate');
      IF vm_take_rate(CASE WHEN write_action THEN 'mcp_roster_write' ELSE 'mcp_results_read' END,
        sha256(uuid_send(p_room)),CASE WHEN write_action THEN 60 ELSE 120 END,60)>0 THEN
        RETURN jsonb_build_object('status',429,'error','rate_limited');
      END IF;

      IF p_action='results_list' THEN
        RETURN vm_results(p_room,owner,true,NULL,p_data-'view');
      ELSIF p_action='results_get' THEN
        selected_question:=(p_data->>'questionId')::uuid;
        IF selected_question IS NULL THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
        RETURN vm_results(p_room,owner,true,selected_question,p_data-'view');
      ELSIF p_action='results_summary' THEN
        RETURN vm_results(p_room,owner,true,NULL,'{"view":"summary"}');
      END IF;

      IF p_action='registration_groups_list' THEN
        after_key:=COALESCE((p_data->>'after')::bigint,0);
        IF after_key<0 THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
        WITH selected AS MATERIALIZED (
          SELECT id,name,ordinal,require_moderation,revoked_at FROM voting_links
          WHERE room_id=p_room AND mode='registration' AND (after_key=0 OR ordinal<after_key)
          ORDER BY ordinal DESC LIMIT 51
        ), visible AS (
          SELECT * FROM selected ORDER BY ordinal DESC LIMIT 50
        )
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'name',name,'requireModeration',require_moderation,
          'revokedAt',revoked_at) ORDER BY ordinal DESC),'[]'::jsonb),
          CASE WHEN (SELECT count(*) FROM selected)>50 THEN min(ordinal)::text END
          INTO page,next_page FROM visible;
        RETURN jsonb_build_object('status',200,'groups',page,'nextCursor',next_page);
      END IF;

      selected_group:=(p_data->>'groupId')::uuid;
      IF p_action='registration_members_list' THEN
        RETURN vm_registration_admin(p_room,owner,selected_group,NULL,'list',p_data);
      ELSIF p_action='registration_member_rename' THEN
        RETURN vm_registration_admin(p_room,owner,selected_group,(p_data->>'memberId')::uuid,'rename',p_data);
      ELSIF p_action='registration_member_moderate' THEN
        -- Allow moderation actions without returning any personal access keys
        IF p_data->>'action' IS NULL OR p_data->>'action' NOT IN ('approve','reject','block','unblock','call') THEN
          RETURN jsonb_build_object('status',400,'error','invalid');
        END IF;
        RETURN vm_registration_admin(p_room,owner,selected_group,(p_data->>'memberId')::uuid,p_data->>'action',p_data);
      END IF;

      -- Match both IDs to this room before reading individual answers
      IF NOT EXISTS(SELECT 1 FROM voting_links WHERE id=selected_group AND room_id=p_room AND mode='registration') THEN
        RETURN jsonb_build_object('status',404,'error','missing');
      END IF;
      selected_question:=(p_data->>'questionId')::uuid;
      IF NOT EXISTS(SELECT 1 FROM questions WHERE id=selected_question AND room_id=p_room) THEN
        RETURN jsonb_build_object('status',404,'error','missing');
      END IF;
      -- A group filter could reveal an anonymous vote even without names
      IF NOT EXISTS(SELECT 1 FROM questions WHERE id=selected_question AND NOT anonymous AND state<>'draft' AND first_opened_at IS NOT NULL)
        OR NOT vm_results_allowed(selected_question,p_room,NULL,true) THEN
        RETURN jsonb_build_object('status',200,'available',false);
      END IF;

      cursor_id:=(p_data->>'after')::uuid;
      WITH selected AS MATERIALIZED (
        SELECT b.id,m.id AS member_id,m.name FROM ballots b
        JOIN registration_members m ON m.link_id=b.link_id
        WHERE b.question_id=selected_question AND m.group_id=selected_group
          AND vm_ballot_complete(b.id) AND (cursor_id IS NULL OR b.id>cursor_id)
        ORDER BY b.id LIMIT 51
      ), visible AS (
        SELECT * FROM selected ORDER BY id LIMIT 50
      )
      SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId',v.member_id,'name',v.name,'choices',
        COALESCE((SELECT jsonb_agg(c.option_id ORDER BY o.position) FROM ballot_choices c
          JOIN question_options o ON o.id=c.option_id WHERE c.ballot_id=v.id),'[]'::jsonb)) ORDER BY v.id),'[]'::jsonb),
        CASE WHEN (SELECT count(*) FROM selected)>50 THEN (SELECT id::text FROM visible ORDER BY id DESC LIMIT 1) END
        INTO page,next_page FROM visible v;
      RETURN jsonb_build_object('status',200,'available',true,'groupId',selected_group,'questionId',selected_question,'answers',page,'nextCursor',next_page);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RETURN jsonb_build_object('status',400,'error','invalid');
    END $$;
    REVOKE ALL ON FUNCTION vm_room_agent_operation(uuid,bytea,text,jsonb) FROM PUBLIC;
  `);
}

// Restore the question tools and keep all results and roster changes
export function down(pgm) {
  pgm.sql(`
    DROP FUNCTION vm_room_agent_operation(uuid,bytea,text,jsonb);
    ALTER FUNCTION vm_room_agent_question_operation(uuid,bytea,text,jsonb) RENAME TO vm_room_agent_operation;
  `);
}
