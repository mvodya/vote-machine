// Preserve the accepted rules while adding the option visibility setting
const signatures = [
  'vm_question_data(uuid)',
  'vm_question_request(uuid,bytea,uuid,text,jsonb)',
  'vm_question_request_v6(uuid,bytea,uuid,text,jsonb)',
  'vm_question_type_guard()',
];

// Set the kind on insert and keep its settings in the existing transaction
export function up(pgm) {
  pgm.sql(`
    ALTER TABLE questions ADD COLUMN hide_unavailable boolean NOT NULL DEFAULT true;
    DO $$ DECLARE signature text; name text; definition text; BEGIN
      FOREACH signature IN ARRAY ARRAY[${signatures.map((s) => `'${s}'`).join(',')}] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(signature::regprocedure),'FUNCTION public.'||name||'(','FUNCTION public.'||name||'_before_display_policy(');
        EXECUTE 'REVOKE ALL ON FUNCTION '||replace(signature,name,name||'_before_display_policy')||' FROM PUBLIC';
      END LOOP;
      definition:=pg_get_functiondef('vm_question_request_v6(uuid,bytea,uuid,text,jsonb)'::regprocedure);
      IF position('INSERT INTO questions(room_id) VALUES (p_room)' IN definition)=0 THEN RAISE EXCEPTION 'Missing question insert'; END IF;
      EXECUTE replace(definition,'INSERT INTO questions(room_id) VALUES (p_room)', $patch$INSERT INTO questions(room_id,question_type) VALUES (p_room,COALESCE(p_data->>'questionType','choice'))$patch$);
    END $$;
    CREATE OR REPLACE FUNCTION vm_question_type_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.question_type IS DISTINCT FROM OLD.question_type THEN RAISE check_violation USING MESSAGE='Question type is fixed at creation'; END IF;
      RETURN NEW;
    END $$;
    CREATE OR REPLACE FUNCTION vm_question_data(p_id uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
      SELECT vm_question_data_before_display_policy(p_id)||CASE WHEN question_type='allocation'
        THEN jsonb_build_object('hideUnavailable',hide_unavailable) ELSE '{}'::jsonb END FROM questions WHERE id=p_id;
    $$;
    CREATE OR REPLACE FUNCTION vm_question_request(p_room uuid,p_admin bytea,p_id uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb;
    BEGIN
      IF p_action IN ('create','save') THEN
        PERFORM 1 FROM rooms WHERE id=p_room AND EXISTS(SELECT 1 FROM vm_admin_room(p_room,p_admin)) FOR UPDATE;
        IF NOT FOUND THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
        IF jsonb_typeof(p_data->'choices')='array' THEN
          p_data:=jsonb_set(p_data,'{choices}',(SELECT COALESCE(jsonb_agg(item-'remaining' ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements(p_data->'choices') WITH ORDINALITY e(item,n)));
        END IF;
        IF p_data ? 'hideUnavailable' AND jsonb_typeof(p_data->'hideUnavailable') IS DISTINCT FROM 'boolean' THEN RETURN jsonb_build_object('status',400,'error','invalid'); END IF;
        IF p_action='save' AND EXISTS(SELECT 1 FROM questions WHERE id=p_id AND room_id=p_room AND question_type IS DISTINCT FROM COALESCE(p_data->>'questionType',question_type)) THEN RETURN jsonb_build_object('status',409,'error','type_fixed'); END IF;
      END IF;
      result:=vm_question_request_before_display_policy(p_room,p_admin,p_id,p_action,p_data);
      IF p_action IN ('create','save') AND result->>'status' IN ('200','201') THEN
        p_id:=(result#>>'{question,id}')::uuid;
        UPDATE questions SET hide_unavailable=(p_data->>'hideUnavailable')::boolean
          WHERE id=p_id AND question_type='allocation' AND p_data ? 'hideUnavailable' AND hide_unavailable IS DISTINCT FROM (p_data->>'hideUnavailable')::boolean;
        result:=jsonb_set(result,'{question}',result->'question'||(SELECT CASE WHEN question_type='allocation' THEN jsonb_build_object('hideUnavailable',hide_unavailable) ELSE '{}'::jsonb END || jsonb_build_object('revision',revision::text) FROM questions WHERE id=p_id));
      END IF;
      RETURN result;
    END $$;
  `);
}

// Do not silently discard an admin's visibility choice during rollback
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM questions WHERE question_type='allocation' AND NOT hide_unavailable) THEN RAISE EXCEPTION 'Enable hidden unavailable options before rollback'; END IF; END $$;
    DO $$ DECLARE signature text; name text; BEGIN
      FOREACH signature IN ARRAY ARRAY[${signatures.map((s) => `'${s}'`).join(',')}] LOOP
        name:=split_part(signature,'(',1);
        EXECUTE replace(pg_get_functiondef(replace(signature,name,name||'_before_display_policy')::regprocedure),'FUNCTION public.'||name||'_before_display_policy(','FUNCTION public.'||name||'(');
        EXECUTE 'DROP FUNCTION '||replace(signature,name,name||'_before_display_policy');
      END LOOP;
    END $$;
    ALTER TABLE questions DROP COLUMN hide_unavailable;
  `);
}
