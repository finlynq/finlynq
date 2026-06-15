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
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  KeyRound,
} from "lucide-react";
import { motion } from "framer-motion";
import { DORMANT_DAYS, isDormant, compareLastActive } from "@/lib/auth/dormancy";

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
  recentLogins?: LoginActivityRow[];
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

// ─── Sort ───────────────────────────────────────────────────────────────────

type SortColumn =
  | "user"
  | "role"
  | "plan"
  | "verified"
  | "mfa"
  | "txns"
  | "lastActive"
  | "joined";
type SortDirection = "asc" | "desc";

interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

function sortUsers(
  users: AdminUser[],
  sort: SortState | null
): AdminUser[] {
  if (!sort) return users;
  const { column, direction } = sort;
  const mul = direction === "asc" ? 1 : -1;

  return [...users].sort((a, b) => {
    let cmp = 0;
    switch (column) {
      case "user": {
        // Sort by the display label shown in the first cell (displayName ?? username ?? email)
        const aLabel = (a.displayName ?? a.username ?? a.email ?? "").toLowerCase();
        const bLabel = (b.displayName ?? b.username ?? b.email ?? "").toLowerCase();
        cmp = aLabel.localeCompare(bLabel);
        break;
      }
      case "role":
        cmp = (a.role ?? "").localeCompare(b.role ?? "");
        break;
      case "plan":
        cmp = (a.plan ?? "").localeCompare(b.plan ?? "");
        break;
      case "verified":
        cmp = (a.emailVerified ? 1 : 0) - (b.emailVerified ? 1 : 0);
        break;
      case "mfa":
        cmp = (a.mfaEnabled ? 1 : 0) - (b.mfaEnabled ? 1 : 0);
        break;
      case "txns":
        cmp = (a.transactionCount ?? 0) - (b.transactionCount ?? 0);
        break;
      case "lastActive":
        // Null-safe: never-active (null) sorts as least-recently-active.
        cmp = compareLastActive(a.lastActiveAt, b.lastActiveAt);
        break;
      case "joined":
        cmp =
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        break;
    }
    return cmp * mul;
  });
}

