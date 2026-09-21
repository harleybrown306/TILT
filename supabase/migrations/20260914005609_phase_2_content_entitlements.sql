alter table public.workouts add column requires_entitlement text;
create index workouts_requires_entitlement_idx on public.workouts(requires_entitlement) where requires_entitlement is not null;
insert into public.entitlement_plan_features(plan_id,feature_key,enabled,numeric_limit)
select id,'content.premium_workouts',false,null::integer from public.entitlement_plans where code='free'
on conflict(plan_id,feature_key) do nothing;
comment on column public.workouts.requires_entitlement is 'Optional feature key required to use this workout. Visibility controls who can discover it; entitlement controls whether they can use it.';
