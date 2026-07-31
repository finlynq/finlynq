"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Users,
  Activity,
  Shield,
  CreditCard,
  BarChart3,
  CheckCircle,
  XCircle,
  Mail,
  KeyRound,
} from "lucide-react";
import { motion } from "framer-motion";
import { DORMANT_DAYS, isDormant } from "@/lib/auth/dormancy";
import { SPAN_BUCKETS } from "@/lib/auth/activity-span";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Pagination } from "@/components/ui/pagination";

// ─── Types ──────────────────────────────────────────────────────────────────

interface AdminUser {
  id: string;
  username: string | null;
  email: string | null;
  displayName: string | null;
  role: string;
  emailVerified: number;
  mfaEnabled: number;
  onboardingComplete: number;
  plan: string;
  planExpiresAt: string | null;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
  transactionCount: number;
  /**
   * Whole days from signup to last recorded activity, computed SERVER-side so
   * it can be sorted and filtered across the whole table rather than one page.
   * Never null — a never-active user is 0 (see @/lib/auth/activity-span).
   */
  activeSpanDays: number;
}

// FINLYNQ-166 — DORMANT_DAYS + the dormancy/sort math live in the pure,
// dependency-free @/lib/auth/dormancy module (unit-tested in isolation).

interface LoginActivityRow {
  id: string;
  username: string | null;
  email: string | null;
  displayName: string | null;
  loginCount: number;
  lastLoginAt: string | null;
}

interface UsageStats {
  totalUsers: number;
  totalTransactions: number;
  totalAccounts: number;
  registrationsLast7Days: number;
  registrationsLast30Days: number;
  verifiedUsers: number;
  mfaEnabledUsers: number;
  planBreakdown: Record<string, number>;
  totalLogins: number;
  activeUsersLast7Days: number;
  activeUsersLast30Days: number;
  loginsLast24Hours?: number;
  // FINLYNQ — near-real-time "active now" from last_active_at (web + MCP + API key).
  activeUsersLast15Min?: number;
  activeUsersLast60Min?: number;
  activeUsersLast24Hours?: number;
  // FINLYNQ-301 — per-prompt decision-prompt completion.
  promptAcks?: PromptAckRow[];
  recentLogins?: LoginActivityRow[];
}

// FINLYNQ-301 — per-prompt answered/deferred/dismissed completion counts.
interface PromptAckRow {
  promptId: string;
  title: string;
  version: number;
  answered: number;
  deferred: number;
  dismissed: number;
}

// FINLYNQ-167 — a live OAuth grant across all users for the admin panel.
interface AdminGrant {
  id: number;
  userId: string;
  userLabel: string;
  clientId: string;
  clientName: string;
  scope: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

// ─── Sort / paging ──────────────────────────────────────────────────────────
//
// Sort, filter AND paging are all SERVER-side (see listUsersPage in
// @/lib/auth/queries). The hand-rolled client comparator that used to live here
// was removed with the 50-row cap: it could only ever order the rows already
// fetched, so sorting a multi-page table silently sorted one page in isolation.
// `DataTable` renders in `manualSort` mode and reports header clicks upward.

/** Rows per page. The route clamps `limit` to 200. */
const USERS_PAGE_SIZE = 50;

/** Sort keys accepted by GET /api/admin/users — mirrors USER_SORT_SQL. */
type UserSortKey =
  | "user"
  | "role"
  | "plan"
  | "verified"
  | "mfa"
  | "txns"
  | "lastActive"
  | "joined"
  | "span";

/**
 * A column descriptor whose key is constrained to a real sort key (or the
 * non-sortable actions column). Typo a key and this fails at compile time
 * rather than at runtime with a 400 from the route's strict validation.
 */
type UserColumn = DataTableColumn<AdminUser> & {
  key: UserSortKey | "actions";
};

// ─── Animation ──────────────────────────────────────────────────────────────

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.06, delayChildren: 0.08 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: "easeOut" as const },
  },
};

