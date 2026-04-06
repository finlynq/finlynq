"use client";

import { DevModeGuard } from "@/components/dev-mode-guard";

import { useEffect, useRef, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/currency";
import { CHART_COLORS } from "@/lib/chart-colors";
import { Send, Trash2, MessageSquare, Bot, User, Sparkles } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

// ─── Types ──────────────────────────────────────────────────────────

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  chartType?: "bar" | "pie" | "line" | "table";
  chartData?: Record<string, unknown>[];
  timestamp: number;
};

// ─── Suggestion chips ───────────────────────────────────────────────

const SUGGESTIONS = [
  "What's my net worth?",
  "How much did I spend this month?",
  "Am I over budget?",
  "Show me spending trends",
  "Goal progress",
  "What are my account balances?",
  "Largest expense this month",
  "Give me a summary",
  "Upcoming bills",
  "How much did I spend last month?",
];

// ─── Storage helpers ────────────────────────────────────────────────

const STORAGE_KEY = "pf-chat-history";
const MAX_MESSAGES = 100;

function loadHistory(): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-MAX_MESSAGES) : [];
  } catch {
    return [];
  }
}

function saveHistory(messages: ChatMessage[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_MESSAGES)));
  } catch {
    // Storage full — drop oldest
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-50)));
  }
}

// ─── Inline chart components ────────────────────────────────────────

function InlineBarChart({ data }: { data: Record<string, unknown>[] }) {
  // Detect if data has budgeted/spent keys (budget comparison)
  const isBudgetChart = data.length > 0 && "budgeted" in data[0] && "spent" in data[0];
  // Detect if data has income/expenses keys (summary)
  const isSummaryChart = data.length > 0 && "income" in data[0] && "expenses" in data[0];
  // Detect goals chart
  const isGoalChart = data.length > 0 && "current" in data[0] && "target" in data[0];

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 11 }}
          stroke="var(--muted-foreground)"
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 11 }}
          stroke="var(--muted-foreground)"
          tickLine={false}
          tickFormatter={(v) => formatCurrency(Number(v), "CAD").replace("CA", "")}
        />
        <Tooltip
          formatter={(v) => formatCurrency(Number(v), "CAD")}
          contentStyle={{
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--popover)",
            color: "var(--popover-foreground)",
          }}
        />
        {isBudgetChart ? (
          <>
            <Bar dataKey="budgeted" fill={CHART_COLORS.neutral} radius={[4, 4, 0, 0]} name="Budget" />
            <Bar dataKey="spent" fill={CHART_COLORS.negative} radius={[4, 4, 0, 0]} name="Spent" />
            <Legend />
          </>
        ) : isSummaryChart ? (
          <>
            <Bar dataKey="income" fill={CHART_COLORS.positive} radius={[4, 4, 0, 0]} name="Income" />
            <Bar dataKey="expenses" fill={CHART_COLORS.negative} radius={[4, 4, 0, 0]} name="Expenses" />
            <Legend />
          </>
        ) : isGoalChart ? (
          <>
            <Bar dataKey="current" fill={CHART_COLORS.neutral} radius={[4, 4, 0, 0]} name="Current" />
            <Bar dataKey="target" fill={CHART_COLORS.categories[4]} radius={[4, 4, 0, 0]} name="Target" />
            <Legend />
          </>
        ) : (
          <Bar dataKey="value" radius={[4, 4, 0, 0]}>
            {data.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS.categories[i % CHART_COLORS.categories.length]} />
            ))}
          </Bar>
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}

