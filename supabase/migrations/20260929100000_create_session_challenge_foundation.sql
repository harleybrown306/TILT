BEGIN;

ALTER TABLE public.training_plan_items
  ADD COLUMN challenge_workout_id uuid REFERENCES public.workouts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT training_plan_items_challenge_distinct CHECK (challenge_workout_id IS NULL OR challenge_workout_id IS DISTINCT FROM workout_id);
CREATE INDEX training_plan_items_challenge_workout_id_idx ON public.training_plan_items(challenge_workout_id) WHERE challenge_workout_id IS NOT NULL;

CREATE FUNCTION private.validate_training_plan_item_challenge() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_owner uuid; v_actor uuid := (SELECT auth.uid());
BEGIN
  IF NEW.challenge_workout_id IS NULL THEN RETURN NEW; END IF;
  SELECT owner_user_id INTO v_owner FROM public.training_plans WHERE id=NEW.training_plan_id;
  IF v_owner IS NULL OR v_actor IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.workouts AS workout WHERE workout.id=NEW.challenge_workout_id AND private.can_view_content(workout.visibility,workout.owner_user_id,workout.team_id,v_owner))
     OR NOT EXISTS (SELECT 1 FROM public.workouts AS workout WHERE workout.id=NEW.challenge_workout_id AND private.can_view_content(workout.visibility,workout.owner_user_id,workout.team_id,v_actor))
  THEN RAISE EXCEPTION 'Challenge workout is unavailable to this plan'; END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.validate_training_plan_item_challenge() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER training_plan_items_validate_challenge BEFORE INSERT OR UPDATE OF challenge_workout_id, training_plan_id ON public.training_plan_items FOR EACH ROW EXECUTE FUNCTION private.validate_training_plan_item_challenge();

-- The assignment generator is the authoritative plan-item snapshot boundary.
-- FOR SHARE conflicts with the ordinary UPDATE row lock, so an edit cannot
-- land between its assigned-workout read and either session prescription trigger.
CREATE OR REPLACE FUNCTION private.generate_sessions_for_assignment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
BEGIN
  INSERT INTO public.training_sessions (assignment_id,plan_item_id,athlete_id,athlete_user_id,coach_user_id,team_id,workout_id,scheduled_date,scheduled_time,status)
  SELECT NEW.id,item.id,NEW.athlete_id,NEW.athlete_user_id,NEW.assigned_by_user_id,NEW.team_id,item.workout_id,NEW.start_date+item.day_offset,item.scheduled_time,'scheduled'::public.training_session_status
  FROM (SELECT * FROM public.training_plan_items WHERE training_plan_id=NEW.training_plan_id FOR SHARE) AS item
  ORDER BY item.day_offset,item.position;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.generate_sessions_for_assignment() FROM PUBLIC,anon,authenticated;

CREATE TYPE public.training_session_performed_variant AS ENUM ('assigned','challenge');
CREATE TABLE public.training_session_challenge_prescriptions (
 session_id uuid PRIMARY KEY REFERENCES public.training_sessions(id) ON DELETE RESTRICT,
 source_workout_id uuid NOT NULL, workout_name text NOT NULL CHECK(char_length(btrim(workout_name))>0), schema_version smallint NOT NULL DEFAULT 1 CHECK(schema_version=1), captured_at timestamptz NOT NULL DEFAULT clock_timestamp(), capture_basis text NOT NULL CHECK(capture_basis='session_created'), prescribed_work_ms bigint NOT NULL CHECK(prescribed_work_ms>=0), prescribed_rest_ms bigint NOT NULL CHECK(prescribed_rest_ms>=0), prescribed_total_ms bigint NOT NULL CHECK(prescribed_total_ms=prescribed_work_ms+prescribed_rest_ms), step_count integer NOT NULL CHECK(step_count>0), steps jsonb NOT NULL CHECK(jsonb_typeof(steps)='array' AND jsonb_array_length(steps)=step_count)
);
CREATE TABLE public.training_session_performed_variants (
 session_id uuid PRIMARY KEY REFERENCES public.training_sessions(id) ON DELETE RESTRICT, selected_variant public.training_session_performed_variant NOT NULL DEFAULT 'assigned', selected_at timestamptz, selected_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT, CHECK((selected_at IS NULL)=(selected_by_profile_id IS NULL))
);
CREATE TABLE public.training_session_variant_selection_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL REFERENCES public.training_sessions(id) ON DELETE RESTRICT, selected_variant public.training_session_performed_variant NOT NULL, selected_at timestamptz NOT NULL DEFAULT clock_timestamp(), selected_by_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT
);
CREATE INDEX training_session_variant_selection_audit_session_idx ON public.training_session_variant_selection_audit(session_id,selected_at);

