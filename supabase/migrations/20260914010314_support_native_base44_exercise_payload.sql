create or replace function private.import_base44_exercises(payload jsonb)
returns integer
language plpgsql
security definer
set search_path=''
as $$
declare x jsonb; affected integer := 0;
begin
  for x in select value from jsonb_array_elements(payload)
  loop
    insert into public.exercises(name,category,difficulty,instructions,explanation,video_url,images,skills,skill_spot,skill_context,skill_context_2,grid_code,switch_need,body_tag_1,body_tag_type_1,body_tag_2,body_tag_type_2,visibility,source_system,source_id)
    values (
      x->>'name',x->>'category',coalesce(x->>'difficulty','novice')::public.exercise_difficulty,x->>'instructions',x->>'explanation',x->>'video_url',
      coalesce(array(select jsonb_array_elements_text(coalesce(x->'images','[]'::jsonb))),'{}'::text[]),
      coalesce(array(select jsonb_array_elements_text(coalesce(x->'skills','[]'::jsonb))),'{}'::text[]),
      x->>'skillSpot',x->>'skillContext',x->>'skillContext2',x->>'gridCode',coalesce((x->>'switchNeed')::boolean,false),x->>'bodyTag1',x->>'bodyTagType1',x->>'bodyTag2',x->>'bodyTagType2',
      'public'::public.content_visibility,'base44',x->>'id')
    on conflict(source_system,source_id) where source_system is not null and source_id is not null
    do update set name=excluded.name,category=excluded.category,difficulty=excluded.difficulty,instructions=excluded.instructions,explanation=excluded.explanation,video_url=excluded.video_url,images=excluded.images,skills=excluded.skills,skill_spot=excluded.skill_spot,skill_context=excluded.skill_context,skill_context_2=excluded.skill_context_2,grid_code=excluded.grid_code,switch_need=excluded.switch_need,body_tag_1=excluded.body_tag_1,body_tag_type_1=excluded.body_tag_type_1,body_tag_2=excluded.body_tag_2,body_tag_type_2=excluded.body_tag_type_2;
    affected := affected + 1;
  end loop;
  return affected;
end;
$$;
revoke all on function private.import_base44_exercises(jsonb) from public, anon, authenticated;
