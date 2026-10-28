// Keep a submitted empty answer as an empty list in result pages
export function up(pgm) {
  pgm.sql(`
    DO $$ DECLARE definition text; BEGIN
      definition:=pg_get_functiondef('vm_results_before_review(uuid,bytea,boolean,uuid,jsonb)'::regprocedure);
      IF position($patch$'choices',(SELECT jsonb_agg(option_id ORDER BY option_id) FROM ballot_choices WHERE ballot_id=b.id)$patch$ IN definition)=0 THEN
        RAISE EXCEPTION 'Missing result choices expression';
      END IF;
      EXECUTE replace(definition,
        $patch$'choices',(SELECT jsonb_agg(option_id ORDER BY option_id) FROM ballot_choices WHERE ballot_id=b.id)$patch$,
        $patch$'choices',COALESCE((SELECT jsonb_agg(option_id ORDER BY option_id) FROM ballot_choices WHERE ballot_id=b.id),'[]'::jsonb)$patch$);
    END $$;
  `);
}

// Restore the previous reader without changing any saved answer
export function down(pgm) {
  pgm.sql(`
    DO $$ DECLARE definition text; BEGIN
      definition:=pg_get_functiondef('vm_results_before_review(uuid,bytea,boolean,uuid,jsonb)'::regprocedure);
      IF position($patch$'choices',COALESCE((SELECT jsonb_agg(option_id ORDER BY option_id) FROM ballot_choices WHERE ballot_id=b.id),'[]'::jsonb)$patch$ IN definition)=0 THEN
        RAISE EXCEPTION 'Missing empty result choices expression';
      END IF;
      EXECUTE replace(definition,
        $patch$'choices',COALESCE((SELECT jsonb_agg(option_id ORDER BY option_id) FROM ballot_choices WHERE ballot_id=b.id),'[]'::jsonb)$patch$,
        $patch$'choices',(SELECT jsonb_agg(option_id ORDER BY option_id) FROM ballot_choices WHERE ballot_id=b.id)$patch$);
    END $$;
  `);
}
