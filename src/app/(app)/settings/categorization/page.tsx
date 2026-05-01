"use client";

/**
 * /settings/categorization — Category Management + Transaction Rules (issue #57).
 * Extracted from the monolith /settings/page.tsx.
 */

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { useDropdownOrder } from "@/components/dropdown-order-provider";
import { Tag, Zap, Plus, AlertTriangle, Pencil, Trash2, Check, X, ToggleLeft, ToggleRight, Play } from "lucide-react";

type Category = { id: number; type: string; group: string; name: string; note: string };

type Rule = {
  id: number;
  name: string;
  matchField: string;
  matchType: string;
  matchValue: string;
  assignCategoryId: number | null;
  categoryName: string | null;
  assignTags: string | null;
  renameTo: string | null;
  isActive: number;
  priority: number;
  createdAt: string;
};

export default function CategorizationSettingsPage() {
  // Category management
  const [categories, setCategories] = useState<Category[]>([]);
  const sortCategory = useDropdownOrder("category");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [catError, setCatError] = useState("");
  const [newCatForm, setNewCatForm] = useState({ name: "", type: "E", group: "" });
  const [newCatErrors, setNewCatErrors] = useState<{ name?: string; group?: string }>({});
  const [showAddCat, setShowAddCat] = useState(false);

  // Transaction rules
  const [rules, setRules] = useState<Rule[]>([]);
  const [showAddRule, setShowAddRule] = useState(false);
  const [ruleError, setRuleError] = useState("");
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);
  const [ruleForm, setRuleForm] = useState({
    name: "", matchField: "payee", matchType: "contains", matchValue: "",
    assignCategoryId: "", assignTags: "", renameTo: "", priority: "0",
  });
  const [ruleFormErrors, setRuleFormErrors] = useState<Record<string, string>>({});
  const [testPayee, setTestPayee] = useState("");
  const [testResult, setTestResult] = useState("");

  // Load categories
  const loadCategories = useCallback(() => {
    fetch("/api/categories").then((r) => r.json()).then(setCategories);
  }, []);

  useEffect(() => { loadCategories(); }, [loadCategories]);

  // Load rules
  const loadRules = useCallback(() => {
    fetch("/api/rules").then((r) => r.json()).then(setRules);
  }, []);

  useEffect(() => { loadRules(); }, [loadRules]);

  function resetRuleForm() {
    setRuleForm({ name: "", matchField: "payee", matchType: "contains", matchValue: "", assignCategoryId: "", assignTags: "", renameTo: "", priority: "0" });
    setRuleFormErrors({});
    setEditingRuleId(null);
  }

  async function handleSaveRule(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!ruleForm.name.trim()) errs.name = "Name is required";
    if (!ruleForm.matchValue.trim()) errs.matchValue = "Match value is required";
    setRuleFormErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setRuleError("");
    const payload = {
      ...(editingRuleId ? { id: editingRuleId } : {}),
      name: ruleForm.name.trim(),
      matchField: ruleForm.matchField,
      matchType: ruleForm.matchType,
      matchValue: ruleForm.matchValue.trim(),
      assignCategoryId: ruleForm.assignCategoryId ? parseInt(ruleForm.assignCategoryId) : null,
      assignTags: ruleForm.assignTags || null,
      renameTo: ruleForm.renameTo || null,
      priority: parseInt(ruleForm.priority) || 0,
    };

    try {
      const res = await fetch("/api/rules", {
        method: editingRuleId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json();
        setRuleError(data.error || "Failed to save rule");
        return;
      }
      resetRuleForm();
      setShowAddRule(false);
      loadRules();
    } catch {
      setRuleError("Failed to save rule");
    }
  }

  async function handleDeleteRule(id: number) {
    setRuleError("");
    try {
      await fetch(`/api/rules?id=${id}`, { method: "DELETE" });
      loadRules();
    } catch {
      setRuleError("Failed to delete rule");
    }
  }

  async function handleToggleRule(rule: Rule) {
    try {
      await fetch("/api/rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rule.id, isActive: rule.isActive ? 0 : 1 }),
      });
      loadRules();
    } catch {
      setRuleError("Failed to toggle rule");
    }
  }

  function handleEditRule(rule: Rule) {
    setEditingRuleId(rule.id);
    setRuleForm({
      name: rule.name,
      matchField: rule.matchField,
      matchType: rule.matchType,
      matchValue: rule.matchValue,
      assignCategoryId: rule.assignCategoryId?.toString() ?? "",
      assignTags: rule.assignTags ?? "",
      renameTo: rule.renameTo ?? "",
      priority: rule.priority.toString(),
    });
    setShowAddRule(true);
    setRuleFormErrors({});
  }

  async function handleTestRule() {
    if (!testPayee.trim()) { setTestResult("Enter a payee to test"); return; }
    setTestResult("Testing...");
    try {
      const res = await fetch("/api/transactions/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payee: testPayee.trim() }),
      });
      const data = await res.json();
      if (data.suggestion) {
        setTestResult(`Suggested: ${data.suggestion.name} (${data.suggestion.group})`);
      } else {
        setTestResult("No suggestion found for this payee");
      }
    } catch {
      setTestResult("Test failed");
    }
  }

  // Match type options based on field
  const matchTypeOptions = ruleForm.matchField === "amount"
    ? [{ value: "greater_than", label: "Greater than" }, { value: "less_than", label: "Less than" }, { value: "exact", label: "Exact" }]
    : [{ value: "contains", label: "Contains" }, { value: "exact", label: "Exact match" }, { value: "regex", label: "Regex" }];

  // Category CRUD
  async function handleEditCategory(id: number) {
    if (!editName.trim()) return;
    setCatError("");
    try {
      const res = await fetch("/api/categories", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: editName.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        setCatError(data.error || "Failed to update");
        return;
      }
      setEditingId(null);
      setEditName("");
      loadCategories();
    } catch {
      setCatError("Failed to update category");
    }
  }

  async function handleDeleteCategory(id: number) {
    setCatError("");
    try {
      const res = await fetch(`/api/categories?id=${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setCatError(data.error || "Failed to delete");
        return;
      }
      loadCategories();
    } catch {
      setCatError("Failed to delete category");
    }
  }

  async function handleAddCategory(e: React.FormEvent) {
    e.preventDefault();
    const errs: { name?: string; group?: string } = {};
    if (!newCatForm.name.trim()) errs.name = "Name is required";
    if (!newCatForm.group.trim()) errs.group = "Group is required";
    setNewCatErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setCatError("");
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCatForm.name.trim(), type: newCatForm.type, group: newCatForm.group.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        setCatError(data.error || "Failed to create");
        return;
      }
      setNewCatForm({ name: "", type: "E", group: "" });
      setNewCatErrors({});
      setShowAddCat(false);
      loadCategories();
    } catch {
      setCatError("Failed to create category");
    }
  }

  // Group categories by group
  const grouped = new Map<string, Category[]>();
  categories.forEach((c) => {
    const group = c.group || "Ungrouped";
    grouped.set(group, [...(grouped.get(group) ?? []), c]);
  });

  // Get unique groups for the add form
  const uniqueGroups = Array.from(new Set(categories.map((c) => c.group).filter(Boolean)));

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Categorization</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage categories and auto-categorization rules</p>
      </div>

      {/* Category Management */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600">
                <Tag className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base">Category Management</CardTitle>
                <CardDescription>Manage transaction categories</CardDescription>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowAddCat(!showAddCat)}>
              <Plus className="h-4 w-4 mr-1" /> Add
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {catError && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {catError}
            </div>
          )}

          {/* Add category form */}
          {showAddCat && (
            <form onSubmit={handleAddCategory} className="space-y-3 p-3 rounded-lg border bg-muted/30">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>Name</Label>
                  <Input value={newCatForm.name} onChange={(e) => { setNewCatForm({ ...newCatForm, name: e.target.value }); setNewCatErrors({ ...newCatErrors, name: "" }); }} placeholder="Category name" />
                  {newCatErrors.name && <p className="text-xs text-destructive mt-1">{newCatErrors.name}</p>}
                </div>
                <div>
                  <Label>Group</Label>
                  <Input
                    value={newCatForm.group}
                    onChange={(e) => { setNewCatForm({ ...newCatForm, group: e.target.value }); setNewCatErrors({ ...newCatErrors, group: "" }); }}
                    placeholder="e.g. Housing"
                    list="cat-groups"
                  />
                  <datalist id="cat-groups">
                    {uniqueGroups.map((g) => <option key={g} value={g} />)}
                  </datalist>
                  {newCatErrors.group && <p className="text-xs text-destructive mt-1">{newCatErrors.group}</p>}
                </div>
                <div>
                  <Label>Type</Label>
                  <Select value={newCatForm.type} onValueChange={(v) => setNewCatForm({ ...newCatForm, type: v ?? "E" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="E">Expense</SelectItem>
                      <SelectItem value="I">Income</SelectItem>
                      <SelectItem value="R">Reconciliation</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm">Add Category</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => { setShowAddCat(false); setNewCatErrors({}); }}>Cancel</Button>
              </div>
            </form>
          )}

          {/* Category list grouped */}
          {Array.from(grouped.entries()).map(([group, cats]) => (
            <div key={group}>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{group}</h4>
              <div className="space-y-1">
                {cats.map((cat) => (
                  <div key={cat.id} className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-muted/50 transition-colors group">
                    {editingId === cat.id ? (
                      <div className="flex items-center gap-2 flex-1">
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="h-7 text-sm"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleEditCategory(cat.id);
                            if (e.key === "Escape") { setEditingId(null); setEditName(""); }
                          }}
                        />
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleEditCategory(cat.id)}>
                          <Check className="h-3 w-3" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditingId(null); setEditName(""); }}>
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="text-sm">{cat.name}</span>
                          <Badge variant="secondary" className="text-[10px]">
                            {cat.type === "E" ? "Expense" : cat.type === "I" ? "Income" : "Reconciliation"}
                          </Badge>
                        </div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditingId(cat.id); setEditName(cat.name); setCatError(""); }}>
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDeleteCategory(cat.id)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {categories.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No categories found</p>
          )}
        </CardContent>
      </Card>

      {/* Transaction Rules */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-100 text-orange-600">
                <Zap className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base">Transaction Rules</CardTitle>
                <CardDescription>Auto-categorize transactions based on rules</CardDescription>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => { if (showAddRule && editingRuleId) resetRuleForm(); setShowAddRule(!showAddRule); }}>
              <Plus className="h-4 w-4 mr-1" /> Add Rule
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {ruleError && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {ruleError}
            </div>
          )}

          {/* Add/Edit rule form */}
          {showAddRule && (
            <form onSubmit={handleSaveRule} className="space-y-3 p-3 rounded-lg border bg-muted/30">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Rule Name</Label>
                  <Input
                    value={ruleForm.name}
                    onChange={(e) => { setRuleForm({ ...ruleForm, name: e.target.value }); setRuleFormErrors({ ...ruleFormErrors, name: "" }); }}
                    placeholder="e.g. Grocery stores"
                  />
                  {ruleFormErrors.name && <p className="text-xs text-destructive mt-1">{ruleFormErrors.name}</p>}
                </div>
                <div>
                  <Label>Priority</Label>
                  <Input
                    type="number"
                    value={ruleForm.priority}
                    onChange={(e) => setRuleForm({ ...ruleForm, priority: e.target.value })}
                    placeholder="0"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>Match Field</Label>
                  <Select value={ruleForm.matchField} onValueChange={(v) => setRuleForm({ ...ruleForm, matchField: v ?? "payee", matchType: (v ?? "payee") === "amount" ? "greater_than" : "contains" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="payee">Payee</SelectItem>
                      <SelectItem value="amount">Amount</SelectItem>
                      <SelectItem value="tags">Tags</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Match Type</Label>
                  <Select value={ruleForm.matchType} onValueChange={(v) => setRuleForm({ ...ruleForm, matchType: v ?? "contains" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {matchTypeOptions.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Match Value</Label>
                  <Input
                    value={ruleForm.matchValue}
                    onChange={(e) => { setRuleForm({ ...ruleForm, matchValue: e.target.value }); setRuleFormErrors({ ...ruleFormErrors, matchValue: "" }); }}
                    placeholder={ruleForm.matchField === "amount" ? "100.00" : "e.g. Walmart"}
                  />
                  {ruleFormErrors.matchValue && <p className="text-xs text-destructive mt-1">{ruleFormErrors.matchValue}</p>}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>Assign Category</Label>
                  <Combobox
                    value={ruleForm.assignCategoryId}
                    onValueChange={(v) => setRuleForm({ ...ruleForm, assignCategoryId: v })}
                    items={sortCategory(
                      categories.map((c): ComboboxItemShape => ({ value: c.id.toString(), label: c.name })),
                      (c) => Number(c.value),
                      (a, z) => a.label.localeCompare(z.label),
                    )}
                    placeholder="None"
                    searchPlaceholder="Search categories…"
                    emptyMessage="No matches"
                    className="w-full"
                  />
                </div>
                <div>
                  <Label>Assign Tags</Label>
                  <Input
                    value={ruleForm.assignTags}
                    onChange={(e) => setRuleForm({ ...ruleForm, assignTags: e.target.value })}
                    placeholder="tag1, tag2"
                  />
                </div>
                <div>
                  <Label>Rename To</Label>
                  <Input
                    value={ruleForm.renameTo}
                    onChange={(e) => setRuleForm({ ...ruleForm, renameTo: e.target.value })}
                    placeholder="Clean payee name"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm">{editingRuleId ? "Update Rule" : "Add Rule"}</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => { setShowAddRule(false); resetRuleForm(); }}>Cancel</Button>
              </div>
            </form>
          )}

          {/* Rules list */}
          <div className="space-y-1">
            {rules.map((rule) => (
              <div key={rule.id} className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-muted/50 transition-colors group">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => handleToggleRule(rule)}
                    className="shrink-0"
                    title={rule.isActive ? "Active — click to disable" : "Inactive — click to enable"}
                  >
                    {rule.isActive ? (
                      <ToggleRight className="h-5 w-5 text-emerald-500" />
                    ) : (
                      <ToggleLeft className="h-5 w-5 text-muted-foreground" />
                    )}
                  </button>
                  <div className="min-w-0">
                    <span className={`text-sm font-medium ${!rule.isActive ? "text-muted-foreground line-through" : ""}`}>{rule.name}</span>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge variant="secondary" className="text-[10px]">{rule.matchField}</Badge>
                      <span className="text-[10px] text-muted-foreground">{rule.matchType}</span>
                      <span className="text-[10px] font-mono text-muted-foreground truncate max-w-32">&ldquo;{rule.matchValue}&rdquo;</span>
                      {rule.categoryName && (
                        <Badge variant="outline" className="text-[10px]">{rule.categoryName}</Badge>
                      )}
                      {rule.priority > 0 && (
                        <span className="text-[10px] text-muted-foreground">P{rule.priority}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleEditRule(rule)}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDeleteRule(rule.id)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {rules.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No rules yet. Add rules to auto-categorize transactions.</p>
          )}

          {/* Test rule */}
          <div className="border-t pt-4">
            <Label className="text-xs text-muted-foreground">Test Auto-Suggest</Label>
            <div className="flex gap-2 mt-1">
              <Input
                value={testPayee}
                onChange={(e) => setTestPayee(e.target.value)}
                placeholder="Enter a payee name..."
                className="flex-1"
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleTestRule(); } }}
              />
              <Button variant="outline" size="sm" onClick={handleTestRule}>
                <Play className="h-3 w-3 mr-1" /> Test
              </Button>
            </div>
            {testResult && (
              <p className="text-xs text-muted-foreground mt-1.5">{testResult}</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
