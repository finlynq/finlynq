"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Upload, FileText, FileUp } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { setHandoffFile } from "@/lib/import/file-handoff";

type DropState = "idle" | "hover";

export function QuickImport() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<DropState>("idle");

  // Carry the picked/dropped file to /import via the module-level handoff
  // store (a File can't be JSON-serialized through sessionStorage/URL, but the
  // module instance survives a client-side router.push). /import consumes it on
  // mount, opens its UploadDrawer, and runs the same preview/staging pipeline.
  // When no file is provided, fall back to a bare navigation. (FINLYNQ-188)
  const goToImport = useCallback(
    (file?: File | null) => {
      if (file) setHandoffFile(file);
      router.push("/import");
    },
    [router],
  );

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setState("idle");
    goToImport(e.dataTransfer.files?.[0] ?? null);
  }, [goToImport]);

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setState("hover"); };
  const onDragLeave = () => setState("idle");

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    // Reset the input value so re-selecting the SAME filename re-fires onChange
    // (the file is already captured above; the reset only affects future picks).
    e.target.value = "";
    goToImport(file);
  };

  const isActive = state === "hover";

  return (
    <Card
      className={`card-hover transition-colors duration-200 cursor-pointer ${isActive ? "border-primary bg-primary/5" : ""}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onClick={() => inputRef.current?.click()}
    >
      <CardContent className="px-5 py-4">
        <div className="flex items-center gap-2.5 mb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Upload className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold">Quick Import</p>
            <p className="text-[11px] text-muted-foreground">Drop a CSV or OFX file to import</p>
          </div>
        </div>

        <label className="block cursor-pointer">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.ofx,.qfx"
            className="sr-only"
            onChange={onFileInput}
          />
          <div
            className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-5 transition-all duration-200
              ${isActive ? "border-primary bg-primary/10" : "border-border/60 hover:border-primary/60 hover:bg-muted/30"}`}
          >
            <AnimatePresence mode="wait">
              {isActive ? (
                <motion.div key="hover" initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="flex flex-col items-center gap-1">
                  <FileUp className="h-5 w-5 text-primary" />
                  <p className="text-xs text-primary font-medium">Drop to continue on Import page</p>
                </motion.div>
              ) : (
                <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-1">
                  <FileText className="h-5 w-5 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground">
                    <span className="text-primary font-medium">Click to browse</span> or drag & drop
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
