-- ─────────────────────────────────────────────────────────────────────────────
-- Finlynq schema baseline — the from-zero source of truth.  (GH #312 / FINLYNQ-293)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THIS IS
-- A complete, authoritative snapshot of the production schema, captured with
-- `pg_dump --schema-only` on 2026-07-24 and verified to reproduce prod exactly:
-- 68 tables / 723 columns / 215 constraints / 195 indexes, zero diff.
--
-- WHY IT EXISTS
-- Before this file, no reproducible from-zero path existed. The schema had been
-- built up over time by three uncoordinated mechanisms:
--   1. `drizzle-pg/` (4 files, 21 tables) — run only by the Docker entrypoint
--   2. `scripts/migrations/` (70 files) — run only by deploy.sh
--   3. ~39 loose `scripts/migrate-*.sql` run BY HAND against prod and never tracked
-- Prod and dev were correct only because (3) had been applied to them manually.
-- Replaying (1)+(2) against an empty database was measured on 2026-07-24:
-- **38 of 70 migrations failed and only 43 of 70 tables were created.** That is
-- why the published Docker image could never reach a registerable instance
-- (GH #312), and why a from-scratch rebuild of a cloud environment without a
-- `pg_dump` to restore would also have failed.
--
-- HOW IT IS APPLIED
-- Never by the ordinary migration loop. Both runners — deploy.sh and
-- scripts/run-migrations.mjs — apply this file ONLY when the target database is
-- empty, then continue with the normal `scripts/migrations/*.sql` loop. On an
-- existing database it is never executed and never recorded. See the "baseline"
-- section in both runners; they implement identical logic.
--
-- The trailing INSERT records the 70 migrations whose effects are already
-- folded into this snapshot, so the normal loop skips them on a fresh database.
-- A migration added AFTER this baseline is simply absent from that list and runs
-- normally. Do NOT hand-edit the list.
--
-- REGENERATING (only when the drift is large enough to be worth it)
--   sudo -u postgres pg_dump -d pf --schema-only --no-owner --no-privileges \
--     --no-comments -T public.fx_rates_legacy -T public.schema_migrations
-- then strip \restrict/\unrestrict, SET, SELECT pg_catalog.set_config and comment
-- lines, and refresh the version list below. Regenerating is NOT required for an
-- ordinary schema change — add a normal migration to scripts/migrations/ instead.
--
-- NO BEGIN/COMMIT — the runner wraps this file in a single transaction.
-- ─────────────────────────────────────────────────────────────────────────────

-- The ledger itself. The runners also create this; repeated here so the file is
-- self-contained if applied by hand.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.accounts (
    id integer NOT NULL,
    user_id text NOT NULL,
    type text NOT NULL,
    "group" text DEFAULT ''::text NOT NULL,
    currency text DEFAULT 'CAD'::text NOT NULL,
    note text DEFAULT ''::text,
    archived boolean DEFAULT false NOT NULL,
    name_ct text,
    name_lookup text,
    alias_ct text,
    alias_lookup text,
    is_investment boolean DEFAULT false NOT NULL,
    mode text DEFAULT 'manual'::text NOT NULL,
    ofx_payee_source text DEFAULT 'name'::text NOT NULL,
    csv_mapping_mode text DEFAULT 'confirm'::text NOT NULL,
    CONSTRAINT accounts_csv_mapping_mode_check CHECK ((csv_mapping_mode = ANY (ARRAY['confirm'::text, 'auto'::text]))),
    CONSTRAINT accounts_mode_check CHECK ((mode = ANY (ARRAY['auto'::text, 'approve'::text, 'manual'::text]))),
    CONSTRAINT accounts_ofx_payee_source_check CHECK ((ofx_payee_source = ANY (ARRAY['name'::text, 'memo'::text])))
);

CREATE SEQUENCE public.accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.accounts_id_seq OWNED BY public.accounts.id;

CREATE TABLE public.admin_audit (
    id integer NOT NULL,
    admin_user_id text NOT NULL,
    target_user_id text,
    action text NOT NULL,
    before_json text,
    after_json text,
    ip text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.admin_audit_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.admin_audit_id_seq OWNED BY public.admin_audit.id;

CREATE TABLE public.announcement_reads (
    user_id text NOT NULL,
    announcement_id integer NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.announcements (
    id integer NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    category text DEFAULT 'news'::text NOT NULL,
    severity text DEFAULT 'info'::text NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    published boolean DEFAULT false NOT NULL,
    published_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.announcements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.announcements_id_seq OWNED BY public.announcements.id;

CREATE TABLE public.api_keys (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    user_id text NOT NULL,
    key text NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);

CREATE TABLE public.backfill_audit (
    id integer NOT NULL,
    proposal_id integer NOT NULL,
    tx_id integer NOT NULL,
    before_json jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.backfill_audit_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.backfill_audit_id_seq OWNED BY public.backfill_audit.id;

CREATE TABLE public.backfill_proposals (
    id integer NOT NULL,
    run_id uuid NOT NULL,
    user_id text NOT NULL,
    proposal_kind text NOT NULL,
    confidence text NOT NULL,
    refusal_reason text,
    summary text NOT NULL,
    existing_row_ids integer[] NOT NULL,
    replacement_rows_json jsonb NOT NULL,
    synthesized_rows_json jsonb,
    deltas_json jsonb NOT NULL,
    depends_on_proposal_ids integer[] DEFAULT '{}'::integer[] NOT NULL,
    variant_choice text,
    status text DEFAULT 'pending'::text NOT NULL,
    applied_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    chosen_holding_id integer,
    candidate_holding_ids integer[] DEFAULT '{}'::integer[] NOT NULL,
    lot_action text,
    dividend_variant text,
    chosen_kind text,
    chosen_counterpart_tx_id integer,
    chosen_counterpart_mode text,
    chosen_related_holding_id integer,
    chosen_category_id integer,
    CONSTRAINT backfill_proposals_chosen_counterpart_mode_check CHECK (((chosen_counterpart_mode IS NULL) OR (chosen_counterpart_mode = ANY (ARRAY['link_existing'::text, 'synth_new'::text])))),
    CONSTRAINT backfill_proposals_chosen_kind_check CHECK (((chosen_kind IS NULL) OR (chosen_kind = ANY (ARRAY['opening_balance'::text, 'dividend'::text, 'interest'::text, 'portfolio_income'::text, 'portfolio_expense'::text, 'buy'::text, 'sell'::text, 'in_kind_transfer_in'::text, 'in_kind_transfer_out'::text, 'fx_from'::text, 'fx_to'::text, 'brokerage_deposit_in'::text, 'brokerage_deposit_out'::text, 'brokerage_withdrawal_in'::text, 'brokerage_withdrawal_out'::text])))),
    CONSTRAINT backfill_proposals_confidence_check CHECK ((confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text, 'refused'::text]))),
    CONSTRAINT backfill_proposals_dividend_variant_check CHECK (((dividend_variant IS NULL) OR (dividend_variant = ANY (ARRAY['cash_dividend'::text, 'drip'::text])))),
    CONSTRAINT backfill_proposals_lot_action_check CHECK (((lot_action IS NULL) OR (lot_action = ANY (ARRAY['open'::text, 'close'::text, 'transfer'::text])))),
    CONSTRAINT backfill_proposals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'applied'::text, 'undone'::text, 'refused_with_reason'::text]))),
    CONSTRAINT backfill_proposals_variant_choice_check CHECK (((variant_choice IS NULL) OR (variant_choice = ANY (ARRAY['separate_fee_row'::text, 'absorb_into_cost'::text]))))
);

CREATE SEQUENCE public.backfill_proposals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.backfill_proposals_id_seq OWNED BY public.backfill_proposals.id;

CREATE TABLE public.backfill_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    mode text NOT NULL,
    scope_filter jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'planning'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone,
    CONSTRAINT backfill_runs_mode_check CHECK ((mode = ANY (ARRAY['refuse_orphans'::text, 'synthesize_orphans'::text]))),
    CONSTRAINT backfill_runs_status_check CHECK ((status = ANY (ARRAY['planning'::text, 'ready'::text, 'applied'::text, 'partially_applied'::text, 'cancelled'::text, 'undone'::text])))
);

CREATE TABLE public.bank_daily_balances (
    user_id text NOT NULL,
    account_id integer NOT NULL,
    date text NOT NULL,
    balance double precision NOT NULL,
    currency text NOT NULL,
    source text NOT NULL,
    source_filenames text[] DEFAULT ARRAY[]::text[] NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    upload_batch_id uuid,
    CONSTRAINT bank_daily_balances_source_check CHECK ((source = ANY (ARRAY['csv_column'::text, 'ofx_ledgerbal'::text, 'upload_form'::text, 'email'::text, 'connector'::text, 'backup_restore'::text, 'mcp_manual'::text])))
);

CREATE TABLE public.bank_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    account_id integer NOT NULL,
    import_hash text NOT NULL,
    occurrence_index integer DEFAULT 0 NOT NULL,
    fit_id text,
    date text NOT NULL,
    amount double precision NOT NULL,
    currency text NOT NULL,
    entered_amount double precision,
    entered_currency text,
    entered_fx_rate double precision,
    quantity double precision,
    payee text NOT NULL,
    note text,
    tags text,
    account_name text,
    encryption_tier text DEFAULT 'service'::text NOT NULL,
    source text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    seen_count integer DEFAULT 1 NOT NULL,
    source_filenames text[] DEFAULT ARRAY[]::text[] NOT NULL,
    original_staged_import_id text,
    upload_batch_id uuid,
    ticker text,
    security_name text,
    CONSTRAINT bank_transactions_encryption_tier_check CHECK ((encryption_tier = ANY (ARRAY['service'::text, 'user'::text]))),
    CONSTRAINT bank_transactions_source_check CHECK ((source = ANY (ARRAY['import'::text, 'connector'::text, 'backup_restore'::text])))
);