function InlinePieChart({ data }: { data: Record<string, unknown>[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          outerRadius={80}
          innerRadius={40}
          paddingAngle={2}
          label={({ name, percent }) => `${name} ${Math.round((percent ?? 0) * 100)}%`}
          labelLine={false}
          style={{ fontSize: 10 }}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={CHART_COLORS.categories[i % CHART_COLORS.categories.length]} />
          ))}
        </Pie>
        <Tooltip
          formatter={(v) => formatCurrency(Number(v), "CAD")}
          contentStyle={{
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--popover)",
            color: "var(--popover-foreground)",
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

function InlineLineChart({ data }: { data: Record<string, unknown>[] }) {
  const hasIncome = data.length > 0 && "income" in data[0];

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 11 }}
          stroke="var(--muted-foreground)"
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 11 }}
          stroke="var(--muted-foreground)"
          tickLine={false}
          tickFormatter={(v) => formatCurrency(Number(v), "CAD").replace("CA", "")}
        />
        <Tooltip
          formatter={(v) => formatCurrency(Number(v), "CAD")}
          contentStyle={{
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--popover)",
            color: "var(--popover-foreground)",
          }}
        />
        {hasIncome ? (
          <>
            <Line type="monotone" dataKey="income" stroke={CHART_COLORS.positive} strokeWidth={2} dot={{ r: 3 }} name="Income" />
            <Line type="monotone" dataKey="expenses" stroke={CHART_COLORS.negative} strokeWidth={2} dot={{ r: 3 }} name="Expenses" />
            <Legend />
          </>
        ) : (
          <Line type="monotone" dataKey="value" stroke={CHART_COLORS.neutral} strokeWidth={2} dot={{ r: 3 }} />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}

function InlineTable({ data }: { data: Record<string, unknown>[] }) {
  if (data.length === 0) return null;
  const keys = Object.keys(data[0]);

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            {keys.map((key) => (
              <th key={key} className="px-3 py-2 text-left font-medium text-muted-foreground capitalize">
                {key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i} className="border-b border-border/50 last:border-0">
              {keys.map((key) => (
                <td key={key} className="px-3 py-1.5 whitespace-nowrap">
                  {String(row[key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main chat page ─────────────────────────────────────────────────

function ChatPageContent() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [mounted, setMounted] = useState(false);

  // Load history on mount
  useEffect(() => {
    setMessages(loadHistory());
    setMounted(true);
  }, []);

  // Auto-scroll on new message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Save history on change
  useEffect(() => {
    if (mounted && messages.length > 0) {
      saveHistory(messages);
    }
  }, [messages, mounted]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || loading) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: text.trim(),
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text.trim() }),
      });

      const data = await res.json();

      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: data.text ?? data.error ?? "Something went wrong.",
        chartType: data.chartType,
        chartData: data.chartData,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: "Sorry, I couldn't process that request. Please try again.",
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [loading]);

  const clearHistory = () => {
    setMessages([]);
    localStorage.removeItem(STORAGE_KEY);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  // ─── Empty state ────────────────────────────────────────────────

  const emptyState = (
    <div className="flex-1 flex flex-col items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4 }}
        className="text-center max-w-md"
      >
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600 shadow-lg shadow-indigo-500/30">
          <Sparkles className="h-8 w-8 text-white" />
        </div>
        <h2 className="text-xl font-semibold text-foreground mb-2">Ask about your finances</h2>
        <p className="text-sm text-muted-foreground mb-6">
          I can help you understand your spending, balances, budgets, goals, and more. Try one of these:
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => sendMessage(s)}
              className="px-3 py-1.5 text-xs font-medium rounded-full border border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );

  // ─── Render ─────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] md:h-screen md:max-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between px-4 md:px-6 py-3 border-b border-border bg-background/80 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600 shadow-md shadow-indigo-500/20">
            <MessageSquare className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-foreground">AI Chat</h1>
            <p className="text-[11px] text-muted-foreground leading-none">Ask about your finances</p>
          </div>
        </div>
        {messages.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearHistory}
            className="text-muted-foreground hover:text-destructive text-xs gap-1.5"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </Button>
        )}
      </div>

      {/* Messages area */}
      {messages.length === 0 && !loading ? (
        emptyState
      ) : (
        <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 space-y-4">
          <AnimatePresence initial={false}>
            {messages.map((msg) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className={`flex gap-2.5 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {msg.role === "assistant" && (
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 mt-0.5">
                    <Bot className="h-4 w-4 text-slate-600 dark:text-slate-400" />
                  </div>
                )}

                <div
                  className={`max-w-[85%] md:max-w-[70%] space-y-3 ${
                    msg.role === "user" ? "order-first" : ""
                  }`}
                >
                  <div
                    className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                      msg.role === "user"
                        ? "bg-indigo-600 text-white rounded-br-md"
                        : "bg-slate-100 dark:bg-slate-800 text-foreground rounded-bl-md"
                    }`}
                  >
                    {msg.text}
                  </div>

                  {/* Inline visualization */}
                  {msg.chartData && msg.chartData.length > 0 && (
                    <Card className="overflow-hidden border-border/60">
                      <CardContent className="p-3">
                        {msg.chartType === "bar" && <InlineBarChart data={msg.chartData} />}
                        {msg.chartType === "pie" && <InlinePieChart data={msg.chartData} />}
                        {msg.chartType === "line" && <InlineLineChart data={msg.chartData} />}
                        {msg.chartType === "table" && <InlineTable data={msg.chartData} />}
                      </CardContent>
                    </Card>
                  )}
                </div>

                {msg.role === "user" && (
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-100 dark:bg-indigo-900/40 mt-0.5">
                    <User className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Loading indicator */}
          {loading && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex gap-2.5 justify-start"
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 mt-0.5">
                <Bot className="h-4 w-4 text-slate-600 dark:text-slate-400" />
              </div>
              <div className="rounded-2xl rounded-bl-md bg-slate-100 dark:bg-slate-800 px-4 py-3">
                <div className="flex gap-1.5">
                  <div className="h-2 w-2 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
                  <div className="h-2 w-2 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
                  <div className="h-2 w-2 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            </motion.div>
          )}

          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Input area */}
      <div className="shrink-0 border-t border-border bg-background/80 backdrop-blur-sm px-4 md:px-6 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:pb-3">
        {/* Quick suggestions when there are messages */}
        {messages.length > 0 && !loading && (
          <div className="flex gap-1.5 overflow-x-auto pb-2 scrollbar-none mb-1">
            {SUGGESTIONS.slice(0, 5).map((s) => (
              <button
                key={s}
                onClick={() => sendMessage(s)}
                className="px-2.5 py-1 text-[11px] font-medium rounded-full border border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap shrink-0"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your finances..."
            disabled={loading}
            className="flex-1"
          />
          <Button
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || loading}
            size="icon"
            className="bg-indigo-600 hover:bg-indigo-700 text-white shrink-0"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function ChatPage() { return <DevModeGuard><ChatPageContent /></DevModeGuard>; }
