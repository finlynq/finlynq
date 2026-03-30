"use client";

import { useEffect, useState, useCallback } from "react";
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
} from "lucide-react";
import { motion } from "framer-motion";

// ─── Types ──────────────────────────────────────────────────────────────────

interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  emailVerified: number;
  mfaEnabled: number;
  onboardingComplete: number;
  plan: string;
  planExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
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

  const fetchData = useCallback(async () => {
    try {
      const [usersRes, statsRes] = await Promise.all([
        fetch("/api/admin/users"),
        fetch("/api/admin/stats"),
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
                      <TableHead>User</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead>Verified</TableHead>
                      <TableHead>MFA</TableHead>
                      <TableHead>Joined</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((user) => (
                      <TableRow key={user.id}>
                        <TableCell>
                          <div>
                            <p className="font-medium">
                              {user.displayName || "—"}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {user.email}
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
                          colSpan={7}
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

          <TabsContent value="activity" className="mt-4">
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
          </TabsContent>
        </Tabs>
      </motion.div>
    </motion.div>
  );
}
