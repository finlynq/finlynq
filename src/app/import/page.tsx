"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Upload, CheckCircle2, AlertCircle, Wallet, Tag, Briefcase, ArrowLeftRight } from "lucide-react";

const importSteps = [
  { type: "accounts", label: "Accounts", description: "Import bank accounts, investment accounts, and liabilities", file: "Accounts.csv", icon: Wallet, iconBg: "bg-violet-100 text-violet-600" },
  { type: "categories", label: "Categories", description: "Import expense, income, and reconciliation categories", file: "Categories.csv", icon: Tag, iconBg: "bg-emerald-100 text-emerald-600" },
  { type: "portfolio", label: "Portfolio", description: "Import investment holdings and symbols", file: "Portfolio.csv", icon: Briefcase, iconBg: "bg-cyan-100 text-cyan-600" },
  { type: "transactions", label: "Transactions", description: "Import all transactions (requires accounts and categories first)", file: "Transactions.csv", icon: ArrowLeftRight, iconBg: "bg-amber-100 text-amber-600" },
];

type ImportResult = { total: number; imported: number } | null;
type ImportStatus = "idle" | "loading" | "success" | "error";

export default function ImportPage() {
  const [results, setResults] = useState<Record<string, ImportResult>>({});
  const [statuses, setStatuses] = useState<Record<string, ImportStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function handleImport(type: string, file: File) {
    setStatuses((s) => ({ ...s, [type]: "loading" }));
    setErrors((e) => ({ ...e, [type]: "" }));

    const formData = new FormData();
    formData.append("type", type);
    formData.append("file", file);

    try {
      const res = await fetch("/api/import", { method: "POST", body: formData });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error);

      setResults((r) => ({ ...r, [type]: data }));
      setStatuses((s) => ({ ...s, [type]: "success" }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Import failed";
      setErrors((e) => ({ ...e, [type]: message }));
      setStatuses((s) => ({ ...s, [type]: "error" }));
    }
  }

  const completedCount = Object.values(statuses).filter((s) => s === "success").length;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Import Data</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Import your CSV files in order: Accounts, Categories, Portfolio, then Transactions.
        </p>
      </div>

      {/* Progress indicator */}
      <div className="flex items-center gap-2">
        {importSteps.map((step, i) => (
          <div key={step.type} className="flex items-center gap-2">
            <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
              statuses[step.type] === "success"
                ? "bg-emerald-100 text-emerald-700"
                : statuses[step.type] === "error"
                  ? "bg-rose-100 text-rose-700"
                  : "bg-muted text-muted-foreground"
            }`}>
              {statuses[step.type] === "success" ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
            </div>
            {i < importSteps.length - 1 && (
              <div className={`h-0.5 w-8 rounded-full ${statuses[step.type] === "success" ? "bg-emerald-300" : "bg-muted"}`} />
            )}
          </div>
        ))}
        <span className="text-xs text-muted-foreground ml-2">{completedCount}/{importSteps.length} complete</span>
      </div>

      {importSteps.map((step) => {
        const StepIcon = step.icon;
        return (
          <Card key={step.type} className={statuses[step.type] === "success" ? "border-emerald-200 bg-emerald-50/30" : ""}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${step.iconBg}`}>
                    <StepIcon className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">{step.label}</CardTitle>
                    <CardDescription className="text-xs">{step.description}</CardDescription>
                  </div>
                </div>
                {statuses[step.type] === "success" && (
                  <Badge variant="default" className="bg-emerald-600 text-white">
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    Done
                  </Badge>
                )}
                {statuses[step.type] === "error" && (
                  <Badge variant="destructive">
                    <AlertCircle className="h-3 w-3 mr-1" />
                    Error
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4">
                <label className="flex-1">
                  <input
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleImport(step.type, file);
                    }}
                  />
                  <Button
                    variant={statuses[step.type] === "success" ? "outline" : "default"}
                    className="w-full cursor-pointer"
                    disabled={statuses[step.type] === "loading"}
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    {statuses[step.type] === "loading"
                      ? "Importing..."
                      : statuses[step.type] === "success"
                        ? "Re-upload"
                        : `Upload ${step.file}`}
                  </Button>
                </label>
              </div>
              {results[step.type] && (
                <p className="text-xs text-muted-foreground mt-2">
                  Imported <span className="font-semibold text-emerald-600">{results[step.type]!.imported}</span> of {results[step.type]!.total} rows
                </p>
              )}
              {errors[step.type] && (
                <p className="text-xs text-rose-600 mt-2">{errors[step.type]}</p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
