create or replace function private.import_base44_exercises(payload jsonb)
returns integer
language plpgsql
security definer
set search_path=''
as $$
declare affected integer;
begin
  insert into public.exercises(name,category,difficulty,instructions,explanation,video_url,images,skills,skill_spot,skill_context,skill_context_2,grid_code,switch_need,body_tag_1,body_tag_type_1,body_tag_2,body_tag_type_2,visibility,source_system,source_id)
  select x.name,x.category,x.difficulty::public.exercise_difficulty,x.instructions,x.explanation,x.video_url,
    coalesce(array(select jsonb_array_elements_text(coalesce(x.images,'[]'::jsonb))),'{}'::text[]),
    coalesce(array(select jsonb_array_elements_text(coalesce(x.skills,'[]'::jsonb))),'{}'::text[]),
    x.skill_spot,x.skill_context,x.skill_context_2,x.grid_code,coalesce(x.switch_need,false),x.body_tag_1,x.body_tag_type_1,x.body_tag_2,x.body_tag_type_2,
    'public'::public.content_visibility,'base44',x.source_id
  from jsonb_to_recordset(payload) as x(source_id text,name text,category text,difficulty text,instructions text,explanation text,video_url text,images jsonb,skills jsonb,skill_spot text,skill_context text,skill_context_2 text,grid_code text,switch_need boolean,body_tag_1 text,body_tag_type_1 text,body_tag_2 text,body_tag_type_2 text)
  on conflict(source_system,source_id) where source_system is not null and source_id is not null
  do update set name=excluded.name,category=excluded.category,difficulty=excluded.difficulty,instructions=excluded.instructions,explanation=excluded.explanation,video_url=excluded.video_url,images=excluded.images,skills=excluded.skills,skill_spot=excluded.skill_spot,skill_context=excluded.skill_context,skill_context_2=excluded.skill_context_2,grid_code=excluded.grid_code,switch_need=excluded.switch_need,body_tag_1=excluded.body_tag_1,body_tag_type_1=excluded.body_tag_type_1,body_tag_2=excluded.body_tag_2,body_tag_type_2=excluded.body_tag_type_2;
  get diagnostics affected = row_count;
  return affected;
end;
$$;
revoke all on function private.import_base44_exercises(jsonb) from public, anon, authenticated;

create or replace function private.import_base44_workouts(payload jsonb)
returns integer
language plpgsql
security definer
set search_path=''
as $$
declare w jsonb; ex jsonb; workout_uuid uuid; pos integer; affected integer := 0; linked_exercise uuid;
begin
  for w in select value from jsonb_array_elements(payload)
  loop
    insert into public.workouts(name,description,difficulty,image_url,areas,visibility,requires_entitlement,source_system,source_id)
    values (
      w->>'name',w->>'description',coalesce(w->>'difficulty','novice')::public.exercise_difficulty,w->>'image_url',
      coalesce(array(select jsonb_array_elements_text(coalesce(w->'areas','[]'::jsonb))),'{}'::text[]),
      case when coalesce((w->>'is_public')::boolean,false) then 'public'::public.content_visibility else 'private'::public.content_visibility end,
      case when coalesce((w->>'is_premium')::boolean,false) then 'content.premium_workouts' else null end,
      'base44',w->>'id')
    on conflict(source_system,source_id) where source_system is not null and source_id is not null
    do update set name=excluded.name,description=excluded.description,difficulty=excluded.difficulty,image_url=excluded.image_url,areas=excluded.areas,visibility=excluded.visibility,requires_entitlement=excluded.requires_entitlement
    returning id into workout_uuid;

    delete from public.workout_exercises where workout_id=workout_uuid;
    pos := 0;
    for ex in select value from jsonb_array_elements(coalesce(w->'exercises','[]'::jsonb))
    loop
      select id into linked_exercise from public.exercises where source_system='base44' and source_id=ex->>'exercise_id' limit 1;
      insert into public.workout_exercises(workout_id,exercise_id,position,duration_seconds,rest_seconds,off_hand,exercise_snapshot)
      values (workout_uuid,linked_exercise,pos,case when ex ? 'duration' then round((ex->>'duration')::numeric)::integer else null end,case when ex ? 'rest_time' then round((ex->>'rest_time')::numeric)::integer else null end,coalesce((ex->>'off_hand')::boolean,false),ex);
      pos := pos + 1;
    end loop;
    affected := affected + 1;
  end loop;
  return affected;
end;
$$;
revoke all on function private.import_base44_workouts(jsonb) from public, anon, authenticated;
