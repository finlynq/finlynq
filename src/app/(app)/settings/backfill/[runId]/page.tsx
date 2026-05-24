"use client";

/**
 * /settings/backfill/[runId] — two-pane review for a backfill run.
 *
 * Left pane: proposal list with confidence chips + summary
 * Right pane: detail view of selected proposal
 *   - displaced rows → replacement rows
 *   - drift proposals: two-radio variant picker
 *   - dependency callout if a dependent is checked without parents
 *
 * Live feature doc: pf-app/docs/architecture/backfill.md.
 */

import { useState, useEffect, useMemo, use } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Undo2 } from "lucide-react";

interface Proposal {
  id: number;
  runId: string;
  proposalKind: string;
  confidence: "high" | "medium" | "low" | "refused";
  refusalReason: string | null;
  summary: string;
  existingRowIds: number[];
  // For non-drift: ReplacementRow[]; for drift: { separate_fee_row: DriftVariant; absorb_into_cost: DriftVariant }
  replacementRowsJson: unknown;
  synthesizedRowsJson: unknown;
  deltasJson: { balance: number; lots: Array<{ holdingId: number; qtyDelta: number }>; realizedGainBase: number | null };
  dependsOnProposalIds: number[];
  variantChoice: "separate_fee_row" | "absorb_into_cost" | null;
  status: string;
}

interface Coverage {
  accountCount: number;
  totalTxs: number;
  canonicalTxs: number;
  nonCanonicalTxs: number;
  canonicalPct: number;
  perAccount: Array<{ accountId: number; name: string; total: number; canonical: number; pending: number; pendingPct: number }>;
}

interface DisplacedRow {
  id: number;
  date: string;
  accountId: number | null;
  portfolioHoldingId: number | null;
  amount: number;
  currency: string;
  quantity: number | null;
  kind: string | null;
  tradeLinkId: string | null;
  linkId: string | null;
}

interface HoldingMeta { name: string | null; isCash: boolean; currency: string }
interface AccountMeta { name: string | null; currency: string }

const REFUSAL_EXPLANATIONS: Record<string, string> = {
  no_cash_pair_found:
    "No cash-sleeve row with matching amount on the same date in this account. If this brokerage's cash is tracked elsewhere, leave this proposal — manually record the matching cash debit/credit in /transactions, then re-run. If you don't track this brokerage's cash in Finlynq, start a new run in 'synthesize_orphans' mode.",
  cross_currency_trade:
    "Stock leg and cash leg are in different currencies — Phase 2 canonical shape requires same-currency pairs. Record an FX Conversion first (CAD↔USD whichever way), then re-run.",
  combined_cash_leg:
    "Multiple stock legs share one cash row. Phase 2 only supports 1:1 pairs. Split the combined cash row into per-trade rows in /transactions first.",
  ambiguous_cash_candidates:
    "More than one cash-sleeve row matches the stock leg by date+amount. Disambiguate in /transactions (delete or edit the wrong candidate), then re-run.",
  no_cash_sleeve_to_synthesize_into:
    "Synthesize mode needs a cash sleeve in the matching currency on this account, but none exists. Create one from the account detail page first.",
};