CREATE TABLE public.bank_upload_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    account_id integer NOT NULL,
    template_id integer,
    source text NOT NULL,
    mode text NOT NULL,
    filename text,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    row_count integer DEFAULT 0 NOT NULL,
    anchor_count integer DEFAULT 0 NOT NULL,
    staged_import_id text,
    encryption_tier text DEFAULT 'service'::text NOT NULL,
    CONSTRAINT bank_upload_batches_encryption_tier_check CHECK ((encryption_tier = ANY (ARRAY['service'::text, 'user'::text]))),
    CONSTRAINT bank_upload_batches_mode_check CHECK ((mode = ANY (ARRAY['simplified'::text, 'detailed'::text]))),
    CONSTRAINT bank_upload_batches_source_check CHECK ((source = ANY (ARRAY['upload'::text, 'email'::text, 'connector'::text])))
);

CREATE TABLE public.budget_templates (
    id integer NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    category_id integer NOT NULL,
    amount double precision NOT NULL,
    created_at text NOT NULL
);

CREATE SEQUENCE public.budget_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.budget_templates_id_seq OWNED BY public.budget_templates.id;

CREATE TABLE public.budgets (
    id integer NOT NULL,
    user_id text NOT NULL,
    category_id integer NOT NULL,
    month text NOT NULL,
    amount double precision DEFAULT 0 NOT NULL,
    currency text DEFAULT 'CAD'::text NOT NULL
);

CREATE SEQUENCE public.budgets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.budgets_id_seq OWNED BY public.budgets.id;

CREATE TABLE public.categories (
    id integer NOT NULL,
    user_id text NOT NULL,
    type text NOT NULL,
    "group" text DEFAULT ''::text NOT NULL,
    note text DEFAULT ''::text,
    name_ct text,
    name_lookup text
);

CREATE SEQUENCE public.categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.categories_id_seq OWNED BY public.categories.id;

CREATE TABLE public.contribution_room (
    id integer NOT NULL,
    user_id text NOT NULL,
    type text NOT NULL,
    year integer NOT NULL,
    room double precision NOT NULL,
    used double precision DEFAULT 0,
    note text DEFAULT ''::text
);

CREATE SEQUENCE public.contribution_room_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.contribution_room_id_seq OWNED BY public.contribution_room.id;

CREATE TABLE public.custom_security_prices (
    id integer NOT NULL,
    user_id text NOT NULL,
    security_id integer NOT NULL,
    date text NOT NULL,
    price double precision NOT NULL,
    currency text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.custom_security_prices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.custom_security_prices_id_seq OWNED BY public.custom_security_prices.id;

CREATE TABLE public.diagnostics_log (
    id integer NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    kind text NOT NULL,
    duration_ms integer,
    source text,
    detail text,
    message text,
    code text,
    meta jsonb,
    op text,
    env text
);

CREATE SEQUENCE public.diagnostics_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.diagnostics_log_id_seq OWNED BY public.diagnostics_log.id;

CREATE TABLE public.email_import_rules (
    id integer NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    match_type text,
    match_op text,
    match_value text,
    account_id integer NOT NULL,
    category_id integer,
    mode text DEFAULT 'auto'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    flip_sign boolean DEFAULT false NOT NULL,
    date_source text DEFAULT 'parsed'::text NOT NULL,
    payee_override text,
    conditions jsonb,
    currency text,
    transfer_dest_account_id integer,
    CONSTRAINT email_import_rules_date_source_check CHECK ((date_source = ANY (ARRAY['parsed'::text, 'received'::text]))),
    CONSTRAINT email_import_rules_match_op_check CHECK ((match_op = ANY (ARRAY['contains'::text, 'exact'::text, 'regex'::text]))),
    CONSTRAINT email_import_rules_match_type_check CHECK ((match_type = ANY (ARRAY['sender'::text, 'subject'::text]))),
    CONSTRAINT email_import_rules_mode_check CHECK ((mode = ANY (ARRAY['auto'::text, 'review'::text])))
);

CREATE SEQUENCE public.email_import_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.email_import_rules_id_seq OWNED BY public.email_import_rules.id;

CREATE TABLE public.email_inbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    from_address text,
    subject text,
    body_text text,
    body_html text,
    encryption_tier text DEFAULT 'service'::text NOT NULL,
    message_id text,
    dedupe_key text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    action text DEFAULT 'pending'::text NOT NULL,
    source_kind text NOT NULL,
    staged_import_id text,
    matched_rule_id integer,
    parse_confidence text,
    recorded_transaction_id integer,
    CONSTRAINT email_inbox_action_check CHECK ((action = ANY (ARRAY['pending'::text, 'auto_recorded'::text, 'duplicate_skipped'::text, 'needs_review'::text, 'unparseable'::text, 'discarded'::text, 'manually_recorded'::text]))),
    CONSTRAINT email_inbox_encryption_tier_check CHECK ((encryption_tier = ANY (ARRAY['service'::text, 'user'::text]))),
    CONSTRAINT email_inbox_parse_confidence_check CHECK ((parse_confidence = ANY (ARRAY['high'::text, 'low'::text]))),
    CONSTRAINT email_inbox_source_kind_check CHECK ((source_kind = ANY (ARRAY['attachment'::text, 'body'::text])))
);

CREATE TABLE public.feedback (
    id integer NOT NULL,
    user_id text NOT NULL,
    type text DEFAULT 'other'::text NOT NULL,
    message text NOT NULL,
    page_url text,
    app_version text,
    status text DEFAULT 'new'::text NOT NULL,
    admin_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    user_last_read_at timestamp with time zone,
    admin_last_read_at timestamp with time zone,
    attachment_path text,
    attachment_filename text,
    attachment_mime text,
    attachment_size integer
);

CREATE SEQUENCE public.feedback_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.feedback_id_seq OWNED BY public.feedback.id;

CREATE TABLE public.feedback_messages (
    id integer NOT NULL,
    feedback_id integer NOT NULL,
    author_role text NOT NULL,
    author_id text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attachment_path text,
    attachment_filename text,
    attachment_mime text,
    attachment_size integer
);

CREATE SEQUENCE public.feedback_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.feedback_messages_id_seq OWNED BY public.feedback_messages.id;

CREATE TABLE public.fx_overrides (
    id integer NOT NULL,
    user_id text NOT NULL,
    currency text NOT NULL,
    date_from text NOT NULL,
    date_to text,
    rate_to_usd double precision NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.fx_overrides_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.fx_overrides_id_seq OWNED BY public.fx_overrides.id;

CREATE TABLE public.fx_rates (
    id integer NOT NULL,
    currency text NOT NULL,
    date text NOT NULL,
    rate_to_usd double precision NOT NULL,
    source text DEFAULT 'yahoo'::text NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.fx_rates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE SEQUENCE public.fx_rates_id_seq1
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.fx_rates_id_seq1 OWNED BY public.fx_rates.id;

CREATE TABLE public.goal_accounts (
    id integer NOT NULL,
    user_id text NOT NULL,
    goal_id integer NOT NULL,
    account_id integer NOT NULL
);

CREATE SEQUENCE public.goal_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.goal_accounts_id_seq OWNED BY public.goal_accounts.id;

CREATE TABLE public.goals (
    id integer NOT NULL,
    user_id text NOT NULL,
    type text NOT NULL,
    target_amount double precision NOT NULL,
    deadline text,
    account_id integer,
    priority integer DEFAULT 1,
    status text DEFAULT 'active'::text NOT NULL,
    note text DEFAULT ''::text,
    name_ct text,
    name_lookup text,
    currency text DEFAULT 'CAD'::text NOT NULL
);

CREATE SEQUENCE public.goals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.goals_id_seq OWNED BY public.goals.id;

CREATE TABLE public.holding_accounts (
    holding_id integer NOT NULL,
    account_id integer NOT NULL,
    user_id text NOT NULL,
    qty double precision DEFAULT 0 NOT NULL,
    cost_basis double precision DEFAULT 0 NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.holding_lot_closures (
    id integer NOT NULL,
    user_id text NOT NULL,
    lot_id integer NOT NULL,
    close_tx_id integer NOT NULL,
    close_date text NOT NULL,
    qty_closed double precision NOT NULL,
    proceeds_per_share double precision NOT NULL,
    cost_per_share double precision NOT NULL,
    realized_gain double precision NOT NULL,
    currency text NOT NULL,
    days_held integer NOT NULL,
    close_kind text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fx_to_usd_at_close double precision,
    CONSTRAINT holding_lot_closures_close_kind_check CHECK ((close_kind = ANY (ARRAY['sell'::text, 'transfer_out'::text, 'swap_out'::text, 'fx_conversion'::text, 'income_expense'::text, 'buy_sell'::text, 'short_open'::text, 'short_close'::text]))),
    CONSTRAINT holding_lot_closures_qty_closed_check CHECK ((qty_closed > (0)::double precision))
);

CREATE SEQUENCE public.holding_lot_closures_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.holding_lot_closures_id_seq OWNED BY public.holding_lot_closures.id;

CREATE TABLE public.holding_lots (
    id integer NOT NULL,
    user_id text NOT NULL,
    holding_id integer NOT NULL,
    account_id integer NOT NULL,
    open_tx_id integer NOT NULL,
    open_date text NOT NULL,
    qty_original double precision NOT NULL,
    qty_remaining double precision NOT NULL,
    cost_per_share double precision NOT NULL,
    currency text NOT NULL,
    fx_to_usd_at_open double precision,
    origin text NOT NULL,
    parent_lot_id integer,
    status text DEFAULT 'open'::text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    side text DEFAULT 'long'::text NOT NULL,
    CONSTRAINT holding_lots_check CHECK (((qty_remaining >= (0)::double precision) AND (qty_remaining <= qty_original))),
    CONSTRAINT holding_lots_origin_check CHECK ((origin = ANY (ARRAY['buy'::text, 'reinvest_div'::text, 'transfer_in'::text, 'split_adj'::text, 'backfill'::text]))),
    CONSTRAINT holding_lots_qty_original_check CHECK ((qty_original > (0)::double precision)),
    CONSTRAINT holding_lots_side_check CHECK ((side = ANY (ARRAY['long'::text, 'short'::text]))),
    CONSTRAINT holding_lots_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text, 'transferred_out'::text])))
);

