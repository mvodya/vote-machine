// Save the history choice in the same insert as each new link
export function up(pgm) {
  pgm.sql(`
    DO $$ DECLARE definition text; BEGIN
      definition:=pg_get_functiondef('vm_add_voting_links(uuid,bytea,jsonb)'::regprocedure);
      IF position('secret_hash, secret_cipher)' IN definition)=0 THEN RAISE EXCEPTION 'Missing link insert'; END IF;
      definition:=replace(definition,
        $patch$IF jsonb_typeof(item->'name')$patch$,
        $patch$IF item ? 'allowRunHistory' AND jsonb_typeof(item->'allowRunHistory') IS DISTINCT FROM 'boolean' THEN RAISE check_violation; END IF;
        IF jsonb_typeof(item->'name')$patch$);
      definition:=replace(definition,'secret_hash, secret_cipher)','secret_hash, secret_cipher, allow_run_history)');
      definition:=replace(definition,$patch$decode(item->>'cipher', 'hex')) RETURNING$patch$,$patch$decode(item->>'cipher', 'hex'), COALESCE((item->>'allowRunHistory')::boolean,false)) RETURNING$patch$);
      EXECUTE definition;
    END $$;
  `);
}

// Restore default-only creation and keep all saved history choices
export function down(pgm) {
  pgm.sql(`
    DO $$ DECLARE definition text; BEGIN
      definition:=pg_get_functiondef('vm_add_voting_links(uuid,bytea,jsonb)'::regprocedure);
      IF position('secret_hash, secret_cipher, allow_run_history)' IN definition)=0 THEN RAISE EXCEPTION 'Missing link history insert'; END IF;
      definition:=replace(definition,
        $patch$IF item ? 'allowRunHistory' AND jsonb_typeof(item->'allowRunHistory') IS DISTINCT FROM 'boolean' THEN RAISE check_violation; END IF;
        $patch$,'');
      definition:=replace(definition,'secret_hash, secret_cipher, allow_run_history)','secret_hash, secret_cipher)');
      definition:=replace(definition,$patch$decode(item->>'cipher', 'hex'), COALESCE((item->>'allowRunHistory')::boolean,false)) RETURNING$patch$,$patch$decode(item->>'cipher', 'hex')) RETURNING$patch$);
      EXECUTE definition;
    END $$;
  `);
}
