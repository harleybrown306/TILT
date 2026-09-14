-- Rollback-only integration assertions for the existing development fixture.
-- Requires the current coach/athlete/admin IDs and two-team fixture below.
-- Run as postgres in a dedicated SQL session; on unexpected error, ROLLBACK.
BEGIN;
CREATE TEMP TABLE telemetry_validation(check_name text, passed boolean);
DO $test$
DECLARE
 coach uuid:='d2f8d6b0-1acb-4ce5-a393-2a5dec353fb2';
 athlete uuid:='7a102cdc-dc11-4b97-9238-e472c3ffae1d';
 admin uuid:='3b45314a-5066-479d-bf27-d9f4b4b680da';
 pid uuid; tid uuid; sid uuid; aid uuid:=gen_random_uuid(); stepid uuid; otherstep uuid; position integer;
 eid uuid:=gen_random_uuid(); attempt uuid:=gen_random_uuid(); u uuid; denied boolean; n integer;
 patch jsonb; base jsonb; snapshot text; actual text; request_sql text; expected_s uuid[]; actual_s uuid[];
BEGIN
 SELECT p.id,m.team_id INTO pid,tid FROM public.training_plans p JOIN public.team_memberships m ON m.user_id=p.owner_user_id AND m.role='coach' WHERE p.kind='coach' AND p.status='active' AND p.owner_user_id=coach LIMIT 1;
 PERFORM set_config('request.jwt.claim.sub',coach::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
 INSERT INTO public.training_plan_assignments(id,training_plan_id,team_id,athlete_user_id,assigned_by_user_id,start_date) VALUES(aid,pid,tid,athlete,coach,current_date);
 EXECUTE 'RESET ROLE';
 SELECT id INTO sid FROM public.training_sessions WHERE assignment_id=aid LIMIT 1;
 SELECT id,we.position INTO stepid,position FROM public.workout_exercises we WHERE workout_id=(SELECT workout_id FROM public.training_sessions WHERE id=sid) LIMIT 1;
 SELECT id INTO otherstep FROM public.workout_exercises WHERE workout_id<>(SELECT workout_id FROM public.training_sessions WHERE id=sid) LIMIT 1;
 IF sid IS NULL OR stepid IS NULL OR otherstep IS NULL THEN RAISE EXCEPTION 'Missing fixtures'; END IF;
 base:=jsonb_build_object('id',eid,'session_id',sid,'attempt_id',attempt,'sequence',0,'event_type','workout_started','phase','ready','elapsed_ms',0,'occurred_at',now());
 request_sql:='INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,workout_exercise_id,step_position,phase,phase_duration_ms,phase_elapsed_ms,elapsed_ms,occurred_at) SELECT id,session_id,attempt_id,sequence,event_type,workout_exercise_id,step_position,phase,phase_duration_ms,phase_elapsed_ms,elapsed_ms,occurred_at FROM jsonb_populate_record(NULL::public.workout_session_events,$1)';
 PERFORM set_config('request.jwt.claim.sub',athlete::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
 EXECUTE request_sql USING base;
 SELECT count(*) INTO n FROM public.workout_session_events WHERE id=eid AND created_at IS NOT NULL;
 IF n<>1 THEN RAISE EXCEPTION 'Own INSERT/SELECT/receipt failed'; END IF;
 EXECUTE request_sql USING base||jsonb_build_object('id',gen_random_uuid(),'sequence',1,'event_type','exercise_started','phase','work','workout_exercise_id',stepid,'step_position',position,'phase_duration_ms',1000,'phase_elapsed_ms',0);
 INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at)
 VALUES(eid,sid,attempt,0,'workout_started','ready',99,now()) ON CONFLICT DO NOTHING;
 EXECUTE 'RESET ROLE';
 SELECT to_jsonb(e)::text INTO snapshot FROM public.workout_session_events e WHERE id=eid;
 PERFORM set_config('request.jwt.claim.sub',athlete::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
 INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at)
 VALUES(gen_random_uuid(),sid,attempt,0,'workout_started','ready',99,now()) ON CONFLICT DO NOTHING;
 denied:=false;
 BEGIN INSERT INTO public.workout_session_events(id,session_id,attempt_id,sequence,event_type,phase,elapsed_ms,occurred_at,created_at) VALUES(gen_random_uuid(),sid,attempt,2,'workout_started','ready',0,now(),now());
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Client receipt override allowed'; END IF;
 denied:=false;
 BEGIN UPDATE public.workout_session_events SET elapsed_ms=99 WHERE id=eid; EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'UPDATE allowed'; END IF;
 denied:=false;
 BEGIN DELETE FROM public.workout_session_events WHERE id=eid; EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'DELETE allowed'; END IF;
 FOREACH patch IN ARRAY ARRAY[
  '{"event_type":"unknown"}'::jsonb,'{"phase":"invalid"}',
  '{"event_type":"exercise_started","phase":"ready"}',
  '{"event_type":"rest_started","phase":"ready"}',
  '{"event_type":"timer_paused","phase":"ready"}',
  '{"event_type":"workout_started","phase":"finished"}',
  '{"event_type":"workout_completed","phase":"ready"}',
  jsonb_build_object('event_type','exercise_started','phase','work','workout_exercise_id',stepid,'step_position',position,'phase_duration_ms',1000,'phase_elapsed_ms',1001),
  jsonb_build_object('workout_exercise_id',stepid)
 ] LOOP
  denied:=false;
  BEGIN EXECUTE request_sql USING base||patch||jsonb_build_object('id',gen_random_uuid(),'sequence',2);
  EXCEPTION WHEN check_violation OR insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Invalid structure accepted %',patch; END IF;
 END LOOP;
 FOREACH patch IN ARRAY ARRAY[
  jsonb_build_object('workout_exercise_id',stepid,'step_position',position+999),
  jsonb_build_object('workout_exercise_id',otherstep,'step_position',0),
  '{"event_type":"workout_completed","phase":"finished"}'::jsonb
 ] LOOP
  denied:=false;
  BEGIN EXECUTE request_sql USING base||patch||jsonb_build_object('id',gen_random_uuid(),'sequence',2);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Invalid authorized context accepted'; END IF;
 END LOOP;
 EXECUTE 'RESET ROLE';
 SELECT to_jsonb(e)::text INTO actual FROM public.workout_session_events e WHERE id=eid;
 IF actual IS DISTINCT FROM snapshot OR (SELECT count(*) FROM public.workout_session_events WHERE session_id=sid)<>2 THEN RAISE EXCEPTION 'Retry mutated event'; END IF;
 INSERT INTO telemetry_validation VALUES('own INSERT/SELECT; valid step; receipt controlled; duplicate UUID/key immutable',true),('UPDATE/DELETE denied; structural and step/completion checks reject invalid events',true);

 FOREACH u IN ARRAY ARRAY[coach,admin] LOOP
  PERFORM set_config('request.jwt.claim.sub',u::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n FROM public.workout_session_events WHERE id=eid;
  IF n<>1 THEN RAISE EXCEPTION 'Coach/admin SELECT failed'; END IF;
  denied:=false;
  BEGIN EXECUTE request_sql USING base||jsonb_build_object('id',gen_random_uuid(),'sequence',2);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Non-athlete write allowed'; END IF;
  EXECUTE 'RESET ROLE';
 END LOOP;
 UPDATE public.team_memberships SET role='assistant_coach' WHERE user_id=coach AND team_id=tid;
 PERFORM set_config('request.jwt.claim.sub',coach::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
 SELECT count(*) INTO n FROM public.workout_session_events WHERE id=eid;
 IF n<>1 THEN RAISE EXCEPTION 'Assistant read failed'; END IF;
 denied:=false;
 BEGIN EXECUTE request_sql USING base||jsonb_build_object('id',gen_random_uuid(),'sequence',2); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Assistant write allowed'; END IF;
 EXECUTE 'RESET ROLE';
 DELETE FROM public.team_memberships WHERE user_id=coach AND team_id=tid;
 PERFORM set_config('request.jwt.claim.sub',coach::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
 SELECT count(*) INTO n FROM public.workout_session_events WHERE id=eid;
 IF n<>0 THEN RAISE EXCEPTION 'Unrelated coach reads'; END IF;
 denied:=false;
 BEGIN EXECUTE request_sql USING base||jsonb_build_object('id',gen_random_uuid(),'sequence',2); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Another user writes athlete event'; END IF;
 EXECUTE 'RESET ROLE';
 INSERT INTO telemetry_validation VALUES('coach/assistant/admin reads; only assigned athlete writes; unrelated coach denied',true);
 INSERT INTO public.team_memberships(team_id,user_id,role,created_by_user_id) VALUES(tid,coach,'coach',coach);
 UPDATE public.team_memberships SET role='athlete' WHERE user_id=coach;
 PERFORM set_config('request.jwt.claim.sub',coach::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
 denied:=false;
 BEGIN EXECUTE request_sql USING base||jsonb_build_object('id',gen_random_uuid(),'sequence',2); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Another athlete writes'; END IF;
 EXECUTE 'RESET ROLE';
 UPDATE public.team_memberships SET role='coach' WHERE user_id=coach;
 INSERT INTO telemetry_validation VALUES('another athlete cannot write assigned athlete telemetry',true);
 BEGIN DELETE FROM public.training_sessions WHERE id=sid; RAISE EXCEPTION 'Telemetry session deleted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 INSERT INTO telemetry_validation VALUES('telemetry protects parent session deletion before result exists',true);

 PERFORM set_config('request.jwt.claim.sub',athlete::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
 INSERT INTO public.workout_results(training_session_id,athlete_user_id,started_at,completed_at,active_minutes,total_duration_minutes,exercises_completed,result_data) VALUES(sid,athlete,now(),now(),0,0,1,'{}');
 EXECUTE request_sql USING base||jsonb_build_object('id',gen_random_uuid(),'sequence',2,'event_type','workout_completed','phase','finished');
 SELECT count(*) INTO n FROM public.training_sessions WHERE id=sid AND status='completed';
 IF n<>1 THEN RAISE EXCEPTION 'Canonical completion failed'; END IF;
 EXECUTE 'RESET ROLE';
 INSERT INTO telemetry_validation VALUES('result INSERT completes generated session; completion event allowed afterward',true);
 FOREACH u IN ARRAY ARRAY[athlete,coach,admin] LOOP
  SELECT array_agg(id ORDER BY id) INTO expected_s FROM public.training_sessions WHERE athlete_user_id=u OR private.is_team_coach(team_id,u) OR private.is_admin(u);
  PERFORM set_config('request.jwt.claim.sub',u::text,true); EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT array_agg(id ORDER BY id) INTO actual_s FROM public.training_sessions;
  IF actual_s IS DISTINCT FROM expected_s THEN RAISE EXCEPTION 'Session visibility changed'; END IF;
  EXECUTE 'RESET ROLE';
 END LOOP;
 IF has_table_privilege('authenticated','public.workout_session_events','TRUNCATE') OR has_table_privilege('anon','public.workout_session_events','TRUNCATE') THEN RAISE EXCEPTION 'TRUNCATE granted'; END IF;
 INSERT INTO telemetry_validation VALUES('existing session SELECT/multi-team predicates unchanged; no ordinary TRUNCATE',true);
END;
$test$;
SELECT * FROM telemetry_validation;
ROLLBACK;