CREATE SEQUENCE public.holding_lots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.holding_lots_id_seq OWNED BY public.holding_lots.id;

CREATE TABLE public.import_templates (
    id integer NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    file_headers text NOT NULL,
    column_mapping text NOT NULL,
    default_account text,
    is_default integer DEFAULT 0 NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    skip_header_rows integer DEFAULT 0 NOT NULL,
    skip_footer_rows integer DEFAULT 0 NOT NULL,
    date_format_override text,
    default_currency text,
    import_mode text DEFAULT 'detailed'::text NOT NULL,
    CONSTRAINT import_templates_date_format_override_check CHECK (((date_format_override IS NULL) OR (date_format_override = ANY (ARRAY['DD/MM/YYYY'::text, 'MM/DD/YYYY'::text, 'YYYY-MM-DD'::text])))),
    CONSTRAINT import_templates_mode_check CHECK ((import_mode = ANY (ARRAY['simplified'::text, 'detailed'::text]))),
    CONSTRAINT import_templates_skip_footer_rows_check CHECK ((skip_footer_rows >= 0)),
    CONSTRAINT import_templates_skip_header_rows_check CHECK ((skip_header_rows >= 0))
);

CREATE SEQUENCE public.import_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.import_templates_id_seq OWNED BY public.import_templates.id;

