-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 043: Cumulative service refund semantics
-- ============================================================
--
-- Classification:
-- - Correctness fix to existing refund accounting. Two functions
--   replaced. No table, no column, no index, no constraint, no
--   policy, no grant, and no change to any other RPC.
--
-- THE BUG THIS FIXES
--
-- Stripe's charge.amount_refunded is CUMULATIVE: it reports the
-- total refunded on that charge to date, not the amount of the
-- refund that just happened. Migration 040's refund RPC treated
-- the amount it was given as a DELTA and added it to
-- service_purchases.refunded_amount_minor:
--
--     v_refunded := v_purchase.refunded_amount_minor + v_portion;
--
-- Adding a cumulative figure to a running total is correct exactly
-- once. Concretely, on a 10000 purchase:
--
--   refund 3000                   -> 0 + 3000 = 3000   correct
--   SAME event redelivered        -> 3000 + 3000 = 6000  WRONG
--   refund 2000 (Stripe says 5000)-> 3000 + 5000 = 8000  WRONG,
--                                    and the consultant's ledger
--                                    is over-reversed by 3000 —
--                                    real money taken from them
--                                    that was never refunded
--   refund the rest (Stripe: 10000)
--                                 -> 10000 > 7000 remaining ->
--                                    FINANCE_REFUND_EXCEEDS_PURCHASE
--                                    -> the webhook wrapper reports
--                                    failure -> the event falls
--                                    through -> NO reversal is
--                                    recorded, silently
--
-- A full refund delivered once, and a full refund redelivered, are
-- the only cases that were right: the first sets refunded to the
-- gross, and the second finds nothing remaining and no-ops.
--
-- THE FIX
--
-- The parameter becomes a TARGET rather than a delta:
--
--     p_refunded_total_minor
--       "Stripe reports this purchase has now been refunded by
--        this total amount."
--
-- and the function computes the delta itself:
--
--     delta = target - refunded_amount_minor
--
-- That makes the operation idempotent BY CONSTRUCTION rather than
-- by a guard that happens to catch one case. Stripe's cumulative
-- total is monotonic, so applying the same total twice is a no-op,
-- applying a larger total reverses only the difference, and no
-- ordering of deliveries can produce a wrong figure.
--
-- The parameter is RENAMED, not merely reinterpreted, and the old
-- signature is dropped by name. The types are identical
-- (uuid, text, integer), so a positional caller would silently
-- start passing a delta where a total is expected — renaming means
-- the orchestrator's named-argument calls fail loudly instead.
--
-- What is deliberately unchanged:
-- - The proportional consultant reversal. reverse_ledger_entry
--   (migration 035) still does all the arithmetic, still refuses
--   over-reversal, and still gives a reversal the SAME
--   availability as the entry it reverses — so refunding a pending
--   earning still cannot create available funds.
-- - status moves to 'refunded' only when the cumulative total
--   reaches the gross. A partial refund is still a number, not a
--   status.
-- - A purchase with no earning (unattributed, or a service with no
--   commission rate) still records its refund and creates no
--   ledger entry.
-- - Reversing an already paid-out earning is still permitted and
--   may drive the balance negative, per migration 034.
--
-- Rerun safety:
-- - Idempotent. The old signatures are dropped with IF EXISTS, the
--   new ones are CREATE OR REPLACE at fixed signatures, and
--   REVOKE/GRANT are declarative.
-- ============================================================

begin;

-- ------------------------------------------------------- guard ----

do $$
begin
  if to_regclass('public.service_purchases') is null then
    raise exception
      'migration 043: public.service_purchases not found - migration 034 must be applied first';
  end if;

  if to_regprocedure(
       'public.reverse_ledger_entry(uuid, text, integer)'
     ) is null then
    raise exception
      'migration 043: reverse_ledger_entry not found - migration 035 must be applied first';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'service_purchases'
       and column_name = 'refunded_amount_minor'
  ) then
    raise exception
      'migration 043: service_purchases.refunded_amount_minor not found - migration 040 must be applied first';
  end if;
end;
$$;


-- ============================================================
-- A. The old delta-semantics functions
-- ============================================================
--
-- Dropped rather than replaced. Both keep the signature
-- (uuid, text, integer) and (text, text, integer) respectively, so
-- CREATE OR REPLACE alone would silently change the MEANING of the
-- third argument while every existing call still compiled. The
-- drop plus the renamed parameter is what turns a silent
-- reinterpretation into a loud failure.

drop function if exists
  public.reverse_service_purchase_earning(uuid, text, integer);

drop function if exists
  public.reverse_service_purchase_for_payment_intent(
    text, text, integer);


