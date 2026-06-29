-- Per-user credit ledger for the beta.
--
-- OWNER + ADMINS ARE UNLIMITED (unlimited = true) — they are NEVER debited,
-- never balance-checked, never daily-capped, never blocked. ONLY non-admin beta
-- users get a fixed grant + hard caps so they cannot drain the API budget.
-- The exemption is keyed on BOTH the owner email AND the 'admin' role, and the
-- edge function adds a has_role fallback, so the owner can never be locked out.

CREATE TABLE IF NOT EXISTS public.user_credits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance_micro_usd      bigint NOT NULL DEFAULT 500000,  -- $0.50 free beta grant
  spent_micro_usd        bigint NOT NULL DEFAULT 0,
  daily_spent_micro_usd  bigint NOT NULL DEFAULT 0,
  daily_window_start     timestamptz NOT NULL DEFAULT now(),
  unlimited              boolean NOT NULL DEFAULT false,   -- owner/admin: no limits
  blocked                boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_credits ENABLE ROW LEVEL SECURITY;

-- Users may READ their own balance. ALL writes go through the service-role RPC
-- below — there is intentionally NO authenticated INSERT/UPDATE/DELETE policy,
-- so a user can never grant themselves credits or clear `blocked`.
DROP POLICY IF EXISTS "Users view own credits" ON public.user_credits;
CREATE POLICY "Users view own credits"
  ON public.user_credits FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

GRANT SELECT ON public.user_credits TO authenticated;
GRANT ALL ON public.user_credits TO service_role;

-- Owner accounts (both of JD's logins) — always unlimited.
-- Backfill every existing user. Admins + owner emails start unlimited;
-- everyone else gets the default grant.
INSERT INTO public.user_credits (user_id, unlimited)
SELECT u.id,
       (public.has_role(u.id, 'admin')
        OR lower(u.email) IN ('justindean785@gmail.com', 'jd@dizosint.co.site'))
FROM auth.users u
ON CONFLICT (user_id) DO NOTHING;

-- Force unlimited for owner accounts + any admin even if a row already existed.
UPDATE public.user_credits c
SET unlimited = true, updated_at = now()
WHERE public.has_role(c.user_id, 'admin')
   OR c.user_id IN (
     SELECT id FROM auth.users
     WHERE lower(email) IN ('justindean785@gmail.com', 'jd@dizosint.co.site')
   );

-- Seed a credit row for every NEW signup (separate trigger so handle_new_user is
-- untouched). A signup that is already an admin starts unlimited; beta users get
-- the default grant.
CREATE OR REPLACE FUNCTION public.seed_user_credits()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.user_credits (user_id, unlimited)
  VALUES (
    NEW.id,
    (public.has_role(NEW.id, 'admin') OR lower(COALESCE(NEW.email,'')) = lower('justindean785@gmail.com'))
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END; $$;
REVOKE EXECUTE ON FUNCTION public.seed_user_credits() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created_credits ON auth.users;
CREATE TRIGGER on_auth_user_created_credits
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.seed_user_credits();

-- Atomic, race-safe pre-check + debit. UNLIMITED users are never debited/blocked.
-- A negative/zero amount (free/cached/failed call) never debits. A missing row is
-- lazily seeded and treated as free so bookkeeping can never hard-fail a run.
-- service_role only.
CREATE OR REPLACE FUNCTION public.debit_user_credits(
  _user_id uuid,
  _amount_micro_usd bigint,
  _daily_cap_micro_usd bigint DEFAULT 1000000   -- $1.00/day backstop
) RETURNS TABLE(ok boolean, balance bigint, daily_spent bigint, unlimited boolean, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.user_credits%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.user_credits WHERE user_id = _user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.user_credits (user_id) VALUES (_user_id) ON CONFLICT (user_id) DO NOTHING;
    RETURN QUERY SELECT true, 500000::bigint, 0::bigint, false, 'seeded'; RETURN;
  END IF;
  IF c.unlimited THEN
    RETURN QUERY SELECT true, c.balance_micro_usd, c.daily_spent_micro_usd, true, 'unlimited'; RETURN;
  END IF;
  IF c.daily_window_start < date_trunc('day', now()) THEN
    c.daily_spent_micro_usd := 0; c.daily_window_start := now();
  END IF;
  IF _amount_micro_usd <= 0 THEN
    UPDATE public.user_credits SET
      daily_spent_micro_usd = c.daily_spent_micro_usd,
      daily_window_start = c.daily_window_start, updated_at = now()
    WHERE user_id = _user_id;
    RETURN QUERY SELECT true, c.balance_micro_usd, c.daily_spent_micro_usd, false, 'free'; RETURN;
  END IF;
  IF c.blocked THEN
    RETURN QUERY SELECT false, c.balance_micro_usd, c.daily_spent_micro_usd, false, 'blocked'; RETURN;
  END IF;
  IF c.balance_micro_usd < _amount_micro_usd THEN
    RETURN QUERY SELECT false, c.balance_micro_usd, c.daily_spent_micro_usd, false, 'insufficient_balance'; RETURN;
  END IF;
  IF c.daily_spent_micro_usd + _amount_micro_usd > _daily_cap_micro_usd THEN
    RETURN QUERY SELECT false, c.balance_micro_usd, c.daily_spent_micro_usd, false, 'daily_cap'; RETURN;
  END IF;
  UPDATE public.user_credits SET
    balance_micro_usd     = balance_micro_usd - _amount_micro_usd,
    spent_micro_usd       = spent_micro_usd + _amount_micro_usd,
    daily_spent_micro_usd = c.daily_spent_micro_usd + _amount_micro_usd,
    daily_window_start    = c.daily_window_start,
    updated_at            = now()
  WHERE user_id = _user_id;
  RETURN QUERY SELECT true, c.balance_micro_usd - _amount_micro_usd,
                      c.daily_spent_micro_usd + _amount_micro_usd, false, 'ok';
END; $$;
REVOKE EXECUTE ON FUNCTION public.debit_user_credits(uuid,bigint,bigint) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.debit_user_credits(uuid,bigint,bigint) TO service_role;