ALTER TABLE public.training_session_challenge_prescriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_session_performed_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_session_variant_selection_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.training_session_challenge_prescriptions, public.training_session_performed_variants, public.training_session_variant_selection_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.training_session_challenge_prescriptions, public.training_session_performed_variants, public.training_session_variant_selection_audit TO authenticated;
CREATE FUNCTION private.can_view_challenge_session(p_session_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
 SELECT EXISTS(SELECT 1 FROM public.training_sessions AS session WHERE session.id=p_session_id AND (session.athlete_user_id=(SELECT auth.uid()) OR (session.athlete_id IS NOT NULL AND private.can_view_athlete(session.athlete_id)) OR private.is_team_coach(session.team_id,(SELECT auth.uid())) OR private.is_admin((SELECT auth.uid()))));
$function$;
REVOKE ALL ON FUNCTION private.can_view_challenge_session(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.can_view_challenge_session(uuid) TO authenticated;
CREATE POLICY training_session_challenge_prescriptions_select ON public.training_session_challenge_prescriptions FOR SELECT TO authenticated USING (private.can_view_challenge_session(session_id));
CREATE POLICY training_session_performed_variants_select ON public.training_session_performed_variants FOR SELECT TO authenticated USING (private.can_view_challenge_session(session_id));
CREATE POLICY training_session_variant_selection_audit_select ON public.training_session_variant_selection_audit FOR SELECT TO authenticated USING (private.can_view_challenge_session(session_id));

CREATE FUNCTION private.capture_training_session_challenge_prescription_row(p_session_id uuid,p_workout_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_name text; v_steps jsonb; v_count integer; v_work bigint; v_rest bigint;
BEGIN
 SELECT workout.name,count(item.id)::integer,coalesce(sum(item.duration_seconds::bigint*1000),0),coalesce(sum(item.rest_seconds::bigint*1000),0),coalesce(jsonb_agg(jsonb_build_object('workout_exercise_id',item.id,'exercise_id',item.exercise_id,'exercise_name',coalesce(nullif(btrim(item.exercise_snapshot->>'exercise_name'),''),nullif(btrim(exercise.name),'')),'position',item.position,'work_ms',item.duration_seconds::bigint*1000,'rest_ms',item.rest_seconds::bigint*1000,'off_hand',item.off_hand,'notes',item.notes) ORDER BY item.position,item.id) FILTER(WHERE item.id IS NOT NULL),'[]'::jsonb) INTO v_name,v_count,v_work,v_rest,v_steps FROM public.workouts AS workout LEFT JOIN public.workout_exercises AS item ON item.workout_id=workout.id LEFT JOIN public.exercises AS exercise ON exercise.id=item.exercise_id WHERE workout.id=p_workout_id GROUP BY workout.id,workout.name;
 IF v_name IS NULL OR btrim(v_name)='' OR v_count=0 THEN RAISE EXCEPTION 'Challenge workout cannot produce a prescription'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_steps) AS step WHERE step->>'workout_exercise_id' IS NULL OR step->>'exercise_id' IS NULL OR step->>'work_ms' IS NULL OR step->>'rest_ms' IS NULL OR nullif(btrim(step->>'exercise_name'),'') IS NULL OR (step->>'position')::integer<0 OR (step->>'work_ms')::bigint<0 OR (step->>'rest_ms')::bigint<0) THEN RAISE EXCEPTION 'Challenge workout contains an invalid prescription step'; END IF;
 INSERT INTO public.training_session_challenge_prescriptions(session_id,source_workout_id,workout_name,schema_version,capture_basis,prescribed_work_ms,prescribed_rest_ms,prescribed_total_ms,step_count,steps) VALUES(p_session_id,p_workout_id,v_name,1,'session_created',v_work,v_rest,v_work+v_rest,v_count,v_steps);
END;
$function$;
REVOKE ALL ON FUNCTION private.capture_training_session_challenge_prescription_row(uuid,uuid) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION private.capture_training_session_challenge_prescription() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_challenge uuid;
BEGIN SELECT challenge_workout_id INTO v_challenge FROM public.training_plan_items WHERE id=NEW.plan_item_id FOR SHARE; IF v_challenge IS NOT NULL THEN PERFORM private.capture_training_session_challenge_prescription_row(NEW.id,v_challenge); END IF; RETURN NEW; END;
$function$;
REVOKE ALL ON FUNCTION private.capture_training_session_challenge_prescription() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER training_session_capture_challenge_prescription AFTER INSERT ON public.training_sessions FOR EACH ROW EXECUTE FUNCTION private.capture_training_session_challenge_prescription();

-- Events are the first durable execution state and must serialize with variant
-- selection on the same session row. Challenge execution is intentionally
-- unavailable until Phase 18B.
CREATE FUNCTION private.reject_challenge_workout_session_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_variant public.training_session_performed_variant;
BEGIN
 PERFORM 1 FROM public.training_sessions WHERE id=NEW.session_id FOR UPDATE;
 SELECT selected_variant INTO v_variant FROM public.training_session_performed_variants WHERE session_id=NEW.session_id FOR UPDATE;
 IF v_variant='challenge' THEN RAISE EXCEPTION 'Challenge execution is not available'; END IF;
 RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.reject_challenge_workout_session_event() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER workout_session_events_reject_challenge_execution BEFORE INSERT ON public.workout_session_events FOR EACH ROW EXECUTE FUNCTION private.reject_challenge_workout_session_event();

-- Canonical completion creates a workout_result after locking its session.
-- Keep Phase 18A Challenge selection non-completable at that same boundary.
CREATE FUNCTION private.reject_challenge_workout_result() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_variant public.training_session_performed_variant;
BEGIN
 PERFORM 1 FROM public.training_sessions WHERE id=NEW.training_session_id FOR UPDATE;
 SELECT selected_variant INTO v_variant FROM public.training_session_performed_variants WHERE session_id=NEW.training_session_id FOR UPDATE;
 IF v_variant='challenge' THEN RAISE EXCEPTION 'Challenge completion is not available'; END IF;
 RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.reject_challenge_workout_result() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER workout_results_reject_challenge_completion BEFORE INSERT ON public.workout_results FOR EACH ROW EXECUTE FUNCTION private.reject_challenge_workout_result();

-- Coaches and administrators retain their established authenticated session
-- management UPDATE path.  Its completed-state or completion-timestamp transition must nevertheless
-- honor the same Phase 18A Challenge boundary as canonical result insertion.
-- PostgreSQL has already locked the updated session row before this BEFORE
-- trigger runs, so selection (which locks that row first) cannot change the
-- performed variant between this check and the transition.  The function is
-- intentionally SECURITY INVOKER: RLS remains authoritative for the direct
-- UPDATE, and the trigger has no separately callable privilege surface.
CREATE FUNCTION private.reject_challenge_training_session_completion() RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $function$
DECLARE v_variant public.training_session_performed_variant;
BEGIN
 SELECT selected_variant INTO v_variant FROM public.training_session_performed_variants WHERE session_id=NEW.id;
 IF v_variant='challenge' THEN RAISE EXCEPTION 'Challenge completion is not available'; END IF;
 RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.reject_challenge_training_session_completion() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER training_sessions_reject_challenge_completion BEFORE UPDATE OF status,completed_at ON public.training_sessions FOR EACH ROW WHEN ((OLD.status IS DISTINCT FROM 'completed'::public.training_session_status AND NEW.status='completed'::public.training_session_status) OR (OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL)) EXECUTE FUNCTION private.reject_challenge_training_session_completion();

CREATE FUNCTION public.select_my_training_session_variant(p_session_id uuid,p_variant public.training_session_performed_variant) RETURNS public.training_session_performed_variant LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_actor uuid:=(SELECT auth.uid()); v_session public.training_sessions; v_current public.training_session_performed_variants;
BEGIN
 IF v_actor IS NULL OR p_session_id IS NULL OR p_variant IS NULL THEN RAISE EXCEPTION 'Authentication, session, and variant are required'; END IF;
 SELECT * INTO v_session FROM public.training_sessions AS session WHERE session.id=p_session_id FOR UPDATE;
 IF NOT FOUND OR v_session.athlete_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.athlete_profile_relationships AS relationship WHERE relationship.athlete_id=v_session.athlete_id AND relationship.profile_id=v_actor AND relationship.role='self' AND relationship.revoked_at IS NULL) THEN RAISE EXCEPTION 'Challenge selection is unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM public.workout_session_attempts AS attempt WHERE attempt.training_session_id=v_session.id) OR EXISTS(SELECT 1 FROM public.workout_session_events AS event WHERE event.session_id=v_session.id) OR EXISTS(SELECT 1 FROM public.workout_results AS result WHERE result.training_session_id=v_session.id) OR v_session.status='completed'::public.training_session_status OR v_session.completed_at IS NOT NULL THEN RAISE EXCEPTION 'Challenge selection is locked after workout start'; END IF;
 IF p_variant='challenge' AND NOT EXISTS(SELECT 1 FROM public.training_session_challenge_prescriptions AS option WHERE option.session_id=v_session.id) THEN RAISE EXCEPTION 'Challenge option is unavailable'; END IF;
 SELECT * INTO v_current FROM public.training_session_performed_variants WHERE session_id=v_session.id FOR UPDATE;
 IF FOUND AND v_current.selected_variant=p_variant THEN RETURN p_variant; END IF;
 INSERT INTO public.training_session_performed_variants(session_id,selected_variant,selected_at,selected_by_profile_id) VALUES(v_session.id,p_variant,clock_timestamp(),v_actor) ON CONFLICT(session_id) DO UPDATE SET selected_variant=EXCLUDED.selected_variant,selected_at=EXCLUDED.selected_at,selected_by_profile_id=EXCLUDED.selected_by_profile_id;
 INSERT INTO public.training_session_variant_selection_audit(session_id,selected_variant,selected_by_profile_id) VALUES(v_session.id,p_variant,v_actor);
 RETURN p_variant;