export default function BackfillReviewPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const router = useRouter();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [displacedRows, setDisplacedRows] = useState<Record<number, DisplacedRow>>({});
  const [holdingMap, setHoldingMap] = useState<Record<number, HoldingMeta>>({});
  const [accountMap, setAccountMap] = useState<Record<number, AccountMeta>>({});
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string>("");
  const [info, setInfo] = useState<string>("");

  async function loadProposals() {
    setLoading(true);
    try {
      const res = await fetch(`/api/settings/backfill/${runId}`);
      const data = await res.json();
      setProposals(data.proposals ?? []);
      const rowsById: Record<number, DisplacedRow> = {};
      for (const r of (data.displacedRows ?? []) as DisplacedRow[]) rowsById[r.id] = r;
      setDisplacedRows(rowsById);
      setHoldingMap(data.holdingMap ?? {});
      setAccountMap(data.accountMap ?? {});
      if ((data.proposals ?? []).length > 0 && selectedId == null) {
        setSelectedId(data.proposals[0].id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load proposals");
    }
    setLoading(false);
  }

  useEffect(() => { loadProposals(); }, [runId]);

  useEffect(() => {
    fetch(`/api/settings/backfill/coverage`)
      .then((r) => r.ok ? r.json() : null)
      .then((data: Coverage | null) => { if (data) setCoverage(data); })
      .catch(() => setCoverage(null));
  }, [runId, proposals]); // refetch after proposals change (post-apply)

  async function updateProposal(proposalId: number, patch: { status?: string; variantChoice?: string | null }) {
    setError("");
    const res = await fetch(`/api/settings/backfill/${runId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposalId, ...patch }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setError(err?.error ?? `HTTP ${res.status}`);
      return false;
    }
    await loadProposals();
    return true;
  }

  async function applyAll() {
    setApplying(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch(`/api/settings/backfill/${runId}/apply`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.failed?.message ?? data?.error ?? `HTTP ${res.status}`);
      } else {
        setInfo(`Applied ${data.applied.length} proposal(s).`);
      }
      await loadProposals();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Apply failed");
    }
    setApplying(false);
  }

  async function undoProposal(proposalId: number) {
    setError("");
    setInfo("");
    const res = await fetch(`/api/settings/backfill/${runId}/undo/${proposalId}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      setError(data?.message ?? data?.error ?? `HTTP ${res.status}`);
    } else {
      setInfo(`Undone proposal #${proposalId}.`);
    }
    await loadProposals();
  }

  const selected = useMemo(() => proposals.find((p) => p.id === selectedId) ?? null, [proposals, selectedId]);
  const approvedCount = proposals.filter((p) => p.status === "approved").length;
  const appliedCount = proposals.filter((p) => p.status === "applied").length;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Backfill review</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {proposals.length} proposal(s) · {approvedCount} approved · {appliedCount} applied
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => router.push("/settings/backfill")}>
            <RefreshCw className="size-4 mr-2" /> New run
          </Button>
          <Button onClick={applyAll} disabled={applying || approvedCount === 0}>
            {applying ? (<><Loader2 className="size-4 animate-spin mr-2" /> Applying…</>) : `Apply ${approvedCount} approved`}
          </Button>
        </div>
      </div>

      {error && <div className="border border-destructive bg-destructive/10 text-destructive rounded p-3 text-sm">{error}</div>}
      {info && <div className="border border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 rounded p-3 text-sm flex items-center gap-2"><CheckCircle2 className="size-4" /> {info}</div>}

      {coverage && <CoverageDashboard coverage={coverage} proposals={proposals} />}

      {loading && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>}

      {!loading && proposals.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No proposals — your ledger appears already canonical. Great!
          </CardContent>
        </Card>
      )}

      {!loading && proposals.length > 0 && (
        <div className="grid grid-cols-12 gap-4">
          {/* LEFT: proposal list */}
          <div className="col-span-5 space-y-2 max-h-[70vh] overflow-y-auto pr-2">
            {proposals.map((p) => (
              <ProposalCard
                key={p.id}
                proposal={p}
                selected={p.id === selectedId}
                onSelect={() => setSelectedId(p.id)}
                onToggleApprove={() => updateProposal(p.id, { status: p.status === "approved" ? "pending" : "approved" })}
              />
            ))}
          </div>

          {/* RIGHT: detail */}
          <div className="col-span-7">
            {selected ? (
              <ProposalDetail
                proposal={selected}
                displacedRows={displacedRows}
                holdingMap={holdingMap}
                accountMap={accountMap}
                onVariantChange={(v) => updateProposal(selected.id, { variantChoice: v })}
                onApprove={() => updateProposal(selected.id, { status: "approved" })}
                onReject={() => updateProposal(selected.id, { status: "rejected" })}
                onUndo={() => undoProposal(selected.id)}
              />
            ) : (
              <Card><CardContent className="py-8 text-center text-muted-foreground">Select a proposal to view detail.</CardContent></Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ProposalCard({
  proposal,
  selected,
  onSelect,
  onToggleApprove,
}: {
  proposal: Proposal;
  selected: boolean;
  onSelect: () => void;
  onToggleApprove: () => void;
}) {
  const isApproved = proposal.status === "approved";
  const isApplied = proposal.status === "applied";
  const isRefused = proposal.confidence === "refused";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded-lg border p-3 transition-colors ${
        selected ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
      }`}
    >
      <div className="flex items-start gap-2">
        {!isRefused && !isApplied && (
          <input
            type="checkbox"
            checked={isApproved}
            onChange={(e) => { e.stopPropagation(); onToggleApprove(); }}
            onClick={(e) => e.stopPropagation()}
            className="mt-1"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <ConfidenceBadge confidence={proposal.confidence} />
            <Badge variant="outline" className="text-xs">{proposal.proposalKind}</Badge>
            {isApplied && <Badge className="text-xs bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/40">Applied</Badge>}
          </div>
          <div className="text-sm font-medium mt-1.5 truncate">{proposal.summary}</div>
          <div className="text-xs text-muted-foreground mt-1 flex gap-3">
            <span>Δ balance: {proposal.deltasJson.balance.toFixed(2)}</span>
            {proposal.deltasJson.realizedGainBase != null && <span>realized: {proposal.deltasJson.realizedGainBase.toFixed(2)}</span>}
          </div>
        </div>
      </div>
    </button>
  );
}

function ConfidenceBadge({ confidence }: { confidence: Proposal["confidence"] }) {
  const styles: Record<Proposal["confidence"], string> = {
    high: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/40",
    medium: "bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-500/40",
    low: "bg-orange-500/20 text-orange-700 dark:text-orange-300 border-orange-500/40",
    refused: "bg-destructive/20 text-destructive border-destructive/40",
  };
  return <Badge className={`text-xs ${styles[confidence]}`}>{confidence}</Badge>;
}

function ProposalDetail({
  proposal,
  displacedRows,
  holdingMap,
  accountMap,
  onVariantChange,
  onApprove,
  onReject,
  onUndo,
}: {
  proposal: Proposal;
  displacedRows: Record<number, DisplacedRow>;
  holdingMap: Record<number, HoldingMeta>;
  accountMap: Record<number, AccountMeta>;
  onVariantChange: (v: "separate_fee_row" | "absorb_into_cost" | null) => void;
  onApprove: () => void;
  onReject: () => void;
  onUndo: () => void;
}) {
  const isDrift = proposal.proposalKind === "drift";
  const isRefused = proposal.confidence === "refused";
  const isOrphan = proposal.proposalKind === "orphan_stock_leg";
  const isOpeningBalance = proposal.proposalKind === "opening_balance";
  const isApplied = proposal.status === "applied";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base leading-snug">{proposal.summary}</CardTitle>
          <div className="flex gap-2 shrink-0">
            {!isApplied && !isRefused && !isOrphan && (
              <>
                <Button size="sm" variant="outline" onClick={onReject}>Reject</Button>
                <Button size="sm" onClick={onApprove} disabled={proposal.status === "approved"}>Approve</Button>
              </>
            )}
            {isApplied && (
              <Button size="sm" variant="outline" onClick={onUndo}><Undo2 className="size-4 mr-1" /> Undo</Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {(isRefused || isOrphan) && (
          <div className="border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 rounded p-3 flex items-start gap-2">
            <AlertTriangle className="size-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">
                {isOrphan ? "Manual fix needed" : `Refused: ${proposal.refusalReason ?? "no reason"}`}
              </div>
              <div className="text-xs mt-1 opacity-90">
                {(proposal.refusalReason && REFUSAL_EXPLANATIONS[proposal.refusalReason]) ?? (
                  isOrphan
                    ? "This proposal can&apos;t be auto-applied because the planner couldn&apos;t propose a canonical reshape."
                    : "Resolve the underlying issue in /transactions, then re-run the backfill."
                )}
              </div>
            </div>
          </div>
        )}

        {isOpeningBalance && (
          <div className="border border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300 rounded p-3 flex items-start gap-2">
            <AlertTriangle className="size-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">Opening balance</div>
              <div className="text-xs mt-1 opacity-90">
                This is the earliest transaction for this holding in this account — almost certainly an opening balance carried in from another platform. Approving records it as a lot at the entered cost basis with NO cash-side impact (no synthesized cash leg, no trade_link_id). Reject if it&apos;s actually a normal buy with a forgotten cash row.
              </div>
            </div>
          </div>
        )}

        {proposal.dependsOnProposalIds.length > 0 && (
          <div className="border border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300 rounded p-3 text-xs">
            Depends on proposal(s): #{proposal.dependsOnProposalIds.join(", #")}. Apply those first.
          </div>
        )}

        <DisplacedRowsTable
          ids={proposal.existingRowIds}
          displacedRows={displacedRows}
          holdingMap={holdingMap}
          accountMap={accountMap}
        />

        {isDrift && (
          <div className="space-y-2">
            <div className="font-medium">Pick fee handling</div>
            <DriftVariantPicker proposal={proposal} onChange={onVariantChange} />
          </div>
        )}

        {!isDrift && !isOrphan && (
          <ReplacementPreviewTable
            proposal={proposal}
            holdingMap={holdingMap}
            accountMap={accountMap}
          />
        )}

        <DeltasPanel deltas={proposal.deltasJson} holdingMap={holdingMap} />
      </CardContent>
    </Card>
  );
}

function holdingLabelFor(id: number | null, holdingMap: Record<number, HoldingMeta>): string {
  if (id == null) return "(no holding)";
  const h = holdingMap[id];
  if (!h) return `holding #${id}`;
  if (h.isCash) return `${h.currency} cash sleeve`;
  return h.name ?? `holding #${id}`;
}

function accountLabelFor(id: number | null, accountMap: Record<number, AccountMeta>): string {
  if (id == null) return "(no account)";
  const a = accountMap[id];
  if (!a) return `account #${id}`;
  return a.name ?? `account #${id}`;
}

function DisplacedRowsTable({
  ids,
  displacedRows,
  holdingMap,
  accountMap,
}: {
  ids: number[];
  displacedRows: Record<number, DisplacedRow>;
  holdingMap: Record<number, HoldingMeta>;
  accountMap: Record<number, AccountMeta>;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Existing rows being displaced</div>
      <div className="rounded border overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/40">
            <tr>
              <th className="text-left px-2 py-1.5">Tx</th>
              <th className="text-left px-2 py-1.5">Date</th>
              <th className="text-left px-2 py-1.5">Account</th>
              <th className="text-left px-2 py-1.5">Holding</th>
              <th className="text-right px-2 py-1.5">Qty</th>
              <th className="text-right px-2 py-1.5">Amount</th>
              <th className="text-left px-2 py-1.5">Kind</th>
            </tr>
          </thead>
          <tbody>
            {ids.length === 0 && (
              <tr><td colSpan={7} className="text-center text-muted-foreground px-2 py-2">none</td></tr>
            )}
            {ids.map((id) => {
              const r = displacedRows[id];
              if (!r) return (
                <tr key={id} className="border-t"><td colSpan={7} className="px-2 py-1.5 text-muted-foreground">Tx #{id} (row not found)</td></tr>
              );
              return (
                <tr key={id} className="border-t">
                  <td className="px-2 py-1.5 font-mono">#{r.id}</td>
                  <td className="px-2 py-1.5">{r.date}</td>
                  <td className="px-2 py-1.5">{accountLabelFor(r.accountId, accountMap)}</td>
                  <td className="px-2 py-1.5">{holdingLabelFor(r.portfolioHoldingId, holdingMap)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{r.quantity ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{r.amount.toFixed(2)} {r.currency}</td>
                  <td className="px-2 py-1.5 font-mono">{r.kind ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReplacementPreviewTable({
  proposal,
  holdingMap,
  accountMap,
}: {
  proposal: Proposal;
  holdingMap: Record<number, HoldingMeta>;
  accountMap: Record<number, AccountMeta>;
}) {
  const rows = (proposal.replacementRowsJson as Array<{ txId: number; amount?: number; kind?: string; tradeLinkId?: string }> | null) ?? [];
  const synth = (proposal.synthesizedRowsJson as Array<{
    date: string; accountId: number; portfolioHoldingId: number | null; amount: number; currency: string; quantity: number | null; kind: string; synthReason?: string;
  }> | null) ?? [];
  return (
    <div className="space-y-3">
      {rows.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Will become (UPDATE in place)</div>
          <div className="rounded border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left px-2 py-1.5">Tx</th>
                  <th className="text-right px-2 py-1.5">New amount</th>
                  <th className="text-left px-2 py-1.5">New kind</th>
                  <th className="text-left px-2 py-1.5">trade_link_id</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.txId} className="border-t">
                    <td className="px-2 py-1.5 font-mono">#{r.txId}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{r.amount?.toFixed(2) ?? "(unchanged)"}</td>
                    <td className="px-2 py-1.5 font-mono">{r.kind ?? "(unchanged)"}</td>
                    <td className="px-2 py-1.5 font-mono text-muted-foreground truncate max-w-[120px]">{r.tradeLinkId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {synth.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">New rows (synthesized — tagged source=&apos;backfill_synth&apos;)</div>
          <div className="rounded border border-amber-500/40 bg-amber-500/5 overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-amber-500/10">
                <tr>
                  <th className="text-left px-2 py-1.5">Date</th>
                  <th className="text-left px-2 py-1.5">Account</th>
                  <th className="text-left px-2 py-1.5">Holding</th>
                  <th className="text-right px-2 py-1.5">Qty</th>
                  <th className="text-right px-2 py-1.5">Amount</th>
                  <th className="text-left px-2 py-1.5">Kind</th>
                </tr>
              </thead>
              <tbody>
                {synth.map((r, i) => (
                  <tr key={i} className="border-t border-amber-500/30">
                    <td className="px-2 py-1.5">{r.date}</td>
                    <td className="px-2 py-1.5">{accountLabelFor(r.accountId, accountMap)}</td>
                    <td className="px-2 py-1.5">{holdingLabelFor(r.portfolioHoldingId, holdingMap)}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{r.quantity ?? "—"}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{r.amount.toFixed(2)} {r.currency}</td>
                    <td className="px-2 py-1.5 font-mono">{r.kind}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {synth[0]?.synthReason && (
            <p className="text-xs text-muted-foreground mt-1 italic">{synth[0].synthReason}</p>
          )}
        </div>
      )}
      {rows.length === 0 && synth.length === 0 && (
        <div className="text-xs text-muted-foreground italic">No row changes proposed.</div>
      )}
    </div>
  );
}

function DriftVariantPicker({
  proposal,
  onChange,
}: {
  proposal: Proposal;
  onChange: (v: "separate_fee_row" | "absorb_into_cost") => void;
}) {
  const variants = proposal.replacementRowsJson as {
    separate_fee_row?: { explanation: string };
    absorb_into_cost?: { explanation: string };
  } | null;
  if (!variants) return null;
  const selected = proposal.variantChoice;
  return (
    <div className="space-y-2">
      <VariantOption
        label="Book separate fee row"
        explanation={variants.separate_fee_row?.explanation ?? ""}
        selected={selected === "separate_fee_row"}
        onSelect={() => onChange("separate_fee_row")}
      />
      <VariantOption
        label="Absorb into cost basis"
        explanation={variants.absorb_into_cost?.explanation ?? ""}
        selected={selected === "absorb_into_cost"}
        onSelect={() => onChange("absorb_into_cost")}
      />
    </div>
  );
}

function VariantOption({ label, explanation, selected, onSelect }: { label: string; explanation: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded border p-2 ${
        selected ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
      }`}
    >
      <div className="flex items-start gap-2">
        <div className={`mt-1 size-3 rounded-full ${selected ? "bg-primary" : "border border-border"}`} />
        <div>
          <div className="font-medium text-xs">{label}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{explanation}</div>
        </div>
      </div>
    </button>
  );
}

function CoverageDashboard({ coverage, proposals }: { coverage: Coverage; proposals: Proposal[] }) {
  const approvedCount = proposals.filter((p) => p.status === "approved").length;
  const appliedCount = proposals.filter((p) => p.status === "applied").length;
  const willCanonicalize = proposals.filter((p) => p.status === "approved" || p.status === "applied")
    .filter((p) => p.proposalKind !== "orphan_stock_leg")
    .reduce((acc, p) => acc + p.existingRowIds.length, 0);

  const projectedCanonical = Math.min(coverage.canonicalTxs + willCanonicalize, coverage.totalTxs);
  const projectedPct = coverage.totalTxs === 0 ? 0 : Math.round((projectedCanonical / coverage.totalTxs) * 100);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Canonicalization coverage</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-4 gap-4 text-sm">
          <Metric label="Investment accounts" value={String(coverage.accountCount)} />
          <Metric label="Total transactions" value={String(coverage.totalTxs)} />
          <Metric
            label="Canonical (kind set + paired)"
            value={`${coverage.canonicalTxs} / ${coverage.totalTxs}`}
            sub={`${coverage.canonicalPct}%`}
            tone="good"
          />
          <Metric
            label="Pending (needs backfill)"
            value={String(coverage.nonCanonicalTxs)}
            sub={coverage.totalTxs > 0 ? `${100 - coverage.canonicalPct}%` : undefined}
            tone={coverage.nonCanonicalTxs > 0 ? "warn" : "good"}
          />
        </div>

        {/* Progress bar — current vs projected after applying approved */}
        <div className="mt-4 space-y-1">
          <div className="h-2 w-full rounded-full bg-muted/40 overflow-hidden relative">
            <div
              className="h-full bg-emerald-500/70 absolute left-0 top-0"
              style={{ width: `${coverage.canonicalPct}%` }}
              title={`${coverage.canonicalPct}% already canonical`}
            />
            {willCanonicalize > 0 && (
              <div
                className="h-full bg-amber-500/60 absolute top-0"
                style={{ left: `${coverage.canonicalPct}%`, width: `${projectedPct - coverage.canonicalPct}%` }}
                title={`+${willCanonicalize} after applying ${approvedCount + appliedCount} approved/applied proposals → ${projectedPct}%`}
              />
            )}
          </div>
          <div className="text-xs text-muted-foreground flex justify-between">
            <span>Now: {coverage.canonicalPct}% canonical</span>
            {willCanonicalize > 0 && <span>After this run: {projectedPct}% (+{willCanonicalize} rows)</span>}
          </div>
        </div>

        {/* Per-account breakdown */}
        {coverage.perAccount.length > 0 && (
          <div className="mt-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Per-account breakdown</div>
            <div className="rounded border overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left px-2 py-1.5">Account</th>
                    <th className="text-right px-2 py-1.5">Total</th>
                    <th className="text-right px-2 py-1.5">Canonical</th>
                    <th className="text-right px-2 py-1.5">Pending</th>
                    <th className="text-left px-2 py-1.5 w-40">Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.perAccount.map((a) => (
                    <tr key={a.accountId} className="border-t">
                      <td className="px-2 py-1.5">{a.name}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{a.total}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{a.canonical}</td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {a.pending > 0 ? (
                          <span className="text-amber-600 dark:text-amber-400">{a.pending}</span>
                        ) : (
                          <span className="text-emerald-600 dark:text-emerald-400">0</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="h-1.5 w-full rounded-full bg-muted/40 overflow-hidden">
                          <div
                            className="h-full bg-emerald-500/70"
                            style={{ width: `${100 - a.pendingPct}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "warn" }) {
  const toneClass = tone === "good" ? "text-emerald-600 dark:text-emerald-400" : tone === "warn" ? "text-amber-600 dark:text-amber-400" : "";
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${toneClass}`}>{value}</div>
      {sub && <div className={`text-xs ${toneClass}`}>{sub}</div>}
    </div>
  );
}

function DeltasPanel({ deltas, holdingMap }: { deltas: Proposal["deltasJson"]; holdingMap: Record<number, HoldingMeta> }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Impact</div>
      <div className="rounded border bg-muted/30 p-2 text-xs space-y-1">
        <div>Account balance delta: <span className="font-mono">{deltas.balance.toFixed(2)}</span></div>
        {deltas.realizedGainBase != null && (
          <div>Realized gain (base): <span className="font-mono">{deltas.realizedGainBase.toFixed(2)}</span></div>
        )}
        {deltas.lots.length > 0 && (
          <div>Lot effects: {deltas.lots.map((l) => `${holdingLabelFor(l.holdingId, holdingMap)} qty ${l.qtyDelta > 0 ? "+" : ""}${l.qtyDelta}`).join(", ")}</div>
        )}
      </div>
    </div>
  );
}
