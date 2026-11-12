// New connections grant room admin access after explicit browser consent
const signatures = [
  'vm_mcp_oauth(uuid,bytea,text,jsonb)',
  'vm_mcp_operation(uuid,bytea,text,jsonb)',
];

export function up(pgm) {
  pgm.sql(`
    -- Old scoped tokens cannot turn into admin tokens without new consent
    ALTER TABLE mcp_connections ADD COLUMN full_admin boolean NOT NULL DEFAULT false;
    DO $$ DECLARE signature text; name text; definition text; BEGIN
      FOREACH signature IN ARRAY ARRAY[${signatures.map((item) => `'${item}'`).join(',')}] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||name||'_before_full_access(');
        EXECUTE 'REVOKE ALL ON FUNCTION '||replace(signature,name,name||'_before_full_access')||' FROM PUBLIC';
      END LOOP;

      definition:=pg_get_functiondef('vm_mcp_oauth(uuid,bytea,text,jsonb)'::regprocedure);
      definition:=replace(definition,$old$client_id=(p_data->>'clientId')::uuid AND revoked_at IS NULL AND$old$,
        $new$client_id=(p_data->>'clientId')::uuid AND full_admin AND revoked_at IS NULL AND$new$);
      definition:=replace(definition,$old$array_to_string(grant_row.scopes,' ')$old$,$new$'room:admin'$new$);
      definition:=replace(definition,$old$'scopes',m.scopes,$old$,$new$'requiresReconnect',NOT m.full_admin,$new$);
      -- Keep old scope data only so the previous schema can be restored
      definition:=replace(definition,$old$rights:=ARRAY(SELECT DISTINCT value FROM jsonb_array_elements_text(p_data->'scopes') ORDER BY value);$old$,
        $new$rights:=ARRAY['questions:read','questions:write','media:write'];$new$);
      definition:=replace(definition,'redirect_uri,challenge,code_hash,code_until)',
        'redirect_uri,challenge,code_hash,code_until,full_admin)');
      EXECUTE replace(definition,$old$clock_timestamp()+interval '5 minutes');$old$,$new$clock_timestamp()+interval '5 minutes',true);$new$);

      definition:=pg_get_functiondef('vm_mcp_operation(uuid,bytea,text,jsonb)'::regprocedure);
      definition:=replace(definition,'AND access_until>clock_timestamp() AND revoked_at IS NULL;',
        'AND full_admin AND access_until>clock_timestamp() AND revoked_at IS NULL;');
      definition:=replace(definition,$old$jsonb_build_object('status',200,'scopes',grant_row.scopes)$old$,$new$jsonb_build_object('status',200)$new$);
      -- Keep operation allowlisting and rate limits independent of authorization
      EXECUTE replace(definition,'required IS NULL OR NOT required=ANY(grant_row.scopes)', 'required IS NULL');
    END $$;
  `);
}

// Protect active admin grants from a silent change in access rules
export function down(pgm) {
  pgm.sql(`
    DO $$ DECLARE signature text; name text; BEGIN
      IF EXISTS(SELECT 1 FROM mcp_connections WHERE full_admin AND revoked_at IS NULL AND
        (code_until>clock_timestamp() OR refresh_until>clock_timestamp())) THEN
        RAISE EXCEPTION 'Revoke active MCP admin connections before rollback';
      END IF;
      FOREACH signature IN ARRAY ARRAY[${signatures.map((item) => `'${item}'`).join(',')}] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(replace(signature,name,name||'_before_full_access')::regprocedure),'FUNCTION public.'||name||'_before_full_access(','FUNCTION public.'||name||'(');
        EXECUTE 'DROP FUNCTION '||replace(signature,name,name||'_before_full_access');
      END LOOP;
    END $$;
    ALTER TABLE mcp_connections DROP COLUMN full_admin;
  `);
}