// ─── Stat Card ──────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <motion.div variants={itemVariants}>
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-lg ${color}`}
            >
              <Icon className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{label}</p>
              <p className="text-2xl font-bold tracking-tight">{value}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ─── Role Badge ─────────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: string }) {
  if (role === "admin") {
    return (
      <Badge variant="default" className="bg-amber-500/15 text-amber-600 border-amber-500/30">
        Admin
      </Badge>
    );
  }
  return <Badge variant="secondary">User</Badge>;
}

function PlanBadge({ plan }: { plan: string }) {
  const colors: Record<string, string> = {
    free: "bg-zinc-100 text-zinc-600 border-zinc-200",
    pro: "bg-blue-500/15 text-blue-600 border-blue-500/30",
    premium: "bg-purple-500/15 text-purple-600 border-purple-500/30",
  };
  return (
    <Badge variant="outline" className={colors[plan] || colors.free}>
      {plan.charAt(0).toUpperCase() + plan.slice(1)}
    </Badge>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function AdminPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingUser, setUpdatingUser] = useState<string | null>(null);
  // Server-driven table state. Changing any of these refetches the page.
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(
    null
  );
  const [page, setPage] = useState(0);
  const [spanBucket, setSpanBucket] = useState<string>("");
  // FINLYNQ-167 — OAuth grants panel.
  const [grants, setGrants] = useState<AdminGrant[]>([]);
  const [revokingGrant, setRevokingGrant] = useState<number | null>(null);

  /**
   * The users page. Split from the stats/grants fetch below so paging or
   * re-sorting doesn't re-run the (much heavier) stats aggregation.
   */
  const fetchUsers = useCallback(async () => {
    const params = new URLSearchParams({
      limit: String(USERS_PAGE_SIZE),
      offset: String(page * USERS_PAGE_SIZE),
    });
    if (sort) {
      params.set("sort", sort.key);
      params.set("sortDir", sort.dir);
    }
    if (spanBucket) params.set("spanBucket", spanBucket);

    try {
      const res = await fetch(`/api/admin/users?${params.toString()}`);
      if (!res.ok) {
        setError(
          res.status === 403
            ? "Admin access required."
            : "Failed to load admin data."
        );
        setLoading(false);
        return;
      }
      const data = await res.json();
      setUsers(data.users);
      setTotal(data.total);
      setLoading(false);
    } catch {
      setError("Failed to connect to server.");
      setLoading(false);
    }
  }, [page, sort, spanBucket]);

  const fetchStatsAndGrants = useCallback(async () => {
    try {
      const [statsRes, grantsRes] = await Promise.all([
        fetch("/api/admin/stats"),
        fetch("/api/admin/oauth-grants"),
      ]);
      if (statsRes.ok) setStats(await statsRes.json());
      // Grants are non-fatal: a failed grants fetch leaves the panel empty
      // rather than blanking the whole admin page.
      if (grantsRes.ok) {
        const grantsData = await grantsRes.json();
        setGrants(grantsData.grants ?? []);
      }
    } catch {
      // Stats/grants are supplementary — the users table drives the error state.
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    fetchStatsAndGrants();
  }, [fetchStatsAndGrants]);

  /**
   * A new sort or filter invalidates the current offset — page 4 of the old
   * ordering has nothing to do with page 4 of the new one, and with a filter
   * applied the offset can land past the end and render an empty table.
   */
  const handleSortChange = useCallback(
    (next: { key: string; dir: "asc" | "desc" } | null) => {
      setSort(next);
      setPage(0);
    },
    []
  );

  const handleSpanBucketChange = useCallback((next: string) => {
    setSpanBucket(next);
    setPage(0);
  }, []);

  const handleRoleToggle = async (userId: string, currentRole: string) => {
    const newRole = currentRole === "admin" ? "user" : "admin";
    setUpdatingUser(userId);
    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role: newRole }),
      });
      if (res.ok) {
        setUsers((prev) =>
          prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u))
        );
      }
    } finally {
      setUpdatingUser(null);
    }
  };

  const handlePlanChange = async (userId: string, plan: string) => {
    setUpdatingUser(userId);
    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, plan }),
      });
      if (res.ok) {
        setUsers((prev) =>
          prev.map((u) => (u.id === userId ? { ...u, plan } : u))
        );
      }
    } finally {
      setUpdatingUser(null);
    }
  };

  /**
   * Column descriptors for the shared DataTable. `accessor` is only the
   * fallback cell value here — every column renders explicitly, and sorting is
   * server-side (`manualSort`), so the accessors are never used to order rows.
   * The `key` of each sortable column MUST match a key in USER_SORT_SQL
   * (@/lib/auth/queries); the route 400s on anything else.
   */
  const userColumns: UserColumn[] = useMemo(
    () => [
      {
        key: "user",
        header: "User",
        accessor: (u) => u.displayName ?? u.username ?? u.email ?? "",
        render: (u) => {
          const primary = u.displayName || u.username || u.email || "—";
          const secondary = u.username ?? u.email ?? null;
          // Single line. The secondary identifier is appended inline ONLY when
          // it adds information — most signups have displayName === username,
          // and rendering both unconditionally doubled every row's height to
          // show the same string twice.
          const showSecondary = secondary !== null && secondary !== primary;
          return (
            <span className="flex items-baseline gap-1.5 whitespace-nowrap">
              <span className="font-medium">{primary}</span>
              {showSecondary && (
                <span className="text-xs text-muted-foreground">
                  {secondary}
                </span>
              )}
            </span>
          );
        },
      },
      {
        key: "role",
        header: "Role",
        accessor: (u) => u.role,
        render: (u) => <RoleBadge role={u.role} />,
      },
      {
        key: "plan",
        header: "Plan",
        accessor: (u) => u.plan ?? "free",
        render: (u) => <PlanBadge plan={u.plan ?? "free"} />,
      },
      {
        key: "verified",
        header: "Verified",
        accessor: (u) => (u.emailVerified ? 1 : 0),
        render: (u) =>
          u.emailVerified ? (
            <CheckCircle className="h-4 w-4 text-emerald-500" />
          ) : (
            <XCircle className="h-4 w-4 text-muted-foreground" />
          ),
      },
      {
        key: "mfa",
        header: "MFA",
        accessor: (u) => (u.mfaEnabled ? 1 : 0),
        render: (u) =>
          u.mfaEnabled ? (
            <Shield className="h-4 w-4 text-emerald-500" />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        key: "txns",
        header: "Txns",
        align: "right",
        accessor: (u) => u.transactionCount ?? 0,
        render: (u) => (
          <span className="font-mono text-sm">
            {(u.transactionCount ?? 0).toLocaleString()}
          </span>
        ),
      },
      {
        key: "lastActive",
        header: "Last active",
        accessor: (u) => u.lastActiveAt as string | null,
        render: (u) => {
          // FINLYNQ-166 — dormant (null OR >DORMANT_DAYS) renders muted.
          const dormant = isDormant(u.lastActiveAt);
          return (
            <span
              className={`text-sm ${dormant ? "text-muted-foreground" : "text-foreground"}`}
              title={
                u.lastActiveAt === null
                  ? "No authenticated activity recorded"
                  : dormant
                    ? `Dormant: inactive over ${DORMANT_DAYS} days`
                    : undefined
              }
            >
              {u.lastActiveAt === null
                ? "Never"
                : new Date(u.lastActiveAt as string).toLocaleDateString()}
            </span>
          );
        },
      },
      {
        key: "span",
        header: "Active span",
        align: "right",
        accessor: (u) => u.activeSpanDays,
        render: (u) => (
          <span
            className="font-mono text-sm"
            title={
              u.lastActiveAt === null
                ? "Never active — counted as 0 days"
                : `${u.activeSpanDays} day(s) between signing up and last recorded activity`
            }
          >
            {u.activeSpanDays}
          </span>
        ),
      },
      {
        key: "joined",
        header: "Joined",
        accessor: (u) => u.createdAt,
        render: (u) => (
          <span className="text-sm text-muted-foreground">
            {new Date(u.createdAt).toLocaleDateString()}
          </span>
        ),
      },
      {
        key: "actions",
        header: "Actions",
        sortable: false,
        align: "right",
        accessor: () => null,
        render: (u) => (
          <span className="space-x-2 whitespace-nowrap">
            <button
              className="text-xs px-2 py-1 rounded border hover:bg-muted transition-colors disabled:opacity-50"
              disabled={updatingUser === u.id}
              onClick={() => handleRoleToggle(u.id, u.role)}
            >
              {u.role === "admin" ? "Revoke Admin" : "Make Admin"}
            </button>
            <select
              className="text-xs px-2 py-1 rounded border bg-background"
              value={u.plan ?? "free"}
              disabled={updatingUser === u.id}
              onChange={(e) => handlePlanChange(u.id, e.target.value)}
            >
              <option value="free">Free</option>
              <option value="pro">Pro</option>
              <option value="premium">Premium</option>
            </select>
          </span>
        ),
      },
    ],
    // handleRoleToggle / handlePlanChange are stable closures over setState only.
    [updatingUser]
  );

  // FINLYNQ-167 — admin revoke of a grant (kills access + refresh). Reuses the
  // FINLYNQ-154 revoke path via the admin-scoped route; drops the row from the
  // active list on success.
  const handleRevokeGrant = async (grantId: number) => {
    setRevokingGrant(grantId);
    try {
      const res = await fetch(`/api/admin/oauth-grants?id=${grantId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setGrants((prev) => prev.filter((g) => g.id !== grantId));
      }
    } finally {
      setRevokingGrant(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-5">
        <div className="h-7 w-52 animate-shimmer rounded-lg" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 animate-shimmer rounded-2xl" />
          ))}
        </div>
        <div className="h-96 animate-shimmer rounded-2xl mt-4" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <Card>
          <CardContent className="p-8 text-center">
            <Shield className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-lg font-medium">{error}</p>
            <p className="text-sm text-muted-foreground mt-2">
              You need admin privileges to access this page.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      {/* Header */}
      <motion.div variants={itemVariants}>
        <h1 className="text-2xl font-bold tracking-tight">Admin Dashboard</h1>
        <p className="text-muted-foreground">
          Manage users and monitor platform usage
        </p>
      </motion.div>

      {/* Stats Grid */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Total Users"
            value={stats.totalUsers}
            icon={Users}
            color="bg-blue-500/15 text-blue-600"
          />
          <StatCard
            label="Transactions"
            value={stats.totalTransactions.toLocaleString()}
            icon={Activity}
            color="bg-emerald-500/15 text-emerald-600"
          />
          <StatCard
            label="New (7d)"
            value={stats.registrationsLast7Days}
            icon={BarChart3}
            color="bg-violet-500/15 text-violet-600"
          />
          <StatCard
            label="MFA Enabled"
            value={stats.mfaEnabledUsers}
            icon={Shield}
            color="bg-amber-500/15 text-amber-600"
          />
        </div>
      )}

      {/* Live activity — near-real-time "who's using it right now" from
          last_active_at (web + MCP + API key). The 15-min window is the
          deploy-safety glance: ~0 means a restart disrupts nobody. */}
      {stats && (
        <motion.div variants={itemVariants}>
          <div className="flex items-center gap-2 mb-3">
            <span className="relative flex h-2 w-2">
              {(stats.activeUsersLast15Min ?? 0) > 0 && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              )}
              <span
                className={`relative inline-flex h-2 w-2 rounded-full ${
                  (stats.activeUsersLast15Min ?? 0) > 0
                    ? "bg-emerald-500"
                    : "bg-zinc-300"
                }`}
              />
            </span>
            <h2 className="text-sm font-semibold text-muted-foreground">
              Live activity
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard
              label="Active now (15 min)"
              value={stats.activeUsersLast15Min ?? 0}
              icon={Activity}
              color="bg-emerald-500/15 text-emerald-600"
            />
            <StatCard
              label="Active (last hour)"
              value={stats.activeUsersLast60Min ?? 0}
              icon={Activity}
              color="bg-teal-500/15 text-teal-600"
            />
            <StatCard
              label="Active (last 24h)"
              value={stats.activeUsersLast24Hours ?? 0}
              icon={Activity}
              color="bg-sky-500/15 text-sky-600"
            />
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Counts users with any authenticated request (web, MCP, or API key)
            in the window. Best glance before a deploy: the restart rotates JWTs
            and forces a re-login.
          </p>
        </motion.div>
      )}

      {/* FINLYNQ-301 — Decision-prompt completion (per prompt, current version) */}
      {stats && stats.promptAcks && stats.promptAcks.length > 0 && (
        <motion.div variants={itemVariants}>
          <Card>
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold mb-3">Decision prompts</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Prompt</TableHead>
                    <TableHead className="text-right">Answered</TableHead>
                    <TableHead className="text-right">Deferred</TableHead>
                    <TableHead className="text-right">Dismissed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.promptAcks.map((p) => (
                    <TableRow key={`${p.promptId}:${p.version}`}>
                      <TableCell>
                        <span className="font-medium">{p.promptId}</span>
                        <span className="ml-2 text-xs text-muted-foreground">v{p.version}</span>
                      </TableCell>
                      <TableCell className="text-right">{p.answered}</TableCell>
                      <TableCell className="text-right">{p.deferred}</TableCell>
                      <TableCell className="text-right">{p.dismissed}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="text-xs text-muted-foreground mt-2">
                Rows appear once a user has interacted with a prompt; users never
                shown a prompt have no ack row. Answered is terminal for that
                version; bump the prompt&apos;s version to re-ask everyone.
              </p>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Plan Breakdown */}
      {stats && (
        <motion.div variants={itemVariants}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {Object.entries(stats.planBreakdown).map(([plan, count]) => (
              <Card key={plan}>
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CreditCard className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium capitalize">{plan}</span>
                  </div>
                  <span className="text-xl font-bold">{count}</span>
                </CardContent>
              </Card>
            ))}
          </div>
        </motion.div>
      )}

      {/* User Management */}
      <motion.div variants={itemVariants}>
        <Tabs defaultValue="users">
          <TabsList>
            <TabsTrigger value="users">
              <Users className="h-4 w-4 mr-1.5" />
              Users ({total})
            </TabsTrigger>
            <TabsTrigger value="activity">
              <Activity className="h-4 w-4 mr-1.5" />
              Activity
            </TabsTrigger>
          </TabsList>

          <TabsContent value="users" className="mt-4 space-y-3">
            {/* Active-span filter. Server-side, so it narrows the WHOLE table
                and the count/pager below follow it — not just the loaded page. */}
            <div className="flex items-center gap-2">
              <label
                htmlFor="span-bucket"
                className="text-sm text-muted-foreground"
              >
                Active span
              </label>
              <select
                id="span-bucket"
                className="h-8 rounded-md border bg-background px-2 text-sm"
                value={spanBucket}
                onChange={(e) => handleSpanBucketChange(e.target.value)}
              >
                <option value="">All</option>
                {SPAN_BUCKETS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
              {spanBucket && (
                <button
                  type="button"
                  className="text-xs px-2 py-1 rounded border hover:bg-muted transition-colors"
                  onClick={() => handleSpanBucketChange("")}
                >
                  Clear
                </button>
              )}
            </div>

            <Card>
              <CardContent className="p-0">
                <DataTable
                  columns={userColumns}
                  rows={users}
                  rowKey={(u) => u.id}
                  manualSort
                  sort={sort}
                  onSortChange={handleSortChange}
                  emptyState={
                    <p className="text-center py-8 text-sm text-muted-foreground">
                      No users found.
                    </p>
                  }
                />
              </CardContent>
            </Card>

            <Pagination
              page={page}
              limit={USERS_PAGE_SIZE}
              total={total}
              onPageChange={setPage}
              label="users"
            />
          </TabsContent>

          <TabsContent value="activity" className="mt-4 space-y-4">
            <Card>
              <CardContent className="p-6">
                {stats && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between py-3 border-b">
                      <span className="text-muted-foreground">
                        Registrations (last 30 days)
                      </span>
                      <span className="font-bold">
                        {stats.registrationsLast30Days}
                      </span>
                    </div>
                    <div className="flex items-center justify-between py-3 border-b">
                      <span className="text-muted-foreground">
                        Email-verified users
                      </span>
                      <span className="font-bold flex items-center gap-1">
                        <Mail className="h-4 w-4" />
                        {stats.verifiedUsers} / {stats.totalUsers}
                      </span>
                    </div>
                    <div className="flex items-center justify-between py-3 border-b">
                      <span className="text-muted-foreground">
                        Total logins
                      </span>
                      <span className="font-bold">
                        {stats.totalLogins.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between py-3 border-b">
                      <span className="text-muted-foreground">
                        Active users (last 7 days)
                      </span>
                      <span className="font-bold">
                        {stats.activeUsersLast7Days}
                      </span>
                    </div>
                    <div className="flex items-center justify-between py-3 border-b">
                      <span className="text-muted-foreground">
                        Active users (last 30 days)
                      </span>
                      <span className="font-bold">
                        {stats.activeUsersLast30Days}
                      </span>
                    </div>
                    <div className="flex items-center justify-between py-3 border-b">
                      <span className="text-muted-foreground">
                        Total accounts created
                      </span>
                      <span className="font-bold">{stats.totalAccounts}</span>
                    </div>
                    <div className="flex items-center justify-between py-3">
                      <span className="text-muted-foreground">
                        Total transactions
                      </span>
                      <span className="font-bold">
                        {stats.totalTransactions.toLocaleString()}
                      </span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-0">
                <div className="px-6 py-4 border-b">
                  <h2 className="font-semibold">Recent logins</h2>
                  <p className="text-sm text-muted-foreground">
                    Last 15 users who signed in, most recent first.
                  </p>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead className="text-right">Logins</TableHead>
                      <TableHead>Last login</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stats?.recentLogins?.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>
                          <div>
                            <p className="font-medium">
                              {row.displayName || row.username || "—"}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {row.username ?? row.email ?? "—"}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {row.loginCount.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {row.lastLoginAt
                            ? new Date(row.lastLoginAt).toLocaleString()
                            : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                    {(!stats?.recentLogins ||
                      stats.recentLogins.length === 0) && (
                      <TableRow>
                        <TableCell
                          colSpan={3}
                          className="text-center py-8 text-muted-foreground"
                        >
                          No login activity yet.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* FINLYNQ-167 — OAuth grants across users */}
            <Card>
              <CardContent className="p-0">
                <div className="px-6 py-4 border-b">
                  <h2 className="font-semibold flex items-center gap-2">
                    <KeyRound className="h-4 w-4" />
                    OAuth grants ({grants.length})
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Live OAuth / MCP grants across all users. A grant is dormant
                    when it has not been used in over {DORMANT_DAYS} days.
                  </p>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>App</TableHead>
                      <TableHead>User</TableHead>
                      <TableHead>Scope</TableHead>
                      <TableHead>Granted</TableHead>
                      <TableHead>Last used</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {grants.map((grant) => {
                      // FINLYNQ-166's pure dormancy predicate — reused here for
                      // last_used_at (null OR >DORMANT_DAYS ago = dormant).
                      const dormant = isDormant(grant.lastUsedAt);
                      return (
                        <TableRow key={grant.id}>
                          <TableCell>
                            <p className="font-medium">{grant.clientName}</p>
                            <p className="text-xs text-muted-foreground font-mono">
                              {grant.clientId}
                            </p>
                          </TableCell>
                          <TableCell className="text-sm">
                            {grant.userLabel}
                          </TableCell>
                          <TableCell className="text-xs font-mono text-muted-foreground">
                            {grant.scope}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {new Date(grant.createdAt).toLocaleDateString()}
                          </TableCell>
                          <TableCell className="text-sm">
                            <span className="flex items-center gap-2">
                              <span
                                className={
                                  dormant
                                    ? "text-muted-foreground"
                                    : "text-foreground"
                                }
                                title={
                                  grant.lastUsedAt === null
                                    ? "Never used since tracking began"
                                    : dormant
                                      ? `Dormant: unused over ${DORMANT_DAYS} days`
                                      : undefined
                                }
                              >
                                {grant.lastUsedAt === null
                                  ? "Never"
                                  : new Date(
                                      grant.lastUsedAt
                                    ).toLocaleDateString()}
                              </span>
                              {dormant ? (
                                <Badge
                                  variant="outline"
                                  className="bg-zinc-100 text-zinc-500 border-zinc-200"
                                >
                                  Dormant
                                </Badge>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30"
                                >
                                  Active
                                </Badge>
                              )}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            <button
                              className="text-xs px-2 py-1 rounded border border-destructive/40 text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                              disabled={revokingGrant === grant.id}
                              onClick={() => handleRevokeGrant(grant.id)}
                            >
                              {revokingGrant === grant.id
                                ? "Revoking…"
                                : "Revoke"}
                            </button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {grants.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="text-center py-8 text-muted-foreground"
                        >
                          No active OAuth grants.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </motion.div>
    </motion.div>
  );
}
