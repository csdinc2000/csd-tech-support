-- Seed first owner user
-- Run AFTER creating the auth user in Supabase dashboard or via the invite flow.
-- Replace the UUID and email below with the actual values from auth.users.

-- Step 1: In Supabase Dashboard → Authentication → Users → "Add user"
--         Email: owner@csd.local  Password: ChangeMe2025!
--         Copy the UUID assigned.

-- Step 2: Run this SQL (replace <AUTH_USER_UUID> with the actual UUID):
/*
UPDATE public.users
SET role = 'owner', full_name = 'CSD Owner'
WHERE id = '<AUTH_USER_UUID>';

-- Verify:
SELECT id, email, role, full_name FROM public.users;
*/

-- ── Quick-seed helper (service-role / dashboard only) ──────────────────────
-- If the trigger already inserted a viewer row, this upgrades it to owner.
-- If no row yet, insert directly (only works when called via service role).
DO $$
DECLARE
  v_email TEXT := 'owner@csd.local';
  v_uid   UUID;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = v_email LIMIT 1;
  IF v_uid IS NOT NULL THEN
    INSERT INTO public.users (id, email, full_name, role)
    VALUES (v_uid, v_email, 'CSD Owner', 'owner')
    ON CONFLICT (id) DO UPDATE SET role = 'owner', full_name = 'CSD Owner';
    RAISE NOTICE 'Owner row set for %', v_email;
  ELSE
    RAISE NOTICE 'Auth user % not found — create them first in the Auth dashboard, then re-run.', v_email;
  END IF;
END $$;
