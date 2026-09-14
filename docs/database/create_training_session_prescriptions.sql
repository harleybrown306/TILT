BEGIN;

CREATE TABLE public.training_session_prescriptions (
  session_id uuid PRIMARY KEY REFERENCES public.training_sessions(id) ON DELETE RESTRICT,
  workout_id uuid NOT NULL,
  workout_name text NOT NULL CHECK (char_length(btrim(workout_name)) > 0),
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  capture_basis text NOT NULL CHECK (capture_basis IN ('session_created', 'legacy_backfill')),
  prescribed_work_ms bigint NOT NULL CHECK (prescribed_work_ms >= 0),
  prescribed_rest_ms bigint NOT NULL CHECK (prescribed_rest_ms >= 0),
  prescribed_total_ms bigint NOT NULL CHECK (prescribed_total_ms = prescribed_work_ms + prescribed_rest_ms),
  step_count integer NOT NULL CHECK (step_count > 0),
  steps jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) = step_count)
);
COMMENT ON TABLE public.training_session_prescriptions IS 'Immutable V1 historical prescription captured for one training session.';
CREATE INDEX training_session_prescriptions_workout_id_idx ON public.training_session_prescriptions(workout_id);
ALTER TABLE public.training_session_prescriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY training_session_prescriptions_select ON public.training_session_prescriptions FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.training_sessions ts WHERE ts.id = session_id));
REVOKE ALL ON public.training_session_prescriptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.training_session_prescriptions TO authenticated;

CREATE FUNCTION private.capture_training_session_prescription_row(p_session_id uuid, p_workout_id uuid, p_basis text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_name text; v_steps jsonb; v_count integer; v_work bigint; v_rest bigint;
BEGIN
  IF p_basis NOT IN ('session_created','legacy_backfill') THEN RAISE EXCEPTION 'Unsupported capture basis'; END IF;
  SELECT w.name, count(we.id)::integer,
    coalesce(sum(we.duration_seconds::bigint * 1000),0), coalesce(sum(we.rest_seconds::bigint * 1000),0),
    coalesce(jsonb_agg(jsonb_build_object('workout_exercise_id',we.id,'exercise_id',we.exercise_id,
      'exercise_name',coalesce(nullif(btrim(we.exercise_snapshot->>'exercise_name'),''),nullif(btrim(e.name),'')),
      'position',we.position,'work_ms',we.duration_seconds::bigint*1000,'rest_ms',we.rest_seconds::bigint*1000,
      'off_hand',we.off_hand,'notes',we.notes) order by we.position,we.id) filter(where we.id is not null),'[]'::jsonb)
  INTO v_name,v_count,v_work,v_rest,v_steps
  FROM public.workouts w LEFT JOIN public.workout_exercises we ON we.workout_id=w.id
  LEFT JOIN public.exercises e ON e.id=we.exercise_id WHERE w.id=p_workout_id GROUP BY w.id,w.name;
  IF v_name IS NULL OR btrim(v_name)='' OR v_count=0 THEN RAISE EXCEPTION 'Workout cannot produce a prescription'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_steps) s WHERE
    s->>'workout_exercise_id' IS NULL OR s->>'exercise_id' IS NULL OR s->>'work_ms' IS NULL OR s->>'rest_ms' IS NULL OR
    nullif(btrim(s->>'exercise_name'),'') IS NULL OR
    (s->>'position')::integer < 0 OR (s->>'work_ms')::bigint < 0 OR (s->>'rest_ms')::bigint < 0)
  THEN RAISE EXCEPTION 'Workout contains an invalid prescription step'; END IF;
  IF v_work <> coalesce((SELECT sum((s->>'work_ms')::bigint) FROM jsonb_array_elements(v_steps)s),0)
     OR v_rest <> coalesce((SELECT sum((s->>'rest_ms')::bigint) FROM jsonb_array_elements(v_steps)s),0)
  THEN RAISE EXCEPTION 'Prescription aggregate mismatch'; END IF;
  INSERT INTO public.training_session_prescriptions(session_id,workout_id,workout_name,schema_version,capture_basis,
    prescribed_work_ms,prescribed_rest_ms,prescribed_total_ms,step_count,steps)
  VALUES(p_session_id,p_workout_id,v_name,1,p_basis,v_work,v_rest,v_work+v_rest,v_count,v_steps);
END $$;
REVOKE ALL ON FUNCTION private.capture_training_session_prescription_row(uuid,uuid,text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.capture_training_session_prescription()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN PERFORM private.capture_training_session_prescription_row(NEW.id,NEW.workout_id,'session_created'); RETURN NEW; END $$;
REVOKE ALL ON FUNCTION private.capture_training_session_prescription() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER training_session_capture_prescription AFTER INSERT ON public.training_sessions FOR EACH ROW
EXECUTE FUNCTION private.capture_training_session_prescription();

DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT id,workout_id FROM public.training_sessions ORDER BY id LOOP
  PERFORM private.capture_training_session_prescription_row(r.id,r.workout_id,'legacy_backfill');
 END LOOP;
END $$;

COMMIT;