-- ============================================================
-- B. reverse_service_purchase_earning, cumulative
-- ============================================================

create or replace function public.reverse_service_purchase_earning(
  p_purchase_id uuid,
  p_reason text,
  p_refunded_total_minor integer default null
)
returns table (
  purchase_id uuid,
  reversed boolean,
  reason text,
  entry_id uuid,
  reversal_entry_id uuid,
  refunded_amount_minor integer,
  status text,
  consultant_amount_minor integer,
  applied_delta_minor integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_purchase public.service_purchases%rowtype;
  v_entry public.consultant_ledger_entries%rowtype;
  /*
   * Scalars rather than a record. A plpgsql record that is never
   * assigned raises "record is not assigned yet" the moment any
   * field of it is READ — so on the legitimate path where a
   * purchase has no earning to reverse, building the result row
   * would have failed. Migration 040 carried the same latent
   * fault; it was simply never reached, because no test refunded
   * an unattributed purchase until now.
   */
  v_reversal_entry_id uuid;
  v_reversal_consultant_minor integer;
  v_target integer;
  v_delta integer;
  v_refunded integer;
  v_status text;
  v_now timestamptz := now();
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception
      'FINANCE_REASON_REQUIRED: a reversal must state a reason';
  end if;

  select * into v_purchase
    from public.service_purchases
   where id = p_purchase_id
   for update;

  if not found then
    raise exception
      'FINANCE_PURCHASE_NOT_FOUND: service purchase % does not exist',
      p_purchase_id;
  end if;

  /*
   * Null means "refund everything that is left". The only caller
   * that omits the total is an operator asking for a full reversal
   * directly; the webhook always supplies Stripe's figure.
   */
  v_target := coalesce(
    p_refunded_total_minor,
    v_purchase.gross_amount_minor
  );

  /*
   * A target above the gross cannot come from Stripe — a charge
   * cannot be refunded for more than it took — so it means
   * something upstream is wrong and is refused rather than
   * clamped. Clamping would record a plausible number and hide the
   * fault.
   */
  if v_target > v_purchase.gross_amount_minor then
    raise exception
      'FINANCE_REFUND_EXCEEDS_PURCHASE: a refunded total of % exceeds the % gross of purchase %',
      v_target, v_purchase.gross_amount_minor, p_purchase_id;
  end if;

  if v_target < 0 then
    raise exception
      'FINANCE_REVERSAL_AMOUNT_INVALID: a refunded total may not be negative';
  end if;

  v_delta := v_target - v_purchase.refunded_amount_minor;

  /*
   * THE IDEMPOTENCY, and it is arithmetic rather than a guard.
   *
   * A redelivered event carries the same cumulative total, so the
   * delta is zero and nothing happens. An out-of-order delivery
   * carrying an older, smaller total is negative and is likewise
   * ignored — the larger total already applied is the truth.
   *
   * Reported honestly: 'already_refunded' when the purchase is
   * fully refunded, 'no_change' when this particular total adds
   * nothing, so a caller can tell the two apart.
   */
  if v_delta <= 0 then
    return query
    select v_purchase.id, false,
           case
             when v_purchase.refunded_amount_minor
                  >= v_purchase.gross_amount_minor
               then 'already_refunded'::text
             else 'no_change'::text
           end,
           null::uuid, null::uuid,
           v_purchase.refunded_amount_minor,
           v_purchase.status, null::integer, 0;
    return;
  end if;

  select * into v_entry
    from public.consultant_ledger_entries
   where entry_type = 'earning'
     and source_type = 'service_purchase'
     and source_id = v_purchase.id
     and source_component = 'full';

  /*
   * Only the DELTA is reversed, never the target. The consultant's
   * share of the newly refunded portion is computed by
   * reverse_ledger_entry at the entry's own commission rate, so
   * three partial refunds reverse exactly what three partial
   * refunds should.
   */
  if v_entry.id is not null then
    select r.entry_id, r.consultant_amount_minor
      into v_reversal_entry_id, v_reversal_consultant_minor
      from public.reverse_ledger_entry(
        v_entry.id, p_reason, v_delta
      ) r;
  end if;

  v_refunded := v_target;

  v_status := case
                when v_refunded >= v_purchase.gross_amount_minor
                  then 'refunded'
                else v_purchase.status
              end;

  update public.service_purchases
     set refunded_amount_minor = v_refunded,
         status = v_status,
         refunded_at = case
                         when v_status = 'refunded'
                           then coalesce(refunded_at, v_now)
                         else refunded_at
                       end
   where id = v_purchase.id
  returning * into v_purchase;

  return query
  select v_purchase.id,
         v_entry.id is not null,
         case when v_entry.id is null
                then 'no_entry'::text
              else 'reversed'::text
         end,
         v_entry.id,
         v_reversal_entry_id,
         v_purchase.refunded_amount_minor,
         v_purchase.status,
         v_reversal_consultant_minor,
         v_delta;
end;
$$;

comment on function public.reverse_service_purchase_earning(
  uuid, text, integer) is
  'Migration 043 (was migration 040). Applies a CUMULATIVE refund '
  'total to a service purchase: p_refunded_total_minor is what '
  'Stripe says has been refunded in total, not the amount of one '
  'refund. The delta against refunded_amount_minor is computed '
  'here and only that delta is reversed in the ledger, so a '
  'redelivered event is a no-op, a second partial reverses only '
  'the difference, and no ordering of deliveries can double-count. '
  'status moves to ''refunded'' only when the total reaches the '
  'gross. Never mutates the original earning; a reversal inherits '
  'the availability of what it reverses.';


-- ============================================================
-- C. reverse_service_purchase_for_payment_intent, cumulative
-- ============================================================
--
-- The webhook's entry point, unchanged in purpose: find the
-- purchase from the PaymentIntent behind a refunded charge so the
-- webhook never reads a finance table (Amendment 004 section
-- 10.3.3). Only the amount's meaning changes, and the parameter
-- name changes with it.

create or replace function
  public.reverse_service_purchase_for_payment_intent(
  p_stripe_payment_intent_id text,
  p_reason text,
  p_refunded_total_minor integer default null
)
returns table (
  purchase_id uuid,
  reversed boolean,
  reason text,
  entry_id uuid,
  reversal_entry_id uuid,
  refunded_amount_minor integer,
  status text,
  consultant_amount_minor integer,
  applied_delta_minor integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_purchase_id uuid;
begin
  if p_stripe_payment_intent_id is null
     or btrim(p_stripe_payment_intent_id) = '' then
    return query
    select null::uuid, false, 'not_a_service_purchase'::text,
           null::uuid, null::uuid, null::integer, null::text,
           null::integer, null::integer;
    return;
  end if;

  select sp.id into v_purchase_id
    from public.service_purchases sp
   where sp.stripe_payment_intent_id
         = btrim(p_stripe_payment_intent_id);

  if v_purchase_id is null then
    return query
    select null::uuid, false, 'not_a_service_purchase'::text,
           null::uuid, null::uuid, null::integer, null::text,
           null::integer, null::integer;
    return;
  end if;

  return query
  select *
    from public.reverse_service_purchase_earning(
      v_purchase_id, p_reason, p_refunded_total_minor
    );
end;
$$;

comment on function
  public.reverse_service_purchase_for_payment_intent(
  text, text, integer) is
  'Migration 043 (was migration 040). Applies a cumulative refund '
  'total, found from the PaymentIntent behind a refunded charge, '
  'so the Stripe webhook never reads a finance table (Amendment '
  '004 section 10.3.3). A PaymentIntent belonging to no service '
  'purchase returns ''not_a_service_purchase'' rather than '
  'raising, which is how a consultation refund falls through to '
  'its own path.';


-- ============================================================
-- D. Privileges
-- ============================================================
--
-- A dropped and recreated function loses its ACL, and Supabase's
-- default privileges hand EXECUTE straight back to anon and
-- authenticated. Re-asserting is mandatory, not decorative: left
-- alone, an anonymous key could reverse a consultant's earnings.

do $$
declare
  v_fn regprocedure;
  v_names text[] := array[
    'reverse_service_purchase_earning',
    'reverse_service_purchase_for_payment_intent'
  ];
begin
  for v_fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any(v_names)
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated',
      v_fn
    );

    execute format(
      'grant execute on function %s to service_role', v_fn
    );
  end loop;
end;
$$;

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See
-- MIGRATION_043_VERIFICATION.sql for the full self-contained suite.
--
--  1. select p.proargnames from pg_proc p
--       join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public'
--        and p.proname = 'reverse_service_purchase_earning';
--       -> includes p_refunded_total_minor, not p_gross_amount_minor
--
--  2. select count(*) from pg_proc p
--       join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public'
--        and p.proname in (
--          'reverse_service_purchase_earning',
--          'reverse_service_purchase_for_payment_intent');
--       -> 2  (one of each; no leftover overload)
--
--  3. select has_function_privilege(
--       'anon',
--       'public.reverse_service_purchase_earning(uuid, text, integer)',
--       'EXECUTE');
--       -> false
