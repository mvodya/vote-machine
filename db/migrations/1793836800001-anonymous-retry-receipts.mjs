// Keep the original receipt when its anonymous choice is still readable
export function up(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      EXECUTE replace(pg_get_functiondef('vm_session_receipt(jsonb,bytea)'::regprocedure),'FUNCTION public.vm_session_receipt(','FUNCTION public.vm_session_receipt_before_retry(');
    END $$;
    CREATE OR REPLACE FUNCTION vm_session_receipt(p_reply jsonb,p_session bytea) RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT CASE WHEN p_reply#>>'{answer,id}' IS NOT NULL AND vm_session_answer((p_reply#>>'{answer,id}')::uuid,p_session)->>'hidden'='true'
        THEN jsonb_set(p_reply,'{answer}',vm_session_answer((p_reply#>>'{answer,id}')::uuid,p_session)) ELSE p_reply END;
    $$;
    REVOKE ALL ON FUNCTION vm_session_receipt_before_retry(jsonb,bytea) FROM PUBLIC;
  `);
}
// Restore the previous receipt projection
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      EXECUTE replace(pg_get_functiondef('vm_session_receipt_before_retry(jsonb,bytea)'::regprocedure),'FUNCTION public.vm_session_receipt_before_retry(','FUNCTION public.vm_session_receipt(');
    END $$;
    DROP FUNCTION vm_session_receipt_before_retry(jsonb,bytea);
  `);
}