CREATE TABLE public.incoming_email_replies (
    id text NOT NULL,
    incoming_email_id text NOT NULL,
    to_address text NOT NULL,
    from_address text NOT NULL,
    subject text,
    body text NOT NULL,
    sent_by text,
    resend_id text,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.incoming_emails (
    id text NOT NULL,
    category text NOT NULL,
    to_address text NOT NULL,
    from_address text NOT NULL,
    subject text,
    body_text text,
    body_html text,
    attachment_count integer DEFAULT 0 NOT NULL,
    svix_id text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    triaged_at timestamp with time zone,
    triaged_by text
);

CREATE TABLE public.loans (
    id integer NOT NULL,
    user_id text NOT NULL,
    type text NOT NULL,
    account_id integer,
    principal double precision NOT NULL,
    annual_rate double precision NOT NULL,
    term_months integer,
    start_date text NOT NULL,
    payment_amount double precision,
    payment_frequency text DEFAULT 'monthly'::text NOT NULL,
    extra_payment double precision DEFAULT 0,
    note text DEFAULT ''::text,
    name_ct text,
    name_lookup text,
    currency text DEFAULT 'CAD'::text NOT NULL,
    residual_value double precision
);

CREATE SEQUENCE public.loans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.loans_id_seq OWNED BY public.loans.id;

CREATE TABLE public.mcp_idempotency_keys (
    id integer NOT NULL,
    user_id text NOT NULL,
    key uuid NOT NULL,
    tool_name text NOT NULL,
    response_json jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.mcp_idempotency_keys_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.mcp_idempotency_keys_id_seq OWNED BY public.mcp_idempotency_keys.id;

CREATE TABLE public.notifications (
    id integer NOT NULL,
    user_id text NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    read integer DEFAULT 0 NOT NULL,
    created_at text NOT NULL,
    metadata text DEFAULT ''::text
);

CREATE SEQUENCE public.notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;

CREATE TABLE public.oauth_access_tokens (
    id integer NOT NULL,
    user_id text NOT NULL,
    token text NOT NULL,
    refresh_token text NOT NULL,
    client_id text NOT NULL,
    expires_at text NOT NULL,
    refresh_expires_at text NOT NULL,
    created_at text NOT NULL,
    dek_wrapped text,
    revoked_at timestamp with time zone,
    dek_wrapped_refresh text,
    scope text DEFAULT 'mcp:read mcp:write'::text NOT NULL,
    last_used_at timestamp with time zone
);

CREATE SEQUENCE public.oauth_access_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.oauth_access_tokens_id_seq OWNED BY public.oauth_access_tokens.id;

CREATE TABLE public.oauth_authorization_codes (
    id integer NOT NULL,
    user_id text NOT NULL,
    code text NOT NULL,
    code_challenge text NOT NULL,
    code_challenge_method text DEFAULT 'S256'::text NOT NULL,
    redirect_uri text NOT NULL,
    client_id text NOT NULL,
    expires_at text NOT NULL,
    used integer DEFAULT 0 NOT NULL,
    created_at text NOT NULL,
    dek_wrapped text,
    scope text DEFAULT 'mcp:read mcp:write'::text NOT NULL
);

CREATE SEQUENCE public.oauth_authorization_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.oauth_authorization_codes_id_seq OWNED BY public.oauth_authorization_codes.id;

CREATE TABLE public.oauth_clients (
    id integer NOT NULL,
    client_id text NOT NULL,
    client_name text,
    redirect_uris text DEFAULT '[]'::text,
    grant_types text DEFAULT '["authorization_code"]'::text,
    response_types text DEFAULT '["code"]'::text,
    token_endpoint_auth_method text DEFAULT 'none'::text,
    created_at text NOT NULL
);

CREATE SEQUENCE public.oauth_clients_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.oauth_clients_id_seq OWNED BY public.oauth_clients.id;

CREATE TABLE public.op_rollup (
    op text NOT NULL,
    bucket timestamp with time zone NOT NULL,
    count bigint DEFAULT 0 NOT NULL,
    total_ms bigint DEFAULT 0 NOT NULL,
    slow_count bigint DEFAULT 0 NOT NULL,
    error_count bigint DEFAULT 0 NOT NULL
);

CREATE TABLE public.password_reset_tokens (
    id integer NOT NULL,
    user_id text NOT NULL,
    token_hash text NOT NULL,
    expires_at text NOT NULL,
    used_at text,
    created_at text NOT NULL
);

CREATE SEQUENCE public.password_reset_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.password_reset_tokens_id_seq OWNED BY public.password_reset_tokens.id;

CREATE TABLE public.portfolio_cash_snapshot_dirty (
    user_id text NOT NULL,
    account_id integer NOT NULL,
    from_date text NOT NULL,
    marked_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.portfolio_cash_snapshot_meta (
    user_id text NOT NULL,
    tx_max_updated timestamp with time zone,
    tx_count integer DEFAULT 0 NOT NULL,
    built_through text,
    built_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.portfolio_holdings (
    id integer NOT NULL,
    user_id text NOT NULL,
    account_id integer,
    currency text DEFAULT 'CAD'::text NOT NULL,
    is_crypto integer DEFAULT 0,
    note text DEFAULT ''::text,
    name_ct text,
    name_lookup text,
    symbol_ct text,
    symbol_lookup text,
    is_cash boolean DEFAULT false NOT NULL,
    security_id integer
);

CREATE SEQUENCE public.portfolio_holdings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.portfolio_holdings_id_seq OWNED BY public.portfolio_holdings.id;

CREATE TABLE public.portfolio_legacy_realized_gain_snapshot (
    user_id text NOT NULL,
    holding_id integer NOT NULL,
    account_id integer NOT NULL,
    avg_cost_realized double precision NOT NULL,
    currency text NOT NULL,
    snapped_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.portfolio_lots_status (
    user_id text NOT NULL,
    backfill_done boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    backfilled_at timestamp with time zone,
    notes text DEFAULT ''::text NOT NULL
);

CREATE TABLE public.portfolio_snapshot_dirty (
    user_id text NOT NULL,
    from_date text NOT NULL,
    marked_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.portfolio_snapshots (
    id integer NOT NULL,
    user_id text NOT NULL,
    snap_date text NOT NULL,
    account_id integer,
    market_value double precision NOT NULL,
    cost_basis double precision NOT NULL,
    net_contribution double precision DEFAULT 0 NOT NULL,
    currency text NOT NULL,
    gaps_filled boolean DEFAULT false NOT NULL,
    source text DEFAULT 'cron'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.portfolio_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.portfolio_snapshots_id_seq OWNED BY public.portfolio_snapshots.id;

CREATE TABLE public.price_cache (
    id integer NOT NULL,
    symbol text NOT NULL,
    date text NOT NULL,
    price double precision NOT NULL,
    currency text NOT NULL,
    previous_close double precision,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.price_cache_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.price_cache_id_seq OWNED BY public.price_cache.id;

CREATE TABLE public.recurring_transactions (
    id integer NOT NULL,
    user_id text NOT NULL,
    payee text NOT NULL,
    amount double precision NOT NULL,
    frequency text NOT NULL,
    category_id integer,
    account_id integer,
    next_date text,
    active integer DEFAULT 1 NOT NULL,
    note text DEFAULT ''::text
);

CREATE SEQUENCE public.recurring_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.recurring_transactions_id_seq OWNED BY public.recurring_transactions.id;

CREATE TABLE public.reporting_recompute_status (
    user_id text NOT NULL,
    target_currency text NOT NULL,
    total integer DEFAULT 0 NOT NULL,
    done integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);

CREATE TABLE public.revoked_jtis (
    jti text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE public.securities (
    id integer NOT NULL,
    user_id text NOT NULL,
    cluster_key text NOT NULL,
    asset_type text NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    is_cash boolean DEFAULT false NOT NULL,
    is_crypto integer DEFAULT 0,
    symbol_ct text,
    symbol_lookup text,
    name_ct text,
    name_lookup text,
    image text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    price_source text DEFAULT 'auto'::text NOT NULL,
    CONSTRAINT securities_price_source_check CHECK ((price_source = ANY (ARRAY['auto'::text, 'manual'::text])))
);

CREATE SEQUENCE public.securities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.securities_id_seq OWNED BY public.securities.id;

CREATE TABLE public.settings (
    key text NOT NULL,
    user_id text NOT NULL,
    value text NOT NULL
);

CREATE TABLE public.simplefin_pending_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    account_id integer,
    external_account_id text NOT NULL,
    fit_id text NOT NULL,
    date text DEFAULT ''::text NOT NULL,
    amount double precision NOT NULL,
    currency text NOT NULL,
    payee text,
    description text,
    encryption_tier text DEFAULT 'user'::text NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.snapshots (
    id integer NOT NULL,
    user_id text NOT NULL,
    account_id integer,
    date text NOT NULL,
    value double precision NOT NULL,
    note text DEFAULT ''::text
);

CREATE SEQUENCE public.snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.snapshots_id_seq OWNED BY public.snapshots.id;

CREATE TABLE public.staged_imports (
    id text NOT NULL,
    user_id text NOT NULL,
    source text NOT NULL,
    from_address text,
    subject text,
    svix_id text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    total_row_count integer DEFAULT 0 NOT NULL,
    duplicate_count integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    statement_balance double precision,
    statement_balance_date text,
    statement_currency text,
    statement_period_start text,
    statement_period_end text,
    bound_account_id integer,
    file_format text,
    original_filename text,
    skip_header_rows integer DEFAULT 0 NOT NULL,
    skip_footer_rows integer DEFAULT 0 NOT NULL,
    date_format_override text,
    default_currency text,
    date_range_start text,
    date_range_end text,
    parsed_anchors jsonb,
    headers jsonb,
    sample_rows jsonb,
    encryption_tier text DEFAULT 'service'::text NOT NULL,
    content_hash text,
    CONSTRAINT staged_imports_date_format_override_check CHECK (((date_format_override IS NULL) OR (date_format_override = ANY (ARRAY['DD/MM/YYYY'::text, 'MM/DD/YYYY'::text, 'YYYY-MM-DD'::text])))),
    CONSTRAINT staged_imports_encryption_tier_check CHECK ((encryption_tier = ANY (ARRAY['service'::text, 'user'::text]))),
    CONSTRAINT staged_imports_skip_footer_rows_check CHECK ((skip_footer_rows >= 0)),
    CONSTRAINT staged_imports_skip_header_rows_check CHECK ((skip_header_rows >= 0))
);

CREATE TABLE public.staged_transactions (
    id text NOT NULL,
    staged_import_id text NOT NULL,
    user_id text NOT NULL,
    date text NOT NULL,
    amount double precision NOT NULL,
    currency text DEFAULT 'CAD'::text,
    payee text,
    category text,
    account_name text,
    note text,
    row_index integer NOT NULL,
    is_duplicate boolean DEFAULT false NOT NULL,
    import_hash text NOT NULL,
    encryption_tier text DEFAULT 'service'::text NOT NULL,
    tx_type text DEFAULT 'E'::text NOT NULL,
    quantity double precision,
    portfolio_holding_id integer,
    entered_amount double precision,
    entered_currency text,
    tags text,
    fit_id text,
    peer_staged_id text,
    target_account_id integer,
    dedup_status text DEFAULT 'new'::text NOT NULL,
    row_status text DEFAULT 'pending'::text NOT NULL,
    reconcile_state text DEFAULT 'unmatched'::text NOT NULL,
    linked_transaction_id integer,
    ticker text,
    security_name text,
    CONSTRAINT staged_transactions_dedup_status_check CHECK ((dedup_status = ANY (ARRAY['new'::text, 'existing'::text, 'probable_duplicate'::text]))),
    CONSTRAINT staged_transactions_encryption_tier_check CHECK ((encryption_tier = ANY (ARRAY['service'::text, 'user'::text]))),
    CONSTRAINT staged_transactions_reconcile_state_check CHECK ((reconcile_state = ANY (ARRAY['unmatched'::text, 'auto_suggested'::text, 'linked'::text, 'skipped_duplicate'::text]))),
    CONSTRAINT staged_transactions_row_status_check CHECK ((row_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT staged_transactions_tx_type_check CHECK ((tx_type = ANY (ARRAY['E'::text, 'I'::text, 'R'::text])))
);

CREATE TABLE public.subscriptions (
    id integer NOT NULL,
    user_id text NOT NULL,
    amount double precision NOT NULL,
    currency text DEFAULT 'CAD'::text NOT NULL,
    frequency text DEFAULT 'monthly'::text NOT NULL,
    category_id integer,
    account_id integer,
    next_date text,
    status text DEFAULT 'active'::text NOT NULL,
    cancel_reminder_date text,
    notes text,
    name_ct text,
    name_lookup text
);

CREATE SEQUENCE public.subscriptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.subscriptions_id_seq OWNED BY public.subscriptions.id;

CREATE TABLE public.system_metrics_sample (
    id integer NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    cpu_pct real,
    load1 real,
    proc_cpu_pct real,
    mem_used_mb integer,
    mem_total_mb integer
);

CREATE SEQUENCE public.system_metrics_sample_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.system_metrics_sample_id_seq OWNED BY public.system_metrics_sample.id;

CREATE TABLE public.target_allocations (
    id integer NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    target_pct double precision NOT NULL,
    category text NOT NULL
);

CREATE SEQUENCE public.target_allocations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.target_allocations_id_seq OWNED BY public.target_allocations.id;

CREATE TABLE public.transaction_bank_links (
    id integer NOT NULL,
    user_id text NOT NULL,
    transaction_id integer NOT NULL,
    bank_transaction_id uuid NOT NULL,
    link_type text DEFAULT 'extra'::text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.transaction_bank_links_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.transaction_bank_links_id_seq OWNED BY public.transaction_bank_links.id;

CREATE TABLE public.transaction_reconciliation_flags (
    id uuid NOT NULL,
    transaction_id integer NOT NULL,
    user_id text NOT NULL,
    flag_kind text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT transaction_reconciliation_flags_flag_kind_check CHECK ((flag_kind = 'missing_from_statement'::text))
);

CREATE TABLE public.transaction_rules (
    id integer NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    created_at text NOT NULL,
    conditions jsonb NOT NULL,
    actions jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.transaction_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.transaction_rules_id_seq OWNED BY public.transaction_rules.id;

CREATE TABLE public.transaction_splits (
    id integer NOT NULL,
    transaction_id integer NOT NULL,
    category_id integer,
    amount double precision NOT NULL,
    note text DEFAULT ''::text,
    account_id integer,
    description text DEFAULT ''::text,
    tags text DEFAULT ''::text,
    entered_currency text,
    entered_amount double precision,
    entered_fx_rate double precision
);

CREATE SEQUENCE public.transaction_splits_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.transaction_splits_id_seq OWNED BY public.transaction_splits.id;

CREATE TABLE public.transactions (
    id integer NOT NULL,
    user_id text NOT NULL,
    date text NOT NULL,
    account_id integer,
    category_id integer,
    currency text DEFAULT 'CAD'::text NOT NULL,
    amount double precision DEFAULT 0 NOT NULL,
    quantity double precision,
    note text DEFAULT ''::text,
    payee text DEFAULT ''::text,
    tags text DEFAULT ''::text,
    is_business integer DEFAULT 0,
    import_hash text,
    fit_id text,
    link_id text,
    portfolio_holding_id integer,
    entered_currency text,
    entered_amount double precision,
    entered_fx_rate double precision,
    entered_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    trade_link_id text,
    bank_transaction_id uuid,
    kind text,
    related_holding_id integer,
    swap_link_id text,
    reporting_currency text,
    reporting_amount double precision,
    reporting_rate double precision,
    CONSTRAINT transactions_kind_check CHECK (((kind IS NULL) OR (kind = ANY (ARRAY['buy'::text, 'buy_cash_leg'::text, 'sell'::text, 'sell_cash_leg'::text, 'in_kind_transfer_in'::text, 'in_kind_transfer_out'::text, 'fx_from'::text, 'fx_to'::text, 'fx_fee'::text, 'portfolio_income'::text, 'portfolio_expense'::text, 'brokerage_deposit_out'::text, 'brokerage_deposit_in'::text, 'brokerage_withdrawal_out'::text, 'brokerage_withdrawal_in'::text, 'dividend'::text, 'interest'::text, 'opening_balance'::text, 'balance_adjustment'::text])))),
    CONSTRAINT transactions_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'import'::text, 'mcp_http'::text, 'mcp_stdio'::text, 'connector'::text, 'sample_data'::text, 'backup_restore'::text, 'reconcile_link'::text, 'backfill_synth'::text, 'auto_rule'::text])))
);

CREATE SEQUENCE public.transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.transactions_id_seq OWNED BY public.transactions.id;

CREATE TABLE public.tx_currency_audit (
    id integer NOT NULL,
    transaction_id integer NOT NULL,
    user_id text NOT NULL,
    account_currency text NOT NULL,
    recorded_currency text NOT NULL,
    recorded_amount double precision NOT NULL,
    flagged_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolution text
);

CREATE SEQUENCE public.tx_currency_audit_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.tx_currency_audit_id_seq OWNED BY public.tx_currency_audit.id;

CREATE TABLE public.users (
    id text NOT NULL,
    email text,
    password_hash text NOT NULL,
    display_name text,
    mfa_enabled integer DEFAULT 0 NOT NULL,
    mfa_secret text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    role text DEFAULT 'user'::text NOT NULL,
    email_verified integer DEFAULT 0 NOT NULL,
    email_verify_token text,
    onboarding_complete integer DEFAULT 0 NOT NULL,
    plan text DEFAULT 'free'::text NOT NULL,
    plan_expires_at text,
    stripe_customer_id text,
    login_count integer DEFAULT 0 NOT NULL,
    last_login_at text,
    kek_salt text,
    dek_wrapped text,
    dek_wrapped_iv text,
    dek_wrapped_tag text,
    encryption_v integer DEFAULT 1 NOT NULL,
    username text,
    plaintext_nulled_at text,
    portfolio_names_canonicalized_at text,
    pepper_version smallint DEFAULT 1 NOT NULL,
    last_active_at timestamp with time zone,
    securities_backfilled_at timestamp with time zone
);

CREATE TABLE public.webhook_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    webhook_id uuid NOT NULL,
    event text NOT NULL,
    payload_hash text NOT NULL,
    status_code integer,
    attempted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT webhook_deliveries_event_check CHECK ((event = ANY (ARRAY['transaction.created'::text, 'transaction.updated'::text, 'transaction.deleted'::text, 'transfer.created'::text, 'import.approved'::text])))
);

CREATE TABLE public.webhooks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    url text NOT NULL,
    secret text NOT NULL,
    event_filter text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_failed_at timestamp with time zone,
    CONSTRAINT webhooks_event_filter_check CHECK (((array_length(event_filter, 1) > 0) AND (event_filter <@ ARRAY['transaction.created'::text, 'transaction.updated'::text, 'transaction.deleted'::text, 'transfer.created'::text, 'import.approved'::text])))
);

ALTER TABLE ONLY public.accounts ALTER COLUMN id SET DEFAULT nextval('public.accounts_id_seq'::regclass);

ALTER TABLE ONLY public.admin_audit ALTER COLUMN id SET DEFAULT nextval('public.admin_audit_id_seq'::regclass);

ALTER TABLE ONLY public.announcements ALTER COLUMN id SET DEFAULT nextval('public.announcements_id_seq'::regclass);

ALTER TABLE ONLY public.backfill_audit ALTER COLUMN id SET DEFAULT nextval('public.backfill_audit_id_seq'::regclass);

ALTER TABLE ONLY public.backfill_proposals ALTER COLUMN id SET DEFAULT nextval('public.backfill_proposals_id_seq'::regclass);

ALTER TABLE ONLY public.budget_templates ALTER COLUMN id SET DEFAULT nextval('public.budget_templates_id_seq'::regclass);

ALTER TABLE ONLY public.budgets ALTER COLUMN id SET DEFAULT nextval('public.budgets_id_seq'::regclass);

ALTER TABLE ONLY public.categories ALTER COLUMN id SET DEFAULT nextval('public.categories_id_seq'::regclass);

ALTER TABLE ONLY public.contribution_room ALTER COLUMN id SET DEFAULT nextval('public.contribution_room_id_seq'::regclass);

ALTER TABLE ONLY public.custom_security_prices ALTER COLUMN id SET DEFAULT nextval('public.custom_security_prices_id_seq'::regclass);

ALTER TABLE ONLY public.diagnostics_log ALTER COLUMN id SET DEFAULT nextval('public.diagnostics_log_id_seq'::regclass);

ALTER TABLE ONLY public.email_import_rules ALTER COLUMN id SET DEFAULT nextval('public.email_import_rules_id_seq'::regclass);

ALTER TABLE ONLY public.feedback ALTER COLUMN id SET DEFAULT nextval('public.feedback_id_seq'::regclass);

ALTER TABLE ONLY public.feedback_messages ALTER COLUMN id SET DEFAULT nextval('public.feedback_messages_id_seq'::regclass);

ALTER TABLE ONLY public.fx_overrides ALTER COLUMN id SET DEFAULT nextval('public.fx_overrides_id_seq'::regclass);

ALTER TABLE ONLY public.fx_rates ALTER COLUMN id SET DEFAULT nextval('public.fx_rates_id_seq1'::regclass);

ALTER TABLE ONLY public.goal_accounts ALTER COLUMN id SET DEFAULT nextval('public.goal_accounts_id_seq'::regclass);

ALTER TABLE ONLY public.goals ALTER COLUMN id SET DEFAULT nextval('public.goals_id_seq'::regclass);

ALTER TABLE ONLY public.holding_lot_closures ALTER COLUMN id SET DEFAULT nextval('public.holding_lot_closures_id_seq'::regclass);

ALTER TABLE ONLY public.holding_lots ALTER COLUMN id SET DEFAULT nextval('public.holding_lots_id_seq'::regclass);

ALTER TABLE ONLY public.import_templates ALTER COLUMN id SET DEFAULT nextval('public.import_templates_id_seq'::regclass);

ALTER TABLE ONLY public.loans ALTER COLUMN id SET DEFAULT nextval('public.loans_id_seq'::regclass);

ALTER TABLE ONLY public.mcp_idempotency_keys ALTER COLUMN id SET DEFAULT nextval('public.mcp_idempotency_keys_id_seq'::regclass);

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);

ALTER TABLE ONLY public.oauth_access_tokens ALTER COLUMN id SET DEFAULT nextval('public.oauth_access_tokens_id_seq'::regclass);

ALTER TABLE ONLY public.oauth_authorization_codes ALTER COLUMN id SET DEFAULT nextval('public.oauth_authorization_codes_id_seq'::regclass);

ALTER TABLE ONLY public.oauth_clients ALTER COLUMN id SET DEFAULT nextval('public.oauth_clients_id_seq'::regclass);

ALTER TABLE ONLY public.password_reset_tokens ALTER COLUMN id SET DEFAULT nextval('public.password_reset_tokens_id_seq'::regclass);

ALTER TABLE ONLY public.portfolio_holdings ALTER COLUMN id SET DEFAULT nextval('public.portfolio_holdings_id_seq'::regclass);

ALTER TABLE ONLY public.portfolio_snapshots ALTER COLUMN id SET DEFAULT nextval('public.portfolio_snapshots_id_seq'::regclass);

ALTER TABLE ONLY public.price_cache ALTER COLUMN id SET DEFAULT nextval('public.price_cache_id_seq'::regclass);

ALTER TABLE ONLY public.recurring_transactions ALTER COLUMN id SET DEFAULT nextval('public.recurring_transactions_id_seq'::regclass);

ALTER TABLE ONLY public.securities ALTER COLUMN id SET DEFAULT nextval('public.securities_id_seq'::regclass);

ALTER TABLE ONLY public.snapshots ALTER COLUMN id SET DEFAULT nextval('public.snapshots_id_seq'::regclass);

ALTER TABLE ONLY public.subscriptions ALTER COLUMN id SET DEFAULT nextval('public.subscriptions_id_seq'::regclass);

ALTER TABLE ONLY public.system_metrics_sample ALTER COLUMN id SET DEFAULT nextval('public.system_metrics_sample_id_seq'::regclass);

ALTER TABLE ONLY public.target_allocations ALTER COLUMN id SET DEFAULT nextval('public.target_allocations_id_seq'::regclass);

ALTER TABLE ONLY public.transaction_bank_links ALTER COLUMN id SET DEFAULT nextval('public.transaction_bank_links_id_seq'::regclass);

ALTER TABLE ONLY public.transaction_rules ALTER COLUMN id SET DEFAULT nextval('public.transaction_rules_id_seq'::regclass);

ALTER TABLE ONLY public.transaction_splits ALTER COLUMN id SET DEFAULT nextval('public.transaction_splits_id_seq'::regclass);

ALTER TABLE ONLY public.transactions ALTER COLUMN id SET DEFAULT nextval('public.transactions_id_seq'::regclass);

ALTER TABLE ONLY public.tx_currency_audit ALTER COLUMN id SET DEFAULT nextval('public.tx_currency_audit_id_seq'::regclass);

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.admin_audit
    ADD CONSTRAINT admin_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.announcement_reads
    ADD CONSTRAINT announcement_reads_pkey PRIMARY KEY (user_id, announcement_id);

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_key UNIQUE (key);

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.backfill_audit
    ADD CONSTRAINT backfill_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.backfill_proposals
    ADD CONSTRAINT backfill_proposals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.backfill_runs
    ADD CONSTRAINT backfill_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.bank_daily_balances
    ADD CONSTRAINT bank_daily_balances_pkey PRIMARY KEY (user_id, account_id, date);

ALTER TABLE ONLY public.bank_transactions
    ADD CONSTRAINT bank_transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.bank_upload_batches
    ADD CONSTRAINT bank_upload_batches_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.budget_templates
    ADD CONSTRAINT budget_templates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.budgets
    ADD CONSTRAINT budgets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.contribution_room
    ADD CONSTRAINT contribution_room_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.custom_security_prices
    ADD CONSTRAINT custom_security_prices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.diagnostics_log
    ADD CONSTRAINT diagnostics_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.email_import_rules
    ADD CONSTRAINT email_import_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.email_inbox
    ADD CONSTRAINT email_inbox_dedupe_key_key UNIQUE (dedupe_key);

ALTER TABLE ONLY public.email_inbox
    ADD CONSTRAINT email_inbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.feedback_messages
    ADD CONSTRAINT feedback_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.feedback
    ADD CONSTRAINT feedback_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fx_overrides
    ADD CONSTRAINT fx_overrides_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fx_rates
    ADD CONSTRAINT fx_rates_currency_date_key UNIQUE (currency, date);

ALTER TABLE ONLY public.fx_rates
    ADD CONSTRAINT fx_rates_pkey1 PRIMARY KEY (id);

ALTER TABLE ONLY public.goal_accounts
    ADD CONSTRAINT goal_accounts_goal_id_account_id_user_id_key UNIQUE (goal_id, account_id, user_id);

ALTER TABLE ONLY public.goal_accounts
    ADD CONSTRAINT goal_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.goals
    ADD CONSTRAINT goals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.holding_accounts
    ADD CONSTRAINT holding_accounts_pkey PRIMARY KEY (holding_id, account_id);

ALTER TABLE ONLY public.holding_lot_closures
    ADD CONSTRAINT holding_lot_closures_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.holding_lots
    ADD CONSTRAINT holding_lots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.import_templates
    ADD CONSTRAINT import_templates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.incoming_email_replies
    ADD CONSTRAINT incoming_email_replies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.incoming_emails
    ADD CONSTRAINT incoming_emails_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.incoming_emails
    ADD CONSTRAINT incoming_emails_svix_id_key UNIQUE (svix_id);

ALTER TABLE ONLY public.loans
    ADD CONSTRAINT loans_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.mcp_idempotency_keys
    ADD CONSTRAINT mcp_idempotency_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_access_tokens
    ADD CONSTRAINT oauth_access_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_access_tokens
    ADD CONSTRAINT oauth_access_tokens_refresh_token_key UNIQUE (refresh_token);

ALTER TABLE ONLY public.oauth_access_tokens
    ADD CONSTRAINT oauth_access_tokens_token_key UNIQUE (token);

ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_code_key UNIQUE (code);

ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_client_id_key UNIQUE (client_id);

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.op_rollup
    ADD CONSTRAINT op_rollup_pkey PRIMARY KEY (op, bucket);

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.portfolio_cash_snapshot_dirty
    ADD CONSTRAINT portfolio_cash_snapshot_dirty_pkey PRIMARY KEY (user_id, account_id);

ALTER TABLE ONLY public.portfolio_cash_snapshot_meta
    ADD CONSTRAINT portfolio_cash_snapshot_meta_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public.portfolio_holdings
    ADD CONSTRAINT portfolio_holdings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.portfolio_legacy_realized_gain_snapshot
    ADD CONSTRAINT portfolio_legacy_realized_gain_snapshot_pkey PRIMARY KEY (user_id, holding_id, account_id);

ALTER TABLE ONLY public.portfolio_lots_status
    ADD CONSTRAINT portfolio_lots_status_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public.portfolio_snapshot_dirty
    ADD CONSTRAINT portfolio_snapshot_dirty_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public.portfolio_snapshots
    ADD CONSTRAINT portfolio_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.price_cache
    ADD CONSTRAINT price_cache_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.recurring_transactions
    ADD CONSTRAINT recurring_transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.reporting_recompute_status
    ADD CONSTRAINT reporting_recompute_status_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public.revoked_jtis
    ADD CONSTRAINT revoked_jtis_pkey PRIMARY KEY (jti);

ALTER TABLE ONLY public.securities
    ADD CONSTRAINT securities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key, user_id);

ALTER TABLE ONLY public.simplefin_pending_transactions
    ADD CONSTRAINT simplefin_pending_transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.snapshots
    ADD CONSTRAINT snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.staged_imports
    ADD CONSTRAINT staged_imports_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.staged_imports
    ADD CONSTRAINT staged_imports_svix_id_key UNIQUE (svix_id);

ALTER TABLE ONLY public.staged_transactions
    ADD CONSTRAINT staged_transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.system_metrics_sample
    ADD CONSTRAINT system_metrics_sample_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.target_allocations
    ADD CONSTRAINT target_allocations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.transaction_bank_links
    ADD CONSTRAINT transaction_bank_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.transaction_reconciliation_flags
    ADD CONSTRAINT transaction_reconciliation_flags_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.transaction_rules
    ADD CONSTRAINT transaction_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.transaction_splits
    ADD CONSTRAINT transaction_splits_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tx_currency_audit
    ADD CONSTRAINT tx_currency_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX accounts_user_name_lookup_uniq ON public.accounts USING btree (user_id, name_lookup);

CREATE INDEX admin_audit_admin_user_id_idx ON public.admin_audit USING btree (admin_user_id, created_at DESC);

CREATE INDEX admin_audit_target_user_id_idx ON public.admin_audit USING btree (target_user_id, created_at DESC);

CREATE INDEX announcement_reads_user_idx ON public.announcement_reads USING btree (user_id);

CREATE INDEX announcements_published_idx ON public.announcements USING btree (published, expires_at);

CREATE INDEX backfill_audit_proposal_idx ON public.backfill_audit USING btree (proposal_id);

CREATE INDEX backfill_proposals_chosen_counterpart_idx ON public.backfill_proposals USING btree (chosen_counterpart_tx_id) WHERE (chosen_counterpart_tx_id IS NOT NULL);

CREATE INDEX backfill_proposals_chosen_holding_idx ON public.backfill_proposals USING btree (chosen_holding_id) WHERE (chosen_holding_id IS NOT NULL);

CREATE INDEX backfill_proposals_run_status_idx ON public.backfill_proposals USING btree (run_id, status);

CREATE INDEX backfill_proposals_user_idx ON public.backfill_proposals USING btree (user_id);

CREATE INDEX backfill_runs_user_created_idx ON public.backfill_runs USING btree (user_id, created_at DESC);

CREATE INDEX bank_daily_balances_account_date_desc_idx ON public.bank_daily_balances USING btree (user_id, account_id, date DESC);

CREATE UNIQUE INDEX budgets_user_category_month_unique ON public.budgets USING btree (user_id, category_id, month);

CREATE UNIQUE INDEX categories_user_name_lookup_uniq ON public.categories USING btree (user_id, name_lookup);

CREATE UNIQUE INDEX contribution_room_user_type_year_unique ON public.contribution_room USING btree (user_id, type, year);

CREATE UNIQUE INDEX custom_security_prices_user_sec_date_idx ON public.custom_security_prices USING btree (user_id, security_id, date);

CREATE INDEX custom_security_prices_user_sec_idx ON public.custom_security_prices USING btree (user_id, security_id);

CREATE INDEX diagnostics_log_at_idx ON public.diagnostics_log USING btree (at);

CREATE INDEX diagnostics_log_kind_at_idx ON public.diagnostics_log USING btree (kind, at);

CREATE INDEX email_import_rules_user_active_idx ON public.email_import_rules USING btree (user_id, is_active, priority DESC);

CREATE INDEX email_inbox_user_action_idx ON public.email_inbox USING btree (user_id, action, received_at DESC);

CREATE INDEX feedback_messages_thread_idx ON public.feedback_messages USING btree (feedback_id, created_at);

CREATE INDEX feedback_status_idx ON public.feedback USING btree (status, created_at DESC);

CREATE INDEX feedback_user_idx ON public.feedback USING btree (user_id);

CREATE INDEX fx_overrides_user_currency_idx ON public.fx_overrides USING btree (user_id, currency, date_from);

CREATE INDEX fx_rates_currency_date_idx ON public.fx_rates USING btree (currency, date DESC);

CREATE INDEX goal_accounts_user_account ON public.goal_accounts USING btree (user_id, account_id);

CREATE INDEX goal_accounts_user_goal ON public.goal_accounts USING btree (user_id, goal_id);

CREATE UNIQUE INDEX goals_user_name_lookup_uniq ON public.goals USING btree (user_id, name_lookup);

CREATE UNIQUE INDEX holding_accounts_user_holding_idx ON public.holding_accounts USING btree (user_id, holding_id, account_id);

CREATE INDEX holding_lot_closures_close_tx_idx ON public.holding_lot_closures USING btree (close_tx_id);

CREATE INDEX holding_lot_closures_user_close_date_idx ON public.holding_lot_closures USING btree (user_id, close_date, lot_id);

CREATE INDEX holding_lots_open_tx_idx ON public.holding_lots USING btree (open_tx_id);

CREATE INDEX holding_lots_user_hold_acct_status_open_idx ON public.holding_lots USING btree (user_id, holding_id, account_id, status, open_date, id);

CREATE INDEX holding_lots_user_holding_acct_side_open_idx ON public.holding_lots USING btree (user_id, holding_id, account_id, side, status) WHERE (status = 'open'::text);

CREATE INDEX idx_accounts_user_id ON public.accounts USING btree (user_id);

CREATE INDEX idx_bank_daily_balances_upload_batch ON public.bank_daily_balances USING btree (upload_batch_id) WHERE (upload_batch_id IS NOT NULL);

CREATE INDEX idx_bank_transactions_upload_batch ON public.bank_transactions USING btree (upload_batch_id) WHERE (upload_batch_id IS NOT NULL);

CREATE INDEX idx_bank_tx_account_date ON public.bank_transactions USING btree (user_id, account_id, date DESC);

CREATE INDEX idx_bank_upload_batches_user_account_date ON public.bank_upload_batches USING btree (user_id, account_id, uploaded_at DESC);

CREATE INDEX idx_bank_upload_batches_user_tier ON public.bank_upload_batches USING btree (user_id, encryption_tier);

CREATE INDEX idx_budget_templates_user_id ON public.budget_templates USING btree (user_id);

CREATE INDEX idx_budgets_user_id ON public.budgets USING btree (user_id);

CREATE INDEX idx_categories_user_id ON public.categories USING btree (user_id);

CREATE INDEX idx_contribution_room_user_id ON public.contribution_room USING btree (user_id);

CREATE INDEX idx_goals_user_id ON public.goals USING btree (user_id);

CREATE INDEX idx_incoming_email_replies_email ON public.incoming_email_replies USING btree (incoming_email_id);

CREATE INDEX idx_incoming_email_replies_to ON public.incoming_email_replies USING btree (lower(to_address));

CREATE INDEX idx_incoming_emails_category_received ON public.incoming_emails USING btree (category, received_at DESC);

CREATE INDEX idx_incoming_emails_trash_expires ON public.incoming_emails USING btree (expires_at) WHERE (category = 'trash'::text);

CREATE INDEX idx_loans_user_id ON public.loans USING btree (user_id);

CREATE INDEX idx_notifications_user_id ON public.notifications USING btree (user_id);

CREATE INDEX idx_oauth_access_tokens_live ON public.oauth_access_tokens USING btree (token) WHERE (revoked_at IS NULL);

CREATE INDEX idx_oauth_clients_client_id ON public.oauth_clients USING btree (client_id);

CREATE INDEX idx_oauth_codes_code ON public.oauth_authorization_codes USING btree (code);

CREATE INDEX idx_oauth_tokens_refresh ON public.oauth_access_tokens USING btree (refresh_token);

CREATE INDEX idx_oauth_tokens_token ON public.oauth_access_tokens USING btree (token);

CREATE INDEX idx_portfolio_holdings_user_id ON public.portfolio_holdings USING btree (user_id);

CREATE INDEX idx_price_cache_symbol_date ON public.price_cache USING btree (symbol, date);

CREATE INDEX idx_recurring_transactions_user_id ON public.recurring_transactions USING btree (user_id);

CREATE INDEX idx_snapshots_user_id ON public.snapshots USING btree (user_id);

CREATE INDEX idx_staged_imports_expires_at ON public.staged_imports USING btree (expires_at) WHERE (status = 'pending'::text);

CREATE INDEX idx_staged_imports_user_status ON public.staged_imports USING btree (user_id, status);

CREATE INDEX idx_staged_imports_user_tier ON public.staged_imports USING btree (user_id, encryption_tier);

CREATE INDEX idx_staged_transactions_import ON public.staged_transactions USING btree (staged_import_id);

CREATE INDEX idx_staged_transactions_user ON public.staged_transactions USING btree (user_id);

CREATE INDEX idx_staged_tx_import_dedup ON public.staged_transactions USING btree (staged_import_id, dedup_status);

CREATE INDEX idx_staged_tx_user_row_status ON public.staged_transactions USING btree (user_id, row_status);

CREATE INDEX idx_staged_tx_user_tier ON public.staged_transactions USING btree (user_id, encryption_tier);

CREATE INDEX idx_subscriptions_user_id ON public.subscriptions USING btree (user_id);

CREATE INDEX idx_transaction_rules_user_id ON public.transaction_rules USING btree (user_id);

CREATE INDEX idx_transactions_bank_tx ON public.transactions USING btree (bank_transaction_id) WHERE (bank_transaction_id IS NOT NULL);

CREATE INDEX idx_transactions_link_id ON public.transactions USING btree (link_id) WHERE (link_id IS NOT NULL);

CREATE INDEX idx_transactions_trade_link_id ON public.transactions USING btree (user_id, trade_link_id) WHERE (trade_link_id IS NOT NULL);

CREATE INDEX idx_transactions_user_date ON public.transactions USING btree (user_id, date);

CREATE INDEX idx_transactions_user_id ON public.transactions USING btree (user_id);

CREATE INDEX idx_transactions_user_import_hash ON public.transactions USING btree (user_id, import_hash) WHERE (import_hash IS NOT NULL);

CREATE INDEX idx_tx_reconciliation_flags_user_tx ON public.transaction_reconciliation_flags USING btree (user_id, transaction_id);

CREATE INDEX idx_webhook_deliveries_webhook_id_attempted_at_desc ON public.webhook_deliveries USING btree (webhook_id, attempted_at DESC);

CREATE INDEX idx_webhooks_user_id ON public.webhooks USING btree (user_id);

CREATE INDEX idx_webhooks_user_id_created_at_desc ON public.webhooks USING btree (user_id, created_at DESC);

CREATE UNIQUE INDEX loans_user_name_lookup_uniq ON public.loans USING btree (user_id, name_lookup);

CREATE INDEX mcp_idempotency_keys_created_at_idx ON public.mcp_idempotency_keys USING btree (created_at);

CREATE UNIQUE INDEX mcp_idempotency_keys_user_id_key_unique ON public.mcp_idempotency_keys USING btree (user_id, key);

CREATE INDEX op_rollup_bucket_idx ON public.op_rollup USING btree (bucket);

CREATE UNIQUE INDEX portfolio_holdings_one_cash_per_account_currency ON public.portfolio_holdings USING btree (user_id, account_id, currency) WHERE (is_cash = true);

CREATE INDEX portfolio_holdings_security_idx ON public.portfolio_holdings USING btree (security_id);

CREATE UNIQUE INDEX portfolio_holdings_user_account_lookup_uniq ON public.portfolio_holdings USING btree (user_id, account_id, name_lookup) WHERE ((name_lookup IS NOT NULL) AND (account_id IS NOT NULL));

CREATE INDEX portfolio_holdings_user_name_lookup_idx ON public.portfolio_holdings USING btree (user_id, name_lookup) WHERE (name_lookup IS NOT NULL);

CREATE INDEX portfolio_holdings_user_symbol_lookup_idx ON public.portfolio_holdings USING btree (user_id, symbol_lookup) WHERE (symbol_lookup IS NOT NULL);

CREATE UNIQUE INDEX portfolio_snapshots_user_date_acct_idx ON public.portfolio_snapshots USING btree (user_id, snap_date, COALESCE(account_id, '-1'::integer));

CREATE INDEX portfolio_snapshots_user_date_idx ON public.portfolio_snapshots USING btree (user_id, snap_date);

CREATE INDEX revoked_jtis_expires_at_idx ON public.revoked_jtis USING btree (expires_at);

CREATE UNIQUE INDEX securities_user_cluster_idx ON public.securities USING btree (user_id, cluster_key);

CREATE INDEX securities_user_idx ON public.securities USING btree (user_id);

CREATE INDEX simplefin_pending_user_account_idx ON public.simplefin_pending_transactions USING btree (user_id, account_id);

CREATE INDEX staged_imports_user_hash_idx ON public.staged_imports USING btree (user_id, content_hash) WHERE (content_hash IS NOT NULL);

CREATE UNIQUE INDEX subscriptions_user_name_lookup_uniq ON public.subscriptions USING btree (user_id, name_lookup);

CREATE INDEX system_metrics_sample_at_idx ON public.system_metrics_sample USING btree (at);

CREATE UNIQUE INDEX target_allocations_user_name_unique ON public.target_allocations USING btree (user_id, name);

CREATE UNIQUE INDEX transaction_bank_links_pair_uq ON public.transaction_bank_links USING btree (transaction_id, bank_transaction_id);

CREATE INDEX transaction_bank_links_user_bank_idx ON public.transaction_bank_links USING btree (user_id, bank_transaction_id);

CREATE INDEX transaction_bank_links_user_tx_idx ON public.transaction_bank_links USING btree (user_id, transaction_id);

CREATE INDEX transaction_rules_user_active_priority_idx ON public.transaction_rules USING btree (user_id, is_active, priority DESC);

CREATE UNIQUE INDEX transactions_one_opening_balance_per_account ON public.transactions USING btree (user_id, account_id) WHERE (kind = 'opening_balance'::text);

CREATE INDEX transactions_related_holding_idx ON public.transactions USING btree (related_holding_id) WHERE (related_holding_id IS NOT NULL);

CREATE INDEX transactions_swap_link_id_idx ON public.transactions USING btree (swap_link_id) WHERE (swap_link_id IS NOT NULL);

CREATE INDEX transactions_user_created_at_idx ON public.transactions USING btree (user_id, created_at DESC);

CREATE INDEX transactions_user_kind_date_idx ON public.transactions USING btree (user_id, kind, date) WHERE (kind IS NOT NULL);

CREATE INDEX transactions_user_portfolio_holding_id_idx ON public.transactions USING btree (user_id, portfolio_holding_id) WHERE (portfolio_holding_id IS NOT NULL);

CREATE INDEX transactions_user_updated_at_idx ON public.transactions USING btree (user_id, updated_at DESC);

CREATE INDEX tx_currency_audit_user_unresolved_idx ON public.tx_currency_audit USING btree (user_id) WHERE (resolved_at IS NULL);

CREATE UNIQUE INDEX uq_bank_tx_fit ON public.bank_transactions USING btree (user_id, account_id, fit_id) WHERE (fit_id IS NOT NULL);

CREATE UNIQUE INDEX uq_bank_tx_hash ON public.bank_transactions USING btree (user_id, account_id, import_hash, occurrence_index);

CREATE UNIQUE INDEX users_email_lower_unique ON public.users USING btree (lower(email)) WHERE (email IS NOT NULL);

CREATE INDEX users_pepper_version_idx ON public.users USING btree (pepper_version) WHERE (pepper_version < 999);

CREATE UNIQUE INDEX users_username_lower_unique ON public.users USING btree (lower(username)) WHERE (username IS NOT NULL);

ALTER TABLE ONLY public.admin_audit
    ADD CONSTRAINT admin_audit_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.admin_audit
    ADD CONSTRAINT admin_audit_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.announcement_reads
    ADD CONSTRAINT announcement_reads_announcement_id_fkey FOREIGN KEY (announcement_id) REFERENCES public.announcements(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.backfill_audit
    ADD CONSTRAINT backfill_audit_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES public.backfill_proposals(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.backfill_proposals
    ADD CONSTRAINT backfill_proposals_chosen_category_id_fkey FOREIGN KEY (chosen_category_id) REFERENCES public.categories(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.backfill_proposals
    ADD CONSTRAINT backfill_proposals_chosen_counterpart_tx_id_fkey FOREIGN KEY (chosen_counterpart_tx_id) REFERENCES public.transactions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.backfill_proposals
    ADD CONSTRAINT backfill_proposals_chosen_related_holding_id_fkey FOREIGN KEY (chosen_related_holding_id) REFERENCES public.portfolio_holdings(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.backfill_proposals
    ADD CONSTRAINT backfill_proposals_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.backfill_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.backfill_proposals
    ADD CONSTRAINT backfill_proposals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.backfill_runs
    ADD CONSTRAINT backfill_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.bank_daily_balances
    ADD CONSTRAINT bank_daily_balances_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.bank_daily_balances
    ADD CONSTRAINT bank_daily_balances_upload_batch_id_fkey FOREIGN KEY (upload_batch_id) REFERENCES public.bank_upload_batches(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.bank_daily_balances
    ADD CONSTRAINT bank_daily_balances_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.bank_transactions
    ADD CONSTRAINT bank_transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.bank_transactions
    ADD CONSTRAINT bank_transactions_original_staged_import_id_fkey FOREIGN KEY (original_staged_import_id) REFERENCES public.staged_imports(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.bank_transactions
    ADD CONSTRAINT bank_transactions_upload_batch_id_fkey FOREIGN KEY (upload_batch_id) REFERENCES public.bank_upload_batches(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.bank_transactions
    ADD CONSTRAINT bank_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.bank_upload_batches
    ADD CONSTRAINT bank_upload_batches_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.bank_upload_batches
    ADD CONSTRAINT bank_upload_batches_staged_import_id_fkey FOREIGN KEY (staged_import_id) REFERENCES public.staged_imports(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.bank_upload_batches
    ADD CONSTRAINT bank_upload_batches_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.import_templates(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.bank_upload_batches
    ADD CONSTRAINT bank_upload_batches_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.budget_templates
    ADD CONSTRAINT budget_templates_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);

ALTER TABLE ONLY public.budgets
    ADD CONSTRAINT budgets_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);

ALTER TABLE ONLY public.custom_security_prices
    ADD CONSTRAINT custom_security_prices_security_id_fkey FOREIGN KEY (security_id) REFERENCES public.securities(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.email_import_rules
    ADD CONSTRAINT email_import_rules_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.email_import_rules
    ADD CONSTRAINT email_import_rules_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.email_import_rules
    ADD CONSTRAINT email_import_rules_transfer_dest_account_id_fkey FOREIGN KEY (transfer_dest_account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.email_import_rules
    ADD CONSTRAINT email_import_rules_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.email_inbox
    ADD CONSTRAINT email_inbox_matched_rule_fk FOREIGN KEY (matched_rule_id) REFERENCES public.email_import_rules(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.email_inbox
    ADD CONSTRAINT email_inbox_recorded_transaction_id_fkey FOREIGN KEY (recorded_transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.email_inbox
    ADD CONSTRAINT email_inbox_staged_import_id_fkey FOREIGN KEY (staged_import_id) REFERENCES public.staged_imports(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.email_inbox
    ADD CONSTRAINT email_inbox_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feedback_messages
    ADD CONSTRAINT feedback_messages_feedback_id_fkey FOREIGN KEY (feedback_id) REFERENCES public.feedback(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.goal_accounts
    ADD CONSTRAINT goal_accounts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.goal_accounts
    ADD CONSTRAINT goal_accounts_goal_id_fkey FOREIGN KEY (goal_id) REFERENCES public.goals(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.goals
    ADD CONSTRAINT goals_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);

ALTER TABLE ONLY public.holding_accounts
    ADD CONSTRAINT holding_accounts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.holding_accounts
    ADD CONSTRAINT holding_accounts_holding_id_fkey FOREIGN KEY (holding_id) REFERENCES public.portfolio_holdings(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.holding_lot_closures
    ADD CONSTRAINT holding_lot_closures_close_tx_id_fkey FOREIGN KEY (close_tx_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.holding_lot_closures
    ADD CONSTRAINT holding_lot_closures_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES public.holding_lots(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.holding_lots
    ADD CONSTRAINT holding_lots_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.holding_lots
    ADD CONSTRAINT holding_lots_holding_id_fkey FOREIGN KEY (holding_id) REFERENCES public.portfolio_holdings(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.holding_lots
    ADD CONSTRAINT holding_lots_open_tx_id_fkey FOREIGN KEY (open_tx_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.holding_lots
    ADD CONSTRAINT holding_lots_parent_lot_id_fkey FOREIGN KEY (parent_lot_id) REFERENCES public.holding_lots(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.incoming_email_replies
    ADD CONSTRAINT incoming_email_replies_incoming_email_id_fkey FOREIGN KEY (incoming_email_id) REFERENCES public.incoming_emails(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.incoming_email_replies
    ADD CONSTRAINT incoming_email_replies_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.incoming_emails
    ADD CONSTRAINT incoming_emails_triaged_by_fkey FOREIGN KEY (triaged_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.loans
    ADD CONSTRAINT loans_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);

ALTER TABLE ONLY public.oauth_access_tokens
    ADD CONSTRAINT oauth_access_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.portfolio_holdings
    ADD CONSTRAINT portfolio_holdings_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);

ALTER TABLE ONLY public.portfolio_holdings
    ADD CONSTRAINT portfolio_holdings_security_id_fkey FOREIGN KEY (security_id) REFERENCES public.securities(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.portfolio_snapshots
    ADD CONSTRAINT portfolio_snapshots_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.recurring_transactions
    ADD CONSTRAINT recurring_transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);

ALTER TABLE ONLY public.recurring_transactions
    ADD CONSTRAINT recurring_transactions_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);

ALTER TABLE ONLY public.simplefin_pending_transactions
    ADD CONSTRAINT simplefin_pending_transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.simplefin_pending_transactions
    ADD CONSTRAINT simplefin_pending_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.snapshots
    ADD CONSTRAINT snapshots_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);

ALTER TABLE ONLY public.staged_imports
    ADD CONSTRAINT staged_imports_bound_account_id_fkey FOREIGN KEY (bound_account_id) REFERENCES public.accounts(id);

ALTER TABLE ONLY public.staged_imports
    ADD CONSTRAINT staged_imports_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.staged_transactions
    ADD CONSTRAINT staged_transactions_linked_transaction_id_fkey FOREIGN KEY (linked_transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.staged_transactions
    ADD CONSTRAINT staged_transactions_peer_staged_id_fkey FOREIGN KEY (peer_staged_id) REFERENCES public.staged_transactions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.staged_transactions
    ADD CONSTRAINT staged_transactions_portfolio_holding_id_fkey FOREIGN KEY (portfolio_holding_id) REFERENCES public.portfolio_holdings(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.staged_transactions
    ADD CONSTRAINT staged_transactions_staged_import_id_fkey FOREIGN KEY (staged_import_id) REFERENCES public.staged_imports(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.staged_transactions
    ADD CONSTRAINT staged_transactions_target_account_id_fkey FOREIGN KEY (target_account_id) REFERENCES public.accounts(id);

ALTER TABLE ONLY public.staged_transactions
    ADD CONSTRAINT staged_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);

ALTER TABLE ONLY public.transaction_bank_links
    ADD CONSTRAINT transaction_bank_links_bank_transaction_id_fkey FOREIGN KEY (bank_transaction_id) REFERENCES public.bank_transactions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.transaction_bank_links
    ADD CONSTRAINT transaction_bank_links_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.transaction_reconciliation_flags
    ADD CONSTRAINT transaction_reconciliation_flags_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.transaction_reconciliation_flags
    ADD CONSTRAINT transaction_reconciliation_flags_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.transaction_splits
    ADD CONSTRAINT transaction_splits_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);

ALTER TABLE ONLY public.transaction_splits
    ADD CONSTRAINT transaction_splits_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);

ALTER TABLE ONLY public.transaction_splits
    ADD CONSTRAINT transaction_splits_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_bank_transaction_id_fkey FOREIGN KEY (bank_transaction_id) REFERENCES public.bank_transactions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_portfolio_holding_id_fkey FOREIGN KEY (portfolio_holding_id) REFERENCES public.portfolio_holdings(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_related_holding_id_fkey FOREIGN KEY (related_holding_id) REFERENCES public.portfolio_holdings(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.tx_currency_audit
    ADD CONSTRAINT tx_currency_audit_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_webhook_id_fkey FOREIGN KEY (webhook_id) REFERENCES public.webhooks(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Migrations subsumed by this baseline. Their effects are already present in the
-- DDL above, so record them as applied and let the normal loop skip them.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO schema_migrations (version) VALUES
  ('20260504_goals-multi-account'),
  ('20260506_staging_encryption_tier'),
  ('20260506_staging_unified_columns'),
  ('20260507_oauth_scopes'),
  ('20260507_pepper_version'),
  ('20260507_revoked_jtis'),
  ('20260509_fx-cache-purge-future-dates'),
  ('20260509_holding-accounts-backfill-orphans'),
  ('20260509c_categories-type-T-to-R'),
  ('20260510_data-fix-receipt-sign-and-fx-reval-rounding'),
  ('20260510_fx-cache-purge-pre-walkback'),
  ('20260518_transaction_rules_is_active_boolean'),
  ('20260520_finlynq-54-parser-knobs'),
  ('20260520_finlynq-55-reconcile-state'),
  ('20260520_finlynq-58-date-range-and-import-hash-index'),
  ('20260520_finlynq-60-webhooks'),
  ('20260522_bank-transactions-ledger'),
  ('20260522_price-cache-previous-close'),
  ('20260522_template-parser-knobs'),
  ('20260523_transaction-bank-links'),
  ('20260524_bank-daily-balances'),
  ('20260525_holding_lots_phase1'),
  ('20260525_import_modes_phase1'),
  ('20260525_portfolio_ops_phase1'),
  ('20260526_brokerage_deposit_withdrawal'),
  ('20260526_lot_side'),
  ('20260527_account_mode'),
  ('20260527_swap_link_id'),
  ('20260527_transactions_source_auto_rule'),
  ('20260528_staged_imports_headers'),
  ('20260528_user_base_currency_and_fx_close'),
  ('20260601_portfolio_snapshots_phase3'),
  ('20260602_backfill_pipeline'),
  ('20260603_opening_balance_kind'),
  ('20260604_backfill_dividend_reinvest'),
  ('20260604_import_field_mapping'),
  ('20260605_backfill_missing_lot'),
  ('20260606_tx_reporting_amount'),
  ('20260607_dividend_variant'),
  ('20260609_backfill_kind_override'),
  ('20260609_staging_metadata_encryption'),
  ('20260610_announcements'),
  ('20260610_feedback'),
  ('20260611_feedback_threads'),
  ('20260612_portfolio_snapshot_dirty'),
  ('20260613_cash_snapshot_meta'),
  ('20260614_backfill_chosen_category'),
  ('20260615_email_inbox'),
  ('20260616_email_rule_transforms'),
  ('20260617_email_rule_conditions'),
  ('20260618_email_rule_currency'),
  ('20260619_loans_v2'),
  ('20260620_user_last_active'),
  ('20260621_oauth_last_used'),
  ('20260622_securities_phase_a'),
  ('20260623_email_rule_transfer'),
  ('20260624_import_investment_fields'),
  ('20260625_price_cache_fetched_at'),
  ('20260625b_balance_anchor_mcp_source'),
  ('20260626_feedback_attachment'),
  ('20260626b_feedback_message_attachment'),
  ('20260626c_diagnostics_log'),
  ('20260626d_diagnostics_phase2'),
  ('20260627_opening_balance_unique'),
  ('20260628_custom_security_prices'),
  ('20260628_portfolio_cash_snapshot_dirty'),
  ('20260701_simplefin_pending_transactions'),
  ('20260711_incoming_email_replies'),
  ('20260711_staged_import_content_hash'),
  ('20260721_drop_mcp_uploads')
ON CONFLICT (version) DO NOTHING;
