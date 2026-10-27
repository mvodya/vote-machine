// Allow a sent answer with no selected options
export function up(pgm) {
  pgm.sql(`
    ALTER TABLE questions DROP CONSTRAINT questions_min_choices_check;
    ALTER TABLE questions ADD CONSTRAINT questions_min_choices_check CHECK (min_choices BETWEEN 0 AND 100);
    ALTER TABLE questions ADD CONSTRAINT questions_max_choices_positive CHECK (max_choices >= 1);
    DO $$ DECLARE definition text; signature text; BEGIN
      definition:=pg_get_functiondef('vm_valid_question_document(jsonb)'::regprocedure);
      definition:=replace(definition,'NOT BETWEEN 1 AND (p_data->>''maxChoices'')::integer','NOT BETWEEN 0 AND (p_data->>''maxChoices'')::integer');
      definition:=replace(definition,'OR (p_data->>''maxChoices'')::integer > greatest(amount, 1)','OR (p_data->>''maxChoices'')::integer < 1 OR (p_data->>''maxChoices'')::integer > greatest(amount, 1)');
      EXECUTE definition;
      FOREACH signature IN ARRAY ARRAY['vm_cast_personal(uuid,bytea,uuid,jsonb)','vm_cast_ballot(uuid,uuid,bytea,boolean,uuid,jsonb)'] LOOP
        definition:=pg_get_functiondef(signature::regprocedure);
        definition:=replace(definition,'jsonb_array_length(p_data->''choices'') NOT BETWEEN 1 AND 100','jsonb_array_length(p_data->''choices'') NOT BETWEEN 0 AND 100');
        definition:=replace(definition,'FROM unnest(ids) id;', $patch$FROM unnest(ids) id;
      -- Empty choices still complete an expected answer
      UPDATE questions SET state='closed',closed_reason='all_voted' WHERE id=p_question AND state='open' AND min_choices=0 AND close_when_all_answered AND vm_all_expected_answered(id);$patch$);
        EXECUTE definition;
      END LOOP;
    END $$;
  `);
}

// Refuse rollback until zero-minimum questions have been recovered
export function down(pgm) {
  pgm.sql(`
    ALTER TABLE questions DROP CONSTRAINT questions_min_choices_check;
    ALTER TABLE questions ADD CONSTRAINT questions_min_choices_check CHECK (min_choices BETWEEN 1 AND 100);
    ALTER TABLE questions DROP CONSTRAINT questions_max_choices_positive;
    DO $$ DECLARE definition text; signature text; BEGIN
      definition:=pg_get_functiondef('vm_valid_question_document(jsonb)'::regprocedure);
      definition:=replace(definition,'NOT BETWEEN 0 AND (p_data->>''maxChoices'')::integer','NOT BETWEEN 1 AND (p_data->>''maxChoices'')::integer');
      definition:=replace(definition,'OR (p_data->>''maxChoices'')::integer < 1 OR (p_data->>''maxChoices'')::integer > greatest(amount, 1)','OR (p_data->>''maxChoices'')::integer > greatest(amount, 1)');
      EXECUTE definition;
      FOREACH signature IN ARRAY ARRAY['vm_cast_personal(uuid,bytea,uuid,jsonb)','vm_cast_ballot(uuid,uuid,bytea,boolean,uuid,jsonb)'] LOOP
        definition:=pg_get_functiondef(signature::regprocedure);
        definition:=replace(definition,'jsonb_array_length(p_data->''choices'') NOT BETWEEN 0 AND 100','jsonb_array_length(p_data->''choices'') NOT BETWEEN 1 AND 100');
        definition:=replace(definition,$patch$
      -- Empty choices still complete an expected answer
      UPDATE questions SET state='closed',closed_reason='all_voted' WHERE id=p_question AND state='open' AND min_choices=0 AND close_when_all_answered AND vm_all_expected_answered(id);$patch$,'');
        EXECUTE definition;
      END LOOP;
    END $$;
  `);
}
