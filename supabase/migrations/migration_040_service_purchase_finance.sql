-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 040: Service purchase finance integration
-- ============================================================
--
-- Classification:
-- - Phase 2 finance. Connects a client's service payment to the
--   ledger. Two additive columns, two indexes, one constraint and
--   four RPCs. No commission rule changes, no payout changes, no
--   Stripe Connect, no automation of anything.
--
-- The problem this solves:
-- - API_CONTRACT §3a has said, in writing, that "a service
--   Payment Link purchase creates no row in any MakeHijrah table"
--   and that "Stripe is the temporary source of truth…
--   Reconciliation into the database is out of scope and requires
--   its own amendment". This migration is the database half of
--   that amendment. Until now a consultant could recommend a
--   service, a client could buy it, and the consultant earned
--   nothing, because nothing in this system ever learned that the
--   sale happened.
--
-- What this migration does:
--   A. service_purchases.stripe_subscription_id
--      service_purchases.refunded_amount_minor
--   B. The refund bound and the two subscription indexes.
--   C. record_service_purchase()          payment  -> purchase + pending earning
--   D. fulfill_service_purchase()         delivery -> earning becomes available
--   E. reverse_service_purchase_earning() refund   -> negative entry
--   E2. reverse_service_purchase_for_payment_intent()
--                                         the webhook's refund entry point
--   F. Privileges.
--
-- Deliberately NOT done here:
-- - No new table. service_purchases (migration 034) already has
--   the exact shape this needs, including the three Stripe unique
--   indexes that make webhook redelivery safe.
-- - No new status value. The vocabulary stays
--   paid | fulfilled | refunded | cancelled. A partial refund is
--   represented by refunded_amount_minor being between zero and
--   the gross, which is a fact rather than a state, and which
--   needs no constraint rewrite and no migration to extend later.
-- - No 'pending' purchase. A row is written only after Stripe
--   says money moved, so there is no state in which a purchase
--   exists without a payment behind it.
-- - No change to any ledger constraint. The ledger already admits
--   source_type = 'service_purchase' with commission_basis =
--   'service_rate' (ledger_basis_alignment_check, migration 034);
--   this migration is the first thing to use it.
-- - No change to reverse_ledger_entry, which already reverses
--   proportionally, refuses over-reversal, and — the property
--   that matters most here — gives the reversal the SAME
--   availability as the entry it reverses. Refunding a pending
--   earning therefore cannot conjure available funds.
-- - No change to any existing RPC, policy, grant or trigger.
--   service_purchases already carries its RLS from migration 034:
--   the attributed consultant and an admin may read, a client may
--   not, and nobody may write except through these functions.
--
-- Rerun safety:
-- - Idempotent. Columns use ADD COLUMN IF NOT EXISTS, the
--   constraint is dropped before it is added, indexes use IF NOT
--   EXISTS, functions are CREATE OR REPLACE at fixed signatures
--   and REVOKE/GRANT are declarative.
-- ============================================================

begin;

-- ------------------------------------------------------- guard ----

do $$
begin
  if to_regclass('public.service_purchases') is null
     or to_regclass('public.consultant_ledger_entries') is null then
    raise exception
      'migration 040: finance tables not found - migration 034 must be applied first';
  end if;

  if to_regclass('public.service_recommendations') is null
     or to_regclass('public.service_requests') is null then
    raise exception
      'migration 040: service workflow tables not found - migration 001 must be applied first';
  end if;

  if to_regprocedure(
       'public.reverse_ledger_entry(uuid, text, integer)'
     ) is null then
    raise exception
      'migration 040: reverse_ledger_entry not found - migration 035 must be applied first';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'services'
       and column_name = 'consultant_commission_bps'
  ) then
    raise exception
      'migration 040: services.consultant_commission_bps not found - migration 034 must be applied first';
  end if;
end;
$$;


-- ============================================================
-- A. Columns
-- ============================================================
--
-- stripe_subscription_id is what makes a renewal findable.
-- A renewal invoice names its subscription and nothing else that
-- this system already knows: it carries no service, no client and
-- no payment link. Storing the subscription on the first purchase
-- is what lets every later invoice inherit that first purchase's
-- attribution instead of trying to re-derive it from an invoice
-- that cannot answer.
--
-- refunded_amount_minor accumulates. It is on the purchase rather
-- than derived from the ledger because an unattributed purchase
-- has no ledger entry to derive it from — a service with no
-- commission rate, or a sale nobody is credited for, still gets
-- refunded, and that fact still has to be recorded somewhere.

alter table public.service_purchases
  add column if not exists stripe_subscription_id text;

