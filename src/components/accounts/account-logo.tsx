"use client";

/**
 * Account logos in the UI (GH #420, 2026-11-20).
 *
 *   useAccountLogos()   which accounts have a logo (one small request)
 *   <AccountAvatar>     the logo on a neutral tile, or the letter avatar
 *   <AccountLogoEditor> fetch from the bank's website, upload, or remove
 *   toLogoPng()         draws any image onto a square canvas -> PNG data URL
 *
 * Every logo is normalized in the browser to a PNG of at most 128x128 before
 * it is saved, so the server stores and serves one small, safe format and
 * needs no image library. The logo sits on a white tile in both themes, so a
 * dark-on-transparent brand mark stays visible in dark mode.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Globe, Loader2, Trash2, Upload } from "lucide-react";
import { parseSaveError } from "@/lib/save-error";
import { cn } from "@/lib/utils";

const LOGO_MAX = 128;

/** Draw an image (data/blob URL) onto a square transparent canvas; return a PNG data URL. */
export function toLogoPng(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width || LOGO_MAX;
        const h = img.naturalHeight || img.height || LOGO_MAX;
        const side = Math.max(32, Math.min(LOGO_MAX, Math.max(w, h)));
        const canvas = document.createElement("canvas");
        canvas.width = side;
        canvas.height = side;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no canvas");
        const scale = Math.min(side / w, side / h);
        const dw = w * scale;
        const dh = h * scale;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, (side - dw) / 2, (side - dh) / 2, dw, dh);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        reject(new Error("Couldn't read that image. Try a PNG or JPEG."));
      }
    };
    img.onerror = () => reject(new Error("Couldn't read that image. Try a PNG or JPEG."));
    img.src = src;
  });
}

export function useAccountLogos() {
  const [versions, setVersions] = useState<Record<number, number>>({});
  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/accounts/logos");
      if (!res.ok) return;
      const json = (await res.json()) as { data?: { versions?: Record<number, number> } };
      setVersions(json.data?.versions ?? {});
    } catch {
      // No logos is a fine fallback: letter avatars.
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { versions, reload };
}

export function AccountAvatar({
  accountId,
  name,
  logoVersion,
  className,
  letterClassName,
}: {
  accountId: number;
  name: string | null | undefined;
  logoVersion?: number;
  /** Size + rounding, e.g. "h-7 w-7 rounded-lg". */
  className?: string;
  /** Colours for the letter fallback. */
  letterClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [logoVersion]);
  const letter = (name ?? "?").charAt(0).toUpperCase() || "?";
  if (logoVersion && !failed) {
    return (
      <div className={cn("shrink-0 flex items-center justify-center bg-white ring-1 ring-black/10 overflow-hidden", className)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/accounts/${accountId}/logo?v=${logoVersion}`}
          alt=""
          className="h-full w-full object-contain p-0.5"
          onError={() => setFailed(true)}
        />
      </div>
    );
  }
  return (
    <div className={cn("shrink-0 flex items-center justify-center font-bold", className, letterClassName)}>{letter}</div>
  );
}

export function AccountLogoEditor({
  accountId,
  name,
  logoVersion,
  onChange,
}: {
  accountId: number;
  name: string | null | undefined;
  logoVersion?: number;
  onChange: () => void;
}) {
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState<"fetch" | "upload" | "remove" | null>(null);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function save(dataUrl: string, source: "upload" | "domain", fromDomain?: string) {
    const png = await toLogoPng(dataUrl);
    const res = await fetch(`/api/accounts/${accountId}/logo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: png, source, domain: fromDomain ?? null }),
    });
    if (!res.ok) throw new Error(await parseSaveError(res, "Couldn't save the logo"));
    onChange();
  }

  async function fetchFromDomain() {
    setError("");
    setBusy("fetch");
    try {
      const res = await fetch(`/api/accounts/${accountId}/logo/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      if (!res.ok) throw new Error(await parseSaveError(res, "Couldn't get a logo from that website"));
      const json = (await res.json()) as { data?: { dataUrl?: string; domain?: string } };
      if (!json.data?.dataUrl) throw new Error("Couldn't get a logo from that website");
      await save(json.data.dataUrl, "domain", json.data.domain);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function uploadFile(file: File) {
    setError("");
    if (file.size > 5 * 1024 * 1024) {
      setError("That file is too large. Use an image under 5 MB.");
      return;
    }
    setBusy("upload");
    const url = URL.createObjectURL(file);
    try {
      await save(url, "upload");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      URL.revokeObjectURL(url);
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove() {
    setError("");
    setBusy("remove");
    try {
      const res = await fetch(`/api/accounts/${accountId}/logo`, { method: "DELETE" });
      if (!res.ok) throw new Error(await parseSaveError(res, "Couldn't remove the logo"));
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center gap-3">
        <AccountAvatar
          accountId={accountId}
          name={name}
          logoVersion={logoVersion}
          className="h-10 w-10 rounded-xl text-sm"
          letterClassName="bg-muted text-muted-foreground"
        />
        <div className="min-w-0">
          <Label>Logo</Label>
          <p className="text-xs text-muted-foreground">
            Shown instead of the letter. Fetched once and stored with your account; pages never load it from the bank.
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <Input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="Bank website, e.g. examplebank.com"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (domain.trim() && !busy) void fetchFromDomain();
            }
          }}
        />
        <Button type="button" variant="outline" size="sm" className="gap-1.5 shrink-0" disabled={!domain.trim() || !!busy} onClick={() => void fetchFromDomain()}>
          {busy === "fetch" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
          Get logo
        </Button>
      </div>
      <div className="flex gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadFile(f);
          }}
        />
        <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={!!busy} onClick={() => fileRef.current?.click()}>
          {busy === "upload" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          Upload image
        </Button>
        {logoVersion ? (
          <Button type="button" variant="ghost" size="sm" className="gap-1.5 text-destructive" disabled={!!busy} onClick={() => void remove()}>
            {busy === "remove" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Remove
          </Button>
        ) : null}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
