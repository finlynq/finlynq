"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Upload, FileText, CheckCircle2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

type DropState = "idle" | "hover" | "uploading" | "done" | "error";

export function QuickImport() {
  const router = useRouter();
  const [state, setState] = useState<DropState>("idle");
  const [fileName, setFileName] = useState("");

  const handleFile = useCallback(async (file: File) => {
    setFileName(file.name);
    setState("uploading");

    const form = new FormData();
    form.append("file", file);

    try {
      const res = await fetch("/api/import/upload", { method: "POST", body: form });
      if (res.ok) {
        setState("done");
        setTimeout(() => router.push("/import"), 1200);
      } else {
        setState("error");
        setTimeout(() => setState("idle"), 2500);
      }
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 2500);
    }
  }, [router]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setState("idle");
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setState("hover"); };
  const onDragLeave = () => setState("idle");

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = "";
  };

  const isActive = state === "hover";
  const isUploading = state === "uploading";
  const isDone = state === "done";
  const isError = state === "error";

  return (
    <Card
      className={`card-hover transition-colors duration-200 ${isActive ? "border-indigo-400 bg-indigo-50/30 dark:bg-indigo-950/20" : ""}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <CardContent className="px-5 py-4">
        <div className="flex items-center gap-2.5 mb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400">
            <Upload className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold">Quick Import</p>
            <p className="text-[11px] text-muted-foreground">Drop a CSV or OFX file to import</p>
          </div>
        </div>

        <label className="block cursor-pointer">
          <input
            type="file"
            accept=".csv,.ofx,.qfx"
            className="sr-only"
            onChange={onFileInput}
            disabled={isUploading || isDone}
          />
          <div
            className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-5 transition-all duration-200
              ${isActive ? "border-indigo-400 bg-indigo-50/50 dark:bg-indigo-950/30" : "border-border/60 hover:border-indigo-300 hover:bg-muted/30"}
              ${isUploading || isDone ? "pointer-events-none" : ""}`}
          >
            <AnimatePresence mode="wait">
              {isDone ? (
                <motion.div key="done" initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="flex flex-col items-center gap-1">
                  <CheckCircle2 className="h-6 w-6 text-emerald-500" />
                  <p className="text-xs text-emerald-600 font-medium">Uploaded! Redirecting…</p>
                </motion.div>
              ) : isError ? (
                <motion.div key="error" initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="flex flex-col items-center gap-1">
                  <p className="text-xs text-rose-600 font-medium">Upload failed. Try again.</p>
                </motion.div>
              ) : isUploading ? (
                <motion.div key="uploading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-1">
                  <div className="h-5 w-5 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
                  <p className="text-xs text-muted-foreground">{fileName}</p>
                </motion.div>
              ) : (
                <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-1">
                  <FileText className="h-5 w-5 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground">
                    <span className="text-indigo-600 font-medium">Click to browse</span> or drag & drop
                  </p>
                  <p className="text-[10px] text-muted-foreground/60">CSV, OFX, QFX</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </label>
      </CardContent>
    </Card>
  );
}