END;
$function$;
REVOKE ALL ON FUNCTION public.select_my_training_session_variant(uuid,public.training_session_performed_variant) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.select_my_training_session_variant(uuid,public.training_session_performed_variant) TO authenticated;

CREATE OR REPLACE FUNCTION private.register_workout_session_attempt_from_event(p_attempt_id uuid,p_session_id uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_actor uuid:=(SELECT auth.uid()); v_started timestamptz; v_existing public.workout_session_attempts; v_session public.training_sessions; v_prescription public.training_session_prescriptions;
BEGIN
 SELECT * INTO v_session FROM public.training_sessions AS session WHERE session.id=p_session_id FOR UPDATE;
 IF v_actor IS NULL OR NOT FOUND OR v_session.athlete_id IS NULL OR NOT private.can_act_for_training_session(v_session.id) THEN RAISE EXCEPTION 'Attempt session unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM public.training_session_performed_variants AS variant WHERE variant.session_id=v_session.id AND variant.selected_variant='challenge') THEN RAISE EXCEPTION 'Challenge execution is not available'; END IF;
 SELECT occurred_at INTO v_started FROM public.workout_session_events WHERE session_id=p_session_id AND attempt_id=p_attempt_id AND event_type='workout_started' AND sequence=0 AND phase='ready' AND workout_exercise_id IS NULL AND step_position IS NULL AND phase_duration_ms IS NULL AND phase_elapsed_ms IS NULL;
 IF NOT FOUND OR (SELECT count(*) FROM public.workout_session_events WHERE session_id=p_session_id AND attempt_id=p_attempt_id AND event_type='workout_started')<>1 THEN RAISE EXCEPTION 'Attempt start event unavailable'; END IF;
 SELECT * INTO v_existing FROM public.workout_session_attempts WHERE id=p_attempt_id;
 IF FOUND THEN IF v_existing.training_session_id IS DISTINCT FROM p_session_id OR v_existing.athlete_id IS DISTINCT FROM v_session.athlete_id OR v_existing.athlete_user_id IS DISTINCT FROM v_session.athlete_user_id THEN RAISE EXCEPTION 'Attempt identity conflict'; END IF; RETURN p_attempt_id; END IF;
 SELECT * INTO v_prescription FROM public.training_session_prescriptions WHERE session_id=p_session_id; IF NOT FOUND THEN RAISE EXCEPTION 'Attempt prescription unavailable'; END IF;
 INSERT INTO public.workout_session_attempts(id,training_session_id,athlete_id,athlete_user_id,started_at,prescription_schema_version,prescribed_work_ms,prescribed_rest_ms,prescribed_total_ms,prescribed_step_count) VALUES(p_attempt_id,p_session_id,v_session.athlete_id,v_session.athlete_user_id,v_started,v_prescription.schema_version,v_prescription.prescribed_work_ms,v_prescription.prescribed_rest_ms,v_prescription.prescribed_total_ms,v_prescription.step_count);
 RETURN p_attempt_id;
END;
$function$;
REVOKE ALL ON FUNCTION private.register_workout_session_attempt_from_event(uuid,uuid) FROM PUBLIC,anon,authenticated;
COMMIT;
