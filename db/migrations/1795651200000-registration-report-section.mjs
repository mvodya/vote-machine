// Keep registration votes out of the ordinary source breakdown
const signatures = [
  'vm_room_report_before_history(uuid,bytea,boolean,uuid,boolean)',
  'vm_delete_voting_link(uuid,bytea,uuid,text)',
  'vm_ballot_guard()',
];

export function up(pgm) {
  pgm.sql(`
    ALTER TABLE ballots ADD COLUMN retained_registration boolean NOT NULL DEFAULT false
      CHECK(NOT retained_registration OR retained_participant IS NOT NULL);

    DO $$ DECLARE signature text; name text; definition text; BEGIN
      FOREACH signature IN ARRAY ARRAY[${signatures.map((item) => `'${item}'`).join(',')}] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||name||'_before_registration_report(');
        EXECUTE 'REVOKE ALL ON FUNCTION '||replace(signature,name,name||'_before_registration_report')||' FROM PUBLIC';
      END LOOP;

      -- Filter both active and detached registration votes without exposing group identities
      definition:=pg_get_functiondef('vm_room_report_before_history(uuid,bytea,boolean,uuid,boolean)'::regprocedure);
      EXECUTE replace(definition,'SELECT kind,count(*) AS answers FROM votes GROUP BY kind',
        'SELECT v.kind,count(*) AS answers FROM votes v LEFT JOIN voting_links own ON own.id=v.link_id WHERE own.registration_group_id IS NULL AND NOT v.retained_registration GROUP BY v.kind');

      -- Remember only the link type when anonymous answers lose their link
      definition:=pg_get_functiondef('vm_delete_voting_link(uuid,bytea,uuid,text)'::regprocedure);
      EXECUTE replace(definition,'SET retained_participant=v.retained,',
        'SET retained_participant=v.retained,retained_registration=(saved.mode=''registration''),');
      definition:=pg_get_functiondef('vm_ballot_guard()'::regprocedure);
      EXECUTE replace(definition,$patch$'actor_session_id','retained_participant']$patch$,
        $patch$'actor_session_id','retained_participant','retained_registration']$patch$);
    END $$;
  `);
}

// Keep detached source history available until explicit recovery
export function down(pgm) {
  pgm.sql(`
    DO $$ DECLARE signature text; name text; BEGIN
      IF EXISTS(SELECT 1 FROM ballots WHERE retained_registration) THEN
        RAISE EXCEPTION 'Recover detached registration sources before rollback';
      END IF;
      FOREACH signature IN ARRAY ARRAY[${signatures.map((item) => `'${item}'`).join(',')}] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(replace(signature,name,name||'_before_registration_report')::regprocedure),'FUNCTION public.'||name||'_before_registration_report(','FUNCTION public.'||name||'(');
        EXECUTE 'DROP FUNCTION '||replace(signature,name,name||'_before_registration_report');
      END LOOP;
    END $$;
    ALTER TABLE ballots DROP COLUMN retained_registration;
  `);
}
