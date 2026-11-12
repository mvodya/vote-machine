// Keep registration groups and member IDs in the private export
export function up(pgm) {
  pgm.sql(`
    ALTER FUNCTION vm_room_report(uuid,bytea,boolean,uuid,boolean) RENAME TO vm_room_report_before_export_identities;
    CREATE FUNCTION vm_room_report(p_identity uuid,p_session bytea,p_admin boolean,p_run uuid,p_export boolean)
      RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; page jsonb;
    BEGIN
      result:=vm_room_report_before_export_identities(p_identity,p_session,p_admin,p_run,p_export);
      IF p_admin AND p_export AND result->>'status'='200' AND jsonb_typeof(result#>'{report,people}')='array' THEN
        -- The existing report has already removed anonymous and hidden answers
        SELECT COALESCE(jsonb_agg(item||CASE WHEN g.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
          'kind','registration','memberId',m.id,'groupId',g.id,'groupName',g.name
        ) END ORDER BY n),'[]'::jsonb) INTO page
        FROM jsonb_array_elements(result#>'{report,people}') WITH ORDINALITY e(item,n)
        LEFT JOIN registration_members m ON item->>'id'='p:'||m.link_id::text
        LEFT JOIN voting_links g ON g.id=m.group_id;
        result:=jsonb_set(result,'{report,people}',page);
      END IF;
      RETURN result;
    END $$;
    REVOKE ALL ON FUNCTION vm_room_report(uuid,bytea,boolean,uuid,boolean) FROM PUBLIC;
  `);
}

// Restore the previous report without changing any identity or answer
export function down(pgm) {
  pgm.sql(`
    DROP FUNCTION vm_room_report(uuid,bytea,boolean,uuid,boolean);
    ALTER FUNCTION vm_room_report_before_export_identities(uuid,bytea,boolean,uuid,boolean) RENAME TO vm_room_report;
  `);
}
