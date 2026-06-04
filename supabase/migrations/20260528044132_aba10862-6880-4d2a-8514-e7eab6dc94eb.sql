
REVOKE EXECUTE ON FUNCTION public.increment_thread_cost(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_thread_cost(uuid, bigint) TO service_role;
