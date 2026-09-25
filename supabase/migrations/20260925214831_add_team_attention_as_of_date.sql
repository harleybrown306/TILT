BEGIN;

CREATE FUNCTION public.get_team_attention_as_of_date(
  p_team_id uuid
)
RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
BEGIN
  IF v_actor IS NULL
     OR p_team_id IS NULL
     OR NOT private.can_view_team_analytics(p_team_id) THEN
    RAISE EXCEPTION 'Team attention data is not available' USING ERRCODE = '42501';
  END IF;

  RETURN (transaction_timestamp() AT TIME ZONE 'America/Chicago')::date;
END;
$function$;

ALTER FUNCTION public.get_team_attention_as_of_date(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_team_attention_as_of_date(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_team_attention_as_of_date(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_team_attention_as_of_date(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_team_attention_as_of_date(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_team_attention_as_of_date(uuid) IS
  'Authorized Chicago calendar anchor for an empty bounded team attention snapshot.';

COMMIT;
