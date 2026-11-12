// Keep registration answers in their own source category
export function up(pgm) {
  pgm.sql(`
    ALTER FUNCTION vm_results(uuid,bytea,boolean,uuid,jsonb) RENAME TO vm_results_before_registration_sources;
    CREATE FUNCTION vm_results(p_identity uuid,p_session bytea,p_admin boolean,p_question uuid,p_data jsonb)
      RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; sources jsonb;
    BEGIN
      result:=vm_results_before_registration_sources(p_identity,p_session,p_admin,p_question,p_data);
      IF p_admin AND result->>'status'='200' AND result#>'{result,sources}' IS NOT NULL THEN
        SELECT jsonb_build_object(
          'personal',count(*) FILTER(WHERE b.source IN ('personal','admin_personal') AND l.registration_group_id IS NULL AND NOT b.retained_registration),
          'reusable',count(*) FILTER(WHERE b.source='reusable'),
          'registration',count(*) FILTER(WHERE l.registration_group_id IS NOT NULL OR b.retained_registration),
          'admin_manual',count(*) FILTER(WHERE b.source='admin_manual'))
          INTO sources FROM ballots b LEFT JOIN voting_links l ON l.id=b.link_id
          WHERE b.question_id=p_question AND vm_ballot_complete(b.id);
        result:=jsonb_set(result,'{result,sources}',sources);
      END IF;
      RETURN result;
    END $$;

    DO $$ DECLARE definition text; BEGIN
      definition:=pg_get_functiondef('vm_room_report_before_history(uuid,bytea,boolean,uuid,boolean)'::regprocedure);
      EXECUTE replace(definition,'FUNCTION public.vm_room_report_before_history(','FUNCTION public.vm_room_report_before_answer_sources(');
      -- Retain only the link type for detached anonymous answers
      EXECUTE replace(definition,
        'SELECT v.kind,count(*) AS answers FROM votes v LEFT JOIN voting_links own ON own.id=v.link_id WHERE own.registration_group_id IS NULL AND NOT v.retained_registration GROUP BY v.kind',
        'SELECT CASE WHEN own.registration_group_id IS NOT NULL OR v.retained_registration THEN ''registration'' ELSE v.kind END AS kind,count(*) AS answers FROM votes v LEFT JOIN voting_links own ON own.id=v.link_id GROUP BY 1');
    END $$;
    REVOKE ALL ON FUNCTION vm_results(uuid,bytea,boolean,uuid,jsonb),vm_room_report_before_answer_sources(uuid,bytea,boolean,uuid,boolean) FROM PUBLIC;
  `);
}

// Restore the old presentation while retaining all answers
export function down(pgm) {
  pgm.sql(`
    DROP FUNCTION vm_results(uuid,bytea,boolean,uuid,jsonb);
    ALTER FUNCTION vm_results_before_registration_sources(uuid,bytea,boolean,uuid,jsonb) RENAME TO vm_results;
    DO $$ BEGIN
      EXECUTE replace(pg_get_functiondef('vm_room_report_before_answer_sources(uuid,bytea,boolean,uuid,boolean)'::regprocedure),
        'FUNCTION public.vm_room_report_before_answer_sources(','FUNCTION public.vm_room_report_before_history(');
    END $$;
    DROP FUNCTION vm_room_report_before_answer_sources(uuid,bytea,boolean,uuid,boolean);
  `);
}
