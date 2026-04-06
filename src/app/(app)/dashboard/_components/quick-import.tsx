"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { UploadCloud, FileText, CheckCircle2, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

type UploadState = "idle" | "dragging" | "uploading" | "success" | "error";

const ACCEPTED_TYPES = [".csv", ".ofx", ".qfx"];

export function QuickImport() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>("idle");
  const [fileName, setFileName] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const handleFile = useCallback(
    async (file: File) => {
      if (!file) return;
      const ext = "." + file.name.split(".").pop()?.toLowerCase();
      if (!ACCEPTED_TYPES.includes(ext)) {
        setErrorMsg(`Unsupported file type. Use ${ACCEPTED_TYPES.join(", ")}`);
        setState("error");
        setTimeout(() => setState("idle"), 3000);
        return;
      }
      setFileName(file.name);
      setState("uploading");

      const form = new FormData();
      form.append("file", file);
      try {
        const res = await fetch("/api/import/preview", { method: "POST", body: form });
        if (!res.ok) throw new Error();
        setState("success");
        setTimeout(() => router.push("/import?preview=1"), 800);
      } catch {
        setErrorMsg("Upload failed — please try again.");
        setState("error");
        setTimeout(() => setState("idle"), 3000);
      }
    },
    [router],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setState("dragging");
  }, []);

  const onDragLeave = useCallback(() => {
    setState("idle");
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const isDragging = state === "dragging";

  return (
    <Card
      className={`cursor-pointer transition-all duration-200 border-dashed ${
        isDragging
          ? "border-primary bg-primary/5 scale-[1.01]"
          : "border-border/60 hover:border-primary/50 hover:bg-muted/30"
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => state === "idle" && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.ofx,.qfx"
        className="hidden"
        onChange={onInputChange}
      />
      <CardContent className="flex flex-col items-center justify-center gap-2 py-6 text-center">
        <AnimatePresence mode="wait">
          {state === "idle" || state === "dragging" ? (
            <motion.div
              key="idle"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="flex flex-col items-center gap-2"
            >
              <div
                className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
                  isDragging
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                <UploadCloud className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-medium">
                  {isDragging ? "Drop to import" : "Quick Import"}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Drag & drop CSV, OFX, or QFX
                </p>
              </div>
            </motion.div>
          ) : state === "uploading" ? (
            <motion.div
              key="uploading"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="flex flex-col items-center gap-2"
            >
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <div>
                <p className="text-sm font-medium">Uploading…</p>
                <p className="text-[11px] text-muted-foreground truncate max-w-[160px]">{fileName}</p>
              </div>
            </motion.div>
          ) : state === "success" ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="flex flex-col items-center gap-2"
            >
              <CheckCircle2 className="h-8 w-8 text-emerald-500" />
              <p className="text-sm font-medium text-emerald-600">Uploaded! Redirecting…</p>
            </motion.div>
          ) : (
            <motion.div
              key="error"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="flex flex-col items-center gap-2"
            >
              <FileText className="h-8 w-8 text-rose-500" />
              <p className="text-[12px] text-rose-600 font-medium">{errorMsg}</p>
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}