function SortIcon({
  column,
  sort,
}: {
  column: SortColumn;
  sort: SortState | null;
}) {
  if (!sort || sort.column !== column) {
    return <ChevronsUpDown className="h-3.5 w-3.5 ml-1 inline-block opacity-40" />;
  }
  return sort.direction === "asc" ? (
    <ChevronUp className="h-3.5 w-3.5 ml-1 inline-block" />
  ) : (
    <ChevronDown className="h-3.5 w-3.5 ml-1 inline-block" />
  );
}

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
  const [sort, setSort] = useState<SortState | null>(null);
  // FINLYNQ-167 — OAuth grants panel.
  const [grants, setGrants] = useState<AdminGrant[]>([]);
  const [revokingGrant, setRevokingGrant] = useState<number | null>(null);

  const handleSort = useCallback((column: SortColumn) => {
    setSort((prev) => {
      if (!prev || prev.column !== column) return { column, direction: "asc" };
      if (prev.direction === "asc") return { column, direction: "desc" };
      return null; // third click clears sort
    });
  }, []);

  const sortedUsers = useMemo(() => sortUsers(users, sort), [users, sort]);

  const fetchData = useCallback(async () => {
    try {
      const [usersRes, statsRes, grantsRes] = await Promise.all([
        fetch("/api/admin/users"),
        fetch("/api/admin/stats"),
        fetch("/api/admin/oauth-grants"),
      ]);

      if (!usersRes.ok || !statsRes.ok) {
        setError(
          usersRes.status === 403
            ? "Admin access required."
            : "Failed to load admin data."
        );
        setLoading(false);
        return;
      }

      const usersData = await usersRes.json();
      const statsData = await statsRes.json();

      setUsers(usersData.users);
      setTotal(usersData.total);
      setStats(statsData);
      // Grants are non-fatal: a failed grants fetch leaves the panel empty
      // rather than blanking the whole admin page.
      if (grantsRes.ok) {
        const grantsData = await grantsRes.json();
        setGrants(grantsData.grants ?? []);
      }
      setLoading(false);
    } catch {
      setError("Failed to connect to server.");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

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

          <TabsContent value="users" className="mt-4">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {(
                        [
                          { col: "user" as SortColumn, label: "User", align: "" },
                          { col: "role" as SortColumn, label: "Role", align: "" },
                          { col: "plan" as SortColumn, label: "Plan", align: "" },
                          { col: "verified" as SortColumn, label: "Verified", align: "" },
                          { col: "mfa" as SortColumn, label: "MFA", align: "" },
                          { col: "txns" as SortColumn, label: "Txns", align: "text-right" },
                          { col: "lastActive" as SortColumn, label: "Last active", align: "" },
                          { col: "joined" as SortColumn, label: "Joined", align: "" },
                        ] as const
                      ).map(({ col, label, align }) => (
                        <TableHead key={col} className={align}>
                          <button
                            type="button"
                            onClick={() => handleSort(col)}
                            className="inline-flex items-center gap-0.5 hover:text-foreground transition-colors select-none cursor-pointer"
                            aria-sort={
                              sort?.column === col
                                ? sort.direction === "asc"
                                  ? "ascending"
                                  : "descending"
                                : "none"
                            }
                          >
                            {label}
                            <SortIcon column={col} sort={sort} />
                          </button>
                        </TableHead>
                      ))}
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedUsers.map((user) => (
                      <TableRow key={user.id}>
                        <TableCell>
                          <div>
                            <p className="font-medium">
                              {user.displayName || user.username || "—"}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {user.username ?? user.email ?? "—"}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <RoleBadge role={user.role} />
                        </TableCell>
                        <TableCell>
                          <PlanBadge plan={user.plan ?? "free"} />
                        </TableCell>
                        <TableCell>
                          {user.emailVerified ? (
                            <CheckCircle className="h-4 w-4 text-emerald-500" />
                          ) : (
                            <XCircle className="h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell>
                          {user.mfaEnabled ? (
                            <Shield className="h-4 w-4 text-emerald-500" />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {(user.transactionCount ?? 0).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-sm">
                          {(() => {
                            // FINLYNQ-166 — dormant (null OR >DORMANT_DAYS) renders muted.
                            const dormant = isDormant(user.lastActiveAt);
                            return (
                              <span
                                className={
                                  dormant
                                    ? "text-muted-foreground"
                                    : "text-foreground"
                                }
                                title={
                                  user.lastActiveAt === null
                                    ? "No authenticated activity recorded"
                                    : dormant
                                      ? `Dormant: inactive over ${DORMANT_DAYS} days`
                                      : undefined
                                }
                              >
                                {user.lastActiveAt === null
                                  ? "Never"
                                  : new Date(
                                      user.lastActiveAt as string
                                    ).toLocaleDateString()}
                              </span>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(user.createdAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-right space-x-2">
                          <button
                            className="text-xs px-2 py-1 rounded border hover:bg-muted transition-colors disabled:opacity-50"
                            disabled={updatingUser === user.id}
                            onClick={() =>
                              handleRoleToggle(user.id, user.role)
                            }
                          >
                            {user.role === "admin"
                              ? "Revoke Admin"
                              : "Make Admin"}
                          </button>
                          <select
                            className="text-xs px-2 py-1 rounded border bg-background"
                            value={user.plan ?? "free"}
                            disabled={updatingUser === user.id}
                            onChange={(e) =>
                              handlePlanChange(user.id, e.target.value)
                            }
                          >
                            <option value="free">Free</option>
                            <option value="pro">Pro</option>
                            <option value="premium">Premium</option>
                          </select>
                        </TableCell>
                      </TableRow>
                    ))}
                    {users.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={9}
                          className="text-center py-8 text-muted-foreground"
                        >
                          No users found.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
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
