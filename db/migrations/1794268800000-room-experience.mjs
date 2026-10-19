// Share room colors and safe sound events across replicas
export function up(pgm) {
  pgm.sql(`
    ALTER TABLE rooms ADD COLUMN accent text NOT NULL DEFAULT 'green' CHECK(accent IN ('green','blue','violet','rose','orange','amber','teal'));
    CREATE TABLE room_sound_events (
      room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      ordinal bigint NOT NULL,
      public_ordinal bigint,
      kind text NOT NULL CHECK(kind IN ('open','close','answer')),
      PRIMARY KEY(room_id,ordinal), UNIQUE(room_id,public_ordinal)
    );
    CREATE FUNCTION vm_record_sound() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE owner uuid; sound text; BEGIN
      IF TG_TABLE_NAME='questions' THEN
        IF NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;
        IF NEW.state='open' THEN sound:='open'; ELSIF OLD.state='open' THEN sound:='close'; ELSE RETURN NEW; END IF;
      ELSE sound:='answer'; END IF;
      owner:=NEW.room_id;
      PERFORM 1 FROM rooms WHERE id=owner FOR UPDATE;
      INSERT INTO room_sound_events(room_id,ordinal,public_ordinal,kind)
        VALUES(owner,COALESCE((SELECT max(ordinal) FROM room_sound_events WHERE room_id=owner),0)+1,
        CASE WHEN sound<>'answer' THEN COALESCE((SELECT max(public_ordinal) FROM room_sound_events WHERE room_id=owner),0)+1 END,sound);
      RETURN NEW;
    END $$;
    CREATE TRIGGER question_sound AFTER UPDATE ON questions FOR EACH ROW EXECUTE FUNCTION vm_record_sound();
    CREATE TRIGGER answer_sound AFTER INSERT ON ballots FOR EACH ROW EXECUTE FUNCTION vm_record_sound();
    CREATE FUNCTION vm_room_experience(p_identity uuid,p_session bytea,p_admin boolean,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE owner uuid; color text; cursor_at bigint; latest bigint; events jsonb;
    BEGIN
      IF p_admin THEN SELECT id INTO owner FROM vm_admin_room(p_identity,p_session);
      ELSE SELECT room_id INTO owner FROM vm_voting_access(p_identity,p_session); END IF;
      IF owner IS NULL THEN RETURN jsonb_build_object('status',401,'error','access'); END IF;
      IF p_data ? 'accent' THEN
        IF NOT p_admin THEN RETURN jsonb_build_object('status',403,'error','access'); END IF;
        IF jsonb_typeof(p_data->'accent') IS DISTINCT FROM 'string' OR p_data->>'accent' NOT IN ('green','blue','violet','rose','orange','amber','teal') THEN RETURN jsonb_build_object('status',400,'error','accent'); END IF;
        PERFORM 1 FROM rooms WHERE id=owner FOR UPDATE;
        UPDATE rooms SET accent=p_data->>'accent' WHERE id=owner AND accent IS DISTINCT FROM p_data->>'accent';
      END IF;
      SELECT accent INTO color FROM rooms WHERE id=owner;
      SELECT COALESCE(max(CASE WHEN p_admin THEN ordinal ELSE public_ordinal END),0) INTO latest FROM room_sound_events WHERE room_id=owner;
      cursor_at:=CASE WHEN p_data ? 'after' THEN (p_data->>'after')::bigint ELSE latest END;
      IF cursor_at<0 OR cursor_at>latest THEN cursor_at:=latest; END IF;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',seq::text,'kind',kind) ORDER BY seq),'[]') INTO events
      FROM (SELECT CASE WHEN p_admin THEN ordinal ELSE public_ordinal END AS seq,kind FROM room_sound_events WHERE room_id=owner AND CASE WHEN p_admin THEN ordinal ELSE public_ordinal END>cursor_at ORDER BY CASE WHEN p_admin THEN ordinal ELSE public_ordinal END LIMIT 100) batch;
      RETURN jsonb_build_object('status',200,'accent',color,'cursor',COALESCE(events->-1->>'id',latest::text),'events',events,'timers',COALESCE((SELECT jsonb_agg(at ORDER BY at) FROM (SELECT min(closes_at) AS at FROM questions WHERE room_id=owner AND state='open' AND scheduled_at IS NULL AND closes_at>clock_timestamp() AND closes_at<=clock_timestamp()+interval '3 minutes' GROUP BY floor(extract(epoch FROM closes_at))) pending),'[]'::jsonb));
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN jsonb_build_object('status',400,'error','cursor'); END $$;
    REVOKE ALL ON TABLE room_sound_events FROM PUBLIC;
    REVOKE ALL ON FUNCTION vm_record_sound(),vm_room_experience(uuid,bytea,boolean,jsonb) FROM PUBLIC;
  `);
}
// Remove presentation state without removing rooms or answers
export function down(pgm) {
  pgm.sql(`DROP TRIGGER question_sound ON questions; DROP TRIGGER answer_sound ON ballots;
    DROP FUNCTION vm_record_sound(),vm_room_experience(uuid,bytea,boolean,jsonb);
    DROP TABLE room_sound_events; ALTER TABLE rooms DROP COLUMN accent;`);
}
