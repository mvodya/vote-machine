// Reset answers only through an explicit versioned admin action
export function up(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      EXECUTE replace(pg_get_functiondef('vm_store_question(uuid,bytea,uuid,text,jsonb)'::regprocedure),'FUNCTION public.vm_store_question(','FUNCTION public.vm_store_question_before_reset(');
    END $$;
    CREATE FUNCTION vm_clear_answers(p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE questions SET deleting = true WHERE id = p_id;
      DELETE FROM vote_requests WHERE payload->>'questionId' = p_id::text;
      DELETE FROM ballot_choices WHERE question_id = p_id;
      DELETE FROM ballots WHERE question_id = p_id;
      UPDATE questions SET deleting = false,state = 'draft' WHERE id = p_id;
    END;
    $$;
    CREATE FUNCTION vm_reset_question(p_room uuid,p_admin bytea,p_id uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE saved questions;
    BEGIN
      PERFORM 1 FROM rooms WHERE id = p_room AND EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      SELECT * INTO saved FROM questions WHERE id = p_id AND room_id = p_room FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status',404,'error','missing'); END IF;
      IF p_data->>'revision' IS DISTINCT FROM saved.revision::text THEN RETURN jsonb_build_object('status',409,'error','conflict'); END IF;
      PERFORM vm_clear_answers(p_id);
      RETURN jsonb_build_object('status',200,'question',vm_question_data(p_id));
    END;
    $$;
    CREATE OR REPLACE FUNCTION vm_store_question(p_room uuid,p_admin bytea,p_id uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF p_action = 'save' AND p_data->>'state' = 'draft' AND EXISTS(SELECT 1 FROM questions WHERE id = p_id AND room_id = p_room AND state <> 'draft') THEN RETURN jsonb_build_object('status',409,'error','state'); END IF;
      RETURN vm_store_question_before_reset(p_room,p_admin,p_id,p_action,p_data);
    END;
    $$;
    REVOKE ALL ON FUNCTION vm_clear_answers(uuid),vm_reset_question(uuid,bytea,uuid,jsonb),vm_store_question_before_reset(uuid,bytea,uuid,text,jsonb) FROM PUBLIC;
  `);
}
// Restore the prior workspace operation without restoring erased answers
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      EXECUTE replace(pg_get_functiondef('vm_store_question_before_reset(uuid,bytea,uuid,text,jsonb)'::regprocedure),'FUNCTION public.vm_store_question_before_reset(','FUNCTION public.vm_store_question(');
    END $$;
    DROP FUNCTION vm_store_question_before_reset(uuid,bytea,uuid,text,jsonb),vm_reset_question(uuid,bytea,uuid,jsonb),vm_clear_answers(uuid);
  `);
}
