BEGIN;
CREATE OR REPLACE FUNCTION private.can_view_training_plan(check_plan_id uuid, check_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.training_plans AS tp
    WHERE tp.id = check_plan_id
      AND (
        private.is_admin(check_user_id)
        OR (tp.kind = 'coach'::public.training_plan_kind AND tp.owner_user_id = check_user_id)
        OR (
          tp.kind = 'template'::public.training_plan_kind
          AND tp.visibility = 'public'::public.training_plan_visibility
          AND tp.status = 'active'::public.training_plan_status
        )
      )
  );
$function$;
ALTER POLICY training_plans_select
ON public.training_plans
USING (private.can_view_training_plan(id, (SELECT auth.uid())));
COMMIT;