alter table public.service_purchases
  add column if not exists refunded_amount_minor integer
    not null default 0;

comment on column public.service_purchases.stripe_subscription_id is
  'Migration 040. The Stripe subscription this purchase belongs '
  'to, null for a one-time sale. Every renewal invoice for the '
  'same subscription produces its own purchase row, distinguished '
  'by billing_period_sequence.';

comment on column public.service_purchases.refunded_amount_minor is
  'Migration 040. Gross minor units refunded against this '
  'purchase so far, accumulating across partial refunds. Zero '
  'means untouched; equal to gross_amount_minor means fully '
  'refunded, which is the only case that moves status to '
  '''refunded''. A value strictly between the two is a partial '
  'refund - a fact, deliberately not a status.';


-- ============================================================
-- B. The refund bound, and the subscription indexes
-- ============================================================

/*
 * A purchase cannot be refunded for more than it charged. Both
 * ends are bounded: a negative refund would be a covert charge.
 */
alter table public.service_purchases
  drop constraint if exists service_purchases_refunded_amount_check;
alter table public.service_purchases
  add constraint service_purchases_refunded_amount_check
  check (
    refunded_amount_minor >= 0
    and refunded_amount_minor <= gross_amount_minor
  );

/*
 * One purchase per billing period of a subscription.
 *
 * This is the guarantee that a redelivered renewal invoice, or
 * two workers processing the same invoice at once, cannot credit
 * a consultant twice for one month. The advisory lock in
 * record_service_purchase serialises sequence allocation; this
 * index is what makes the guarantee hold even if that lock were
 * ever removed or bypassed.
 */
create unique index if not exists
  uq_service_purchases_subscription_period
  on public.service_purchases (
    stripe_subscription_id, billing_period_sequence
  )
  where stripe_subscription_id is not null;

create index if not exists idx_service_purchases_subscription
  on public.service_purchases (stripe_subscription_id)
  where stripe_subscription_id is not null;


-- ============================================================
-- C. record_service_purchase
-- ============================================================
--
-- The payment path. One transaction: identify the service,
-- identify the client, RE-RESOLVE the consultant from MakeHijrah
-- records, write the purchase, and write the pending earning.
--
-- The single most important property of this function is what it
-- does NOT accept. There is no consultant parameter. There is no
-- commission parameter. Attribution is derived here, from
-- service_recommendations and consultations, every time — so a
-- consultant id sitting in Stripe metadata, however it got there,
-- is not merely distrusted, it has nowhere to be passed in. The
-- checkout endpoint puts trusted context into Stripe metadata for
-- its own use; this function still re-derives the answer rather
-- than reading it back.
--
-- What a caller MAY supply is what only Stripe knows: the amount,
-- the currency, the identifiers, and a CANDIDATE client. The
-- candidate is validated against profiles before it is believed,
-- and a candidate that does not resolve produces an unattributed
-- purchase rather than an error. Unattributed revenue is recorded
-- and visible; it is never discarded.
--
-- Idempotent on every Stripe identifier it is given. A redelivered
-- webhook re-reads the existing purchase and its earning and
-- reports created = false.

/*
 * Dropped before it is created, and the signature named here is
 * the TEN-argument form this function briefly had during
 * development.
 *
 * CREATE OR REPLACE matches on the full signature, so adding
 * p_stripe_price_id would have created a second overload rather
 * than replacing anything — and a call that matched both would
 * then be ambiguous. Naming the old form explicitly means a
 * database that saw the earlier version converges on one
 * function, and a database that never did finds nothing to drop
 * and carries on.
 */
drop function if exists public.record_service_purchase(
  integer, text, text, uuid, uuid, text, text, text, text, text);

create or replace function public.record_service_purchase(
  p_gross_amount_minor integer,
  p_currency text,
  p_stripe_mode text,
  p_service_id uuid default null,
  p_client_profile_id uuid default null,
  p_stripe_payment_link_id text default null,
  p_stripe_checkout_session_id text default null,
  p_stripe_payment_intent_id text default null,
  p_stripe_invoice_id text default null,
  p_stripe_subscription_id text default null,
  p_stripe_price_id text default null
)
returns table (
  purchase_id uuid,
  created boolean,
  service_id uuid,
  client_profile_id uuid,
  service_request_id uuid,
  consultation_id uuid,
  attributed_consultant_id uuid,
  gross_amount_minor integer,
  currency text,
  billing_type text,
  recurring_interval text,
  billing_period_sequence integer,
  status text,
  entry_id uuid,
  earning_created boolean,
  consultant_amount_minor integer,
  platform_amount_minor integer,
  commission_bps integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_service public.services%rowtype;
  v_purchase public.service_purchases%rowtype;
  v_entry public.consultant_ledger_entries%rowtype;
  v_currency text := lower(btrim(coalesce(p_currency, '')));
  v_mode text := lower(btrim(coalesce(p_stripe_mode, '')));
  v_client uuid;
  v_inherited_service uuid;
  v_inherited_client uuid;
  v_consultant uuid;
  v_consultation uuid;
  v_request uuid;
  v_billing_type text;
  v_interval text;
  v_sequence integer := 1;
  v_bps integer;
  v_consultant_minor integer;
  v_platform_minor integer;
  v_created boolean := false;
  v_earning_created boolean := false;
begin
  -- 1. What Stripe told us, validated before it is used.

  if p_gross_amount_minor is null
     or p_gross_amount_minor <= 0 then
    raise exception
      'FINANCE_PURCHASE_AMOUNT_INVALID: a purchase must have a positive gross amount';
  end if;

  if v_currency !~ '^[a-z]{3}$' then
    raise exception
      'FINANCE_CURRENCY_INVALID: % is not a three-letter currency code',
      p_currency;
  end if;

  if v_mode not in ('test', 'live') then
    raise exception
      'FINANCE_STRIPE_MODE_INVALID: % is not test or live', p_stripe_mode;
  end if;

  if p_stripe_checkout_session_id is null
     and p_stripe_invoice_id is null
     and p_stripe_payment_intent_id is null then
    raise exception
      'FINANCE_STRIPE_REFERENCE_REQUIRED: a purchase must carry at least one Stripe identifier';
  end if;

  -- 2. Which service was bought, and for whom.
  --
  --    Four sources, tried in order of how much they are worth
  --    trusting. Every one of them is a database lookup rather
  --    than a metadata read, which is the point: Payment Link
  --    metadata is not guaranteed to reach the invoice a renewal
  --    produces a year later, and the whole resolution chain must
  --    keep working when it does not.
  --
  --      a. an explicit service id, from a Session this system
  --         created;
  --      b. INHERITANCE from the first purchase of the same
  --         subscription — the renewal case, and the reason a
  --         renewal needs no metadata at all;
  --      c. the payment link, resolved against
  --         services.stripe_payment_link_id;
  --      d. the price, resolved against services.stripe_price_id.
  --         Identifies the service but nobody's client, so the
  --         purchase is recorded unattributed rather than
  --         credited to a guess.
  --
  --    The lookups live here rather than in the orchestrator
  --    because Amendment 004 section 10.3.3 holds the webhook
  --    path to RPC calls only. reverse_consultation_earning
  --    (migration 035) exists for exactly the same reason.

  if p_service_id is not null then
    select * into v_service
      from public.services where id = p_service_id;
  end if;

  if v_service.id is null
     and p_stripe_subscription_id is not null then
    /*
     * Inherit from the earliest period of this subscription, so
     * the chain always leads back to the original purchase rather
     * than to whichever renewal was written last.
     */
    select sp.service_id, sp.client_profile_id
      into v_inherited_service, v_inherited_client
      from public.service_purchases sp
     where sp.stripe_subscription_id = p_stripe_subscription_id
     order by sp.billing_period_sequence
     limit 1;

    if v_inherited_service is not null then
      select * into v_service
        from public.services where id = v_inherited_service;
    end if;
  end if;

  if v_service.id is null
     and p_stripe_payment_link_id is not null then
    select * into v_service
      from public.services
     where stripe_payment_link_id = p_stripe_payment_link_id;
  end if;

  if v_service.id is null
     and p_stripe_price_id is not null then
    select * into v_service
      from public.services
     where stripe_price_id = p_stripe_price_id;
  end if;

  if v_service.id is null then
    raise exception
      'FINANCE_SERVICE_NOT_FOUND: no service resolved from service id %, subscription %, payment link % or price %',
      p_service_id, p_stripe_subscription_id,
      p_stripe_payment_link_id, p_stripe_price_id;
  end if;

  -- 3. Idempotency, before anything is written.
  --
  --    Checked most specific first. An invoice identifies exactly
  --    one billing period; a checkout session exactly one
  --    purchase; a payment intent is last because a subscription's
  --    invoices can share one in some flows.

  if p_stripe_invoice_id is not null then
    select * into v_purchase
      from public.service_purchases
     where stripe_invoice_id = p_stripe_invoice_id;
  end if;

  if v_purchase.id is null
     and p_stripe_checkout_session_id is not null then
    select * into v_purchase
      from public.service_purchases
     where stripe_checkout_session_id = p_stripe_checkout_session_id;
  end if;

  /*
   * The PaymentIntent is the LAST resort, and deliberately not
   * consulted when an invoice id was supplied.
   *
   * An invoice identifies exactly one billing period, so if it
   * did not match, this is a period that has not been recorded —
   * whatever PaymentIntent it happens to carry. Falling back to
   * the PaymentIntent here would let a renewal that reused one be
   * mistaken for the period before it, and the consultant would
   * silently lose that month's commission.
   */
  if v_purchase.id is null
     and p_stripe_invoice_id is null
     and p_stripe_payment_intent_id is not null then
    select * into v_purchase
      from public.service_purchases
     where stripe_payment_intent_id = p_stripe_payment_intent_id;
  end if;

  if v_purchase.id is not null then
    select * into v_entry
      from public.consultant_ledger_entries
     where entry_type = 'earning'
       and source_type = 'service_purchase'
       and source_id = v_purchase.id
       and source_component = 'full';

    return query
    select v_purchase.id, false, v_purchase.service_id,
           v_purchase.client_profile_id,
           v_purchase.service_request_id,
           v_purchase.consultation_id,
           v_purchase.attributed_consultant_id,
           v_purchase.gross_amount_minor, v_purchase.currency,
           v_purchase.billing_type, v_purchase.recurring_interval,
           v_purchase.billing_period_sequence, v_purchase.status,
           v_entry.id, false, v_entry.consultant_amount_minor,
           v_entry.platform_amount_minor, v_entry.commission_bps;
    return;
  end if;

  -- 4. Which client, if any.
  --
  --    A candidate is believed only if it resolves to a real
  --    client profile. Anything else - a forged id, a deleted
  --    profile, a consultant's own id, null - yields an
  --    unattributed purchase. Revenue is still recorded.

  if p_client_profile_id is not null then
    select id into v_client
      from public.profiles
     where id = p_client_profile_id
       and role = 'client';
  end if;

  /*
   * A renewal carries no client of its own. It inherits the one
   * recorded on the first purchase of its subscription, which was
   * itself validated when that purchase was written — so a
   * subscription cannot drift to a different client between
   * periods, whatever a later invoice happens to say.
   */
  if v_client is null and v_inherited_client is not null then
    v_client := v_inherited_client;
  end if;

  -- 5. Which consultant. RE-RESOLVED, never supplied.
  --
  --    The trusted chain is: a consultant recommended this
  --    service on a consultation belonging to this client, and an
  --    admin sent that recommendation. recommended_by_consultant_id
  --    is written by the consultant's own RLS-scoped insert, and
  --    the consultation binds it to this client. Nothing a client
  --    controls appears anywhere in this query.
  --
  --    Most recently sent wins, so the answer is deterministic
  --    when two consultants recommended the same service.

  if v_client is not null then
    select r.recommended_by_consultant_id, r.consultation_id
      into v_consultant, v_consultation
      from public.service_recommendations r
      join public.consultations c on c.id = r.consultation_id
     where r.service_id = v_service.id
       and r.status = 'sent'
       and c.client_profile_id = v_client
     order by r.sent_at desc nulls last, r.created_at desc
     limit 1;

    /*
     * The operational request, if one exists. Attribution data
     * only: service_requests is the workflow record and is never
     * consulted to decide who earns or whether anything is
     * available.
     */
    select sr.id into v_request
      from public.service_requests sr
     where sr.service_id = v_service.id
       and sr.client_profile_id = v_client
       and sr.status <> 'cancelled'
     order by sr.created_at desc
     limit 1;
  end if;

  -- 6. Billing shape.
  --
  --    A subscription invoice is recurring by definition, whatever
  --    the catalog currently says, because that is what actually
  --    happened. Otherwise the service's own shape is used, and an
  --    unpriced service falls back to one_time so a real payment
  --    is never rejected for a catalog gap. Every branch satisfies
  --    service_purchases_billing_shape_check.

  if p_stripe_subscription_id is not null then
    v_billing_type := 'recurring';
    v_interval := coalesce(v_service.recurring_interval, 'month');
  else
    v_billing_type := coalesce(v_service.billing_type, 'one_time');
    v_interval := case
                    when v_billing_type = 'recurring'
                      then coalesce(v_service.recurring_interval, 'month')
                    else null
                  end;
  end if;

  -- 7. The renewal sequence.
  --
  --    Serialised per subscription with a transaction-scoped
  --    advisory lock keyed on a stable hash of the subscription
  --    id. Two renewal invoices arriving at the same instant
  --    therefore allocate 1 and 2 rather than both reading the
  --    same count and both trying to write 1. The lock is released
  --    when the transaction ends, whichever way it ends.
  --
  --    uq_service_purchases_subscription_period backs this up: if
  --    the lock is ever bypassed the second writer fails on the
  --    index instead of double-crediting.

  if p_stripe_subscription_id is not null then
    perform pg_advisory_xact_lock(
      hashtextextended(p_stripe_subscription_id, 0)
    );

    select coalesce(max(sp.billing_period_sequence), 0) + 1
      into v_sequence
      from public.service_purchases sp
     where sp.stripe_subscription_id = p_stripe_subscription_id;
  end if;

  -- 8. The purchase.
  --
  --    One guard before the insert. Migration 034 put a unique
  --    index on (service_request_id, billing_period_sequence) so
  --    that a renewal recorded twice by hand is rejected the same
  --    way a replayed webhook is. That is correct, and it means
  --    the request slot for this period may already be taken — a
  --    client who buys the same one-time service twice resolves
  --    the same open request both times.
  --
  --    The request link is context, not money. If the slot is
  --    taken the purchase is recorded WITHOUT it rather than
  --    failing: losing a workflow cross-reference is a small
  --    thing, and refusing to record a payment that Stripe has
  --    already taken is not.

  if v_request is not null and exists (
    select 1 from public.service_purchases sp
     where sp.service_request_id = v_request
       and sp.billing_period_sequence = v_sequence
  ) then
    v_request := null;
  end if;

  insert into public.service_purchases (
    service_id, service_request_id, consultation_id,
    client_profile_id, attributed_consultant_id,
    gross_amount_minor, currency,
    billing_type, recurring_interval, billing_period_sequence,
    status, stripe_mode, stripe_payment_intent_id,
    stripe_checkout_session_id, stripe_invoice_id,
    stripe_subscription_id, purchased_at
  )
  values (
    v_service.id, v_request, v_consultation,
    v_client, v_consultant,
    p_gross_amount_minor, v_currency,
    v_billing_type, v_interval, v_sequence,
    'paid', v_mode, p_stripe_payment_intent_id,
    p_stripe_checkout_session_id, p_stripe_invoice_id,
    p_stripe_subscription_id, now()
  )
  on conflict do nothing
  returning * into v_purchase;

  if v_purchase.id is null then
    /*
     * A lost race, not an error: another delivery of the same
     * event wrote this purchase first. Read theirs.
     */
    select * into v_purchase
      from public.service_purchases
     where (p_stripe_invoice_id is not null
            and stripe_invoice_id = p_stripe_invoice_id)
        or (p_stripe_checkout_session_id is not null
            and stripe_checkout_session_id = p_stripe_checkout_session_id)
        or (p_stripe_payment_intent_id is not null
            and stripe_payment_intent_id = p_stripe_payment_intent_id)
     limit 1;

    /*
     * Not a redelivery after all. The only other index this
     * insert can collide with is the request-period one, and it
     * can be lost to a concurrent purchase between the guard
     * above and this insert. Retry once without the request
     * link, for the same reason the guard exists: a real payment
     * is recorded even if its workflow cross-reference cannot be.
     */
    if v_purchase.id is null and v_request is not null then
      v_request := null;

      insert into public.service_purchases (
        service_id, service_request_id, consultation_id,
        client_profile_id, attributed_consultant_id,
        gross_amount_minor, currency,
        billing_type, recurring_interval, billing_period_sequence,
        status, stripe_mode, stripe_payment_intent_id,
        stripe_checkout_session_id, stripe_invoice_id,
        stripe_subscription_id, purchased_at
      )
      values (
        v_service.id, null, v_consultation,
        v_client, v_consultant,
        p_gross_amount_minor, v_currency,
        v_billing_type, v_interval, v_sequence,
        'paid', v_mode, p_stripe_payment_intent_id,
        p_stripe_checkout_session_id, p_stripe_invoice_id,
        p_stripe_subscription_id, now()
      )
      on conflict do nothing
      returning * into v_purchase;

      if v_purchase.id is not null then
        v_created := true;
      end if;
    end if;

    if v_purchase.id is null then
      raise exception
        'FINANCE_PURCHASE_CONFLICT: the purchase could not be written or re-read';
    end if;
  else
    v_created := true;
  end if;

  -- 9. The pending earning.
  --
  --    Three ways there is legitimately no earning, and none of
  --    them is an error: nobody is attributed, the service carries
  --    no commission rate, or the rate rounds this gross to
  --    nothing. A zero-amount entry is refused by
  --    ledger_sign_check anyway, and it would record no financial
  --    fact - the purchase row already carries the attribution.

  v_bps := v_service.consultant_commission_bps;

  if v_purchase.attributed_consultant_id is not null
     and v_bps is not null
     and v_bps > 0 then

    /*
     * Integer arithmetic through numeric. Never float: a binary
     * float cannot represent a decimal rate exactly, and money
     * that is out by one minor unit is money that is wrong.
     * The platform takes the remainder by subtraction, so
     * consultant + platform = gross holds exactly and
     * ledger_amount_identity_check can never fail.
     */
    v_consultant_minor := round(
      v_purchase.gross_amount_minor::numeric * v_bps / 10000
    )::integer;

    v_platform_minor :=
      v_purchase.gross_amount_minor - v_consultant_minor;

    if v_consultant_minor > 0 then
      insert into public.consultant_ledger_entries (
        consultant_id, entry_type, source_type, source_id,
        source_component, gross_amount_minor,
        consultant_amount_minor, platform_amount_minor,
        commission_bps, commission_basis, currency, available_at
      )
      values (
        v_purchase.attributed_consultant_id, 'earning',
        'service_purchase', v_purchase.id, 'full',
        v_purchase.gross_amount_minor,
        v_consultant_minor, v_platform_minor,
        v_bps, 'service_rate', v_purchase.currency, null
      )
      on conflict do nothing
      returning * into v_entry;

      if v_entry.id is null then
        select * into v_entry
          from public.consultant_ledger_entries
         where entry_type = 'earning'
           and source_type = 'service_purchase'
           and source_id = v_purchase.id
           and source_component = 'full';
      else
        v_earning_created := true;
      end if;
    end if;
  end if;

  return query
  select v_purchase.id, v_created, v_purchase.service_id,
         v_purchase.client_profile_id,
         v_purchase.service_request_id, v_purchase.consultation_id,
         v_purchase.attributed_consultant_id,
         v_purchase.gross_amount_minor, v_purchase.currency,
         v_purchase.billing_type, v_purchase.recurring_interval,
         v_purchase.billing_period_sequence, v_purchase.status,
         v_entry.id, v_earning_created,
         v_entry.consultant_amount_minor,
         v_entry.platform_amount_minor, v_entry.commission_bps;
end;
$$;

comment on function public.record_service_purchase(
  integer, text, text, uuid, uuid, text, text, text, text, text,
  text) is
  'Migration 040. Records a paid service purchase and its pending '
  'consultant earning in one transaction. Accepts no consultant '
  'and no commission rate: attribution is RE-DERIVED here from '
  'service_recommendations and consultations every time, so a '
  'consultant id in Stripe metadata cannot influence who is '
  'credited. A client candidate is validated against profiles and '
  'an unresolved one produces an unattributed purchase rather '
  'than an error - unattributed revenue is recorded, never '
  'discarded. Idempotent on every Stripe identifier supplied. '
  'The earning is created pending; only fulfil_service_purchase '
  'makes it available.';


-- ============================================================
-- D. fulfill_service_purchase
-- ============================================================
--
-- The delivery path, and the only thing that makes a service
-- earning withdrawable.
--
-- The authoritative fulfilment fact is service_purchases
-- .fulfilled_at, NOT service_requests.status = 'completed'. The
-- two are kept apart on purpose: service_requests is the
-- operational record an admin drives directly through RLS, and a
-- workflow status that an ordinary browser write could move must
-- never be the thing that releases money. Completing the request
-- and fulfilling the purchase are separate acts, and this
-- function is the financial one.
--
-- Idempotent: fulfilling twice is a reported no-op, not an error,
-- because a double-clicked button must not be a failure.

create or replace function public.fulfill_service_purchase(
  p_purchase_id uuid,
  p_admin_profile_id uuid
)
returns table (
  purchase_id uuid,
  status text,
  fulfilled_at timestamptz,
  released boolean,
  reason text,
  entry_id uuid,
  available_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_purchase public.service_purchases%rowtype;
  v_entry public.consultant_ledger_entries%rowtype;
  v_now timestamptz := now();
  v_released boolean := false;
  v_reason text;
begin
  if not exists (
    select 1 from public.profiles
     where id = p_admin_profile_id and role = 'admin'
  ) then
    raise exception
      'FINANCE_ADMIN_REQUIRED: profile % is not an admin',
      p_admin_profile_id;
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

  select * into v_entry
    from public.consultant_ledger_entries
   where entry_type = 'earning'
     and source_type = 'service_purchase'
     and source_id = v_purchase.id
     and source_component = 'full'
   for update;

  /*
   * Already fulfilled. Returned before the status guard so a
   * redelivered click is a no-op rather than a refusal, and
   * reported honestly so the caller can tell it changed nothing.
   */
  if v_purchase.status = 'fulfilled' then
    return query
    select v_purchase.id, v_purchase.status, v_purchase.fulfilled_at,
           false, 'already_fulfilled'::text,
           v_entry.id, v_entry.available_at;
    return;
  end if;

  if v_purchase.status <> 'paid' then
    raise exception
      'FINANCE_PURCHASE_NOT_FULFILLABLE: purchase % is %, only a paid purchase may be fulfilled',
      v_purchase.id, v_purchase.status;
  end if;

  update public.service_purchases
     set status = 'fulfilled',
         fulfilled_at = v_now
   where id = v_purchase.id
  returning * into v_purchase;

  /*
   * The one mutation trg_ledger_append_only permits: available_at
   * advancing once from null. A purchase with no earning - no
   * attribution, or no commission rate - fulfils perfectly well
   * and releases nothing.
   */
  if v_entry.id is not null and v_entry.available_at is null then
    update public.consultant_ledger_entries
       set available_at = v_now
     where id = v_entry.id
    returning * into v_entry;

    v_released := true;
    v_reason := 'released';
  elsif v_entry.id is not null then
    v_reason := 'already_available';
  else
    v_reason := 'no_entry';
  end if;

  return query
  select v_purchase.id, v_purchase.status, v_purchase.fulfilled_at,
         v_released, v_reason, v_entry.id, v_entry.available_at;
end;
$$;

comment on function public.fulfill_service_purchase(uuid, uuid) is
  'Migration 040. Marks a paid service purchase fulfilled and '
  'advances its earning from pending to available. '
  'service_purchases.fulfilled_at is the authoritative finance '
  'fulfilment fact; service_requests.status is the operational '
  'record and deliberately does not release money. Admin only. '
  'Idempotent: a second call reports already_fulfilled and '
  'changes nothing. Each renewal of a recurring service is '
  'fulfilled individually.';


-- ============================================================
-- E. reverse_service_purchase_earning
-- ============================================================
--
-- The refund path, named by the purchase rather than by the
-- ledger entry, so the webhook never reads a table to find out
-- what to reverse.
--
-- All the reversal arithmetic stays in reverse_ledger_entry
-- (migration 035). This function is a lookup, a bound, and the
-- purchase-side bookkeeping. Two properties are inherited from it
-- and are the reason it is reused rather than reimplemented:
--
--   * a reversal gets the SAME availability as the entry it
--     reverses, so refunding a pending earning produces a pending
--     reversal and cannot conjure available funds; and
--   * over-reversal is refused there as well as here.
--
-- The purchase-level bound is checked FIRST and independently,
-- because a purchase with no earning - unattributed, or a service
-- with no commission rate - still gets refunded and still must
-- not be refunded for more than it charged.
--
-- A reversal against an earning that has already been paid out is
-- deliberately permitted. It drives the balance negative, which
-- migration 034 states is legal, and future earnings offset it.

create or replace function public.reverse_service_purchase_earning(
  p_purchase_id uuid,
  p_reason text,
  p_gross_amount_minor integer default null
)
returns table (
  purchase_id uuid,
  reversed boolean,
  reason text,
  entry_id uuid,
  reversal_entry_id uuid,
  refunded_amount_minor integer,
  status text,
  consultant_amount_minor integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_purchase public.service_purchases%rowtype;
  v_entry public.consultant_ledger_entries%rowtype;
  v_reversal record;
  v_remaining integer;
  v_portion integer;
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

  v_remaining :=
    v_purchase.gross_amount_minor - v_purchase.refunded_amount_minor;

  /*
   * Already fully refunded. An ordinary outcome rather than a
   * failure: a redelivered charge.refunded must not raise, or the
   * webhook returns non-2xx and Stripe delivers it again.
   */
  if v_remaining <= 0 then
    return query
    select v_purchase.id, false, 'already_refunded'::text,
           null::uuid, null::uuid,
           v_purchase.refunded_amount_minor, v_purchase.status,
           null::integer;
    return;
  end if;

  v_portion := coalesce(p_gross_amount_minor, v_remaining);

  if v_portion <= 0 then
    raise exception
      'FINANCE_REVERSAL_AMOUNT_INVALID: a refund must be a positive gross amount';
  end if;

  if v_portion > v_remaining then
    raise exception
      'FINANCE_REFUND_EXCEEDS_PURCHASE: % exceeds the % remaining on purchase %',
      v_portion, v_remaining, p_purchase_id;
  end if;

  select * into v_entry
    from public.consultant_ledger_entries
   where entry_type = 'earning'
     and source_type = 'service_purchase'
     and source_id = v_purchase.id
     and source_component = 'full';

  if v_entry.id is not null then
    select * into v_reversal
      from public.reverse_ledger_entry(
        v_entry.id, p_reason, v_portion
      );
  end if;

  v_refunded := v_purchase.refunded_amount_minor + v_portion;

  /*
   * Status moves to 'refunded' only when the refund reaches the
   * gross. A partial refund leaves the purchase paid or fulfilled
   * and records the amount, which is why no partially_refunded
   * status is needed: the number says more than a word would.
   */
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
         v_reversal.entry_id,
         v_purchase.refunded_amount_minor,
         v_purchase.status,
         v_reversal.consultant_amount_minor;
end;
$$;

comment on function public.reverse_service_purchase_earning(
  uuid, text, integer) is
  'Migration 040. Refunds a service purchase: accumulates '
  'refunded_amount_minor, moves status to ''refunded'' only when '
  'the refund reaches the gross, and creates a negative ledger '
  'entry through reverse_ledger_entry. Never mutates the original '
  'earning. A reversal inherits the availability of the entry it '
  'reverses, so refunding a pending earning cannot create '
  'available funds. Over-refund is refused at the purchase and '
  'again at the ledger; a purchase with no earning still records '
  'its refund. Reversing a paid-out earning is permitted and may '
  'drive the balance negative, which future earnings offset.';


-- ============================================================
-- E2. reverse_service_purchase_for_payment_intent
-- ============================================================
--
-- The refund path's actual entry point: reverse whatever a
-- service purchase earned, named by the Stripe PaymentIntent
-- behind the refunded charge rather than by the purchase.
--
-- It exists for the same reason reverse_consultation_earning
-- (migration 035) exists. Amendment 004 section 10.3.3 holds the
-- webhook to RPC calls only, and finding the purchase from the
-- orchestrator would have meant a direct SELECT on a finance
-- table plus a second round trip in which the purchase could
-- change. The webhook test enforces that rule by making any
-- direct table access from the webhook path throw.
--
-- A PaymentIntent belonging to no service purchase is the
-- ORDINARY case — it is almost certainly a consultation refund —
-- so it returns 'not_a_service_purchase' rather than raising.
-- That is the signal the webhook uses to fall through to the
-- consultation refund path unchanged.

create or replace function
  public.reverse_service_purchase_for_payment_intent(
  p_stripe_payment_intent_id text,
  p_reason text,
  p_gross_amount_minor integer default null
)
returns table (
  purchase_id uuid,
  reversed boolean,
  reason text,
  entry_id uuid,
  reversal_entry_id uuid,
  refunded_amount_minor integer,
  status text,
  consultant_amount_minor integer
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
           null::integer;
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
           null::integer;
    return;
  end if;

  return query
  select *
    from public.reverse_service_purchase_earning(
      v_purchase_id, p_reason, p_gross_amount_minor
    );
end;
$$;

comment on function
  public.reverse_service_purchase_for_payment_intent(
  text, text, integer) is
  'Migration 040. Reverses a service purchase''s earning, found '
  'from the PaymentIntent behind a refunded charge, so the Stripe '
  'webhook never reads a finance table (Amendment 004 section '
  '10.3.3). A PaymentIntent belonging to no service purchase '
  'returns ''not_a_service_purchase'' rather than raising, which '
  'is how a consultation refund falls through to its own path.';


-- ============================================================
-- F. Privileges
-- ============================================================
--
-- Migration 036's rule, applied to three new functions: these are
-- orchestrator-only RPCs sitting behind HTTP endpoints that do
-- the authorisation. CREATE FUNCTION grants EXECUTE to PUBLIC and
-- Supabase's default privileges grant it to anon, authenticated
-- and service_role, so every role is named explicitly rather than
-- assumed. Left alone, an anonymous key could record a purchase,
-- fulfil it, and release money to a consultant.

do $$
declare
  v_fn regprocedure;
  v_names text[] := array[
    'record_service_purchase',
    'fulfill_service_purchase',
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
-- MIGRATION_040_VERIFICATION.sql for the full self-contained suite.
--
--  1. select count(*) from information_schema.columns
--      where table_schema = 'public'
--        and table_name = 'service_purchases'
--        and column_name in (
--          'stripe_subscription_id', 'refunded_amount_minor');
--       -> 2
--
--  2. select count(*) from pg_proc p
--       join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public'
--        and p.proname in (
--          'record_service_purchase', 'fulfill_service_purchase',
--          'reverse_service_purchase_earning');
--       -> 3
--
--  3. select has_function_privilege(
--       'anon', 'public.fulfill_service_purchase(uuid, uuid)',
--       'EXECUTE');
--       -> false
--
--  4. select count(*) from information_schema.tables
--      where table_schema = 'public' and table_type = 'BASE TABLE';
--       -> 21  (unchanged; this migration adds no table)
