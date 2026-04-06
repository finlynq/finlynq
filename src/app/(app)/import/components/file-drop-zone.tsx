"use client";

import { useRef, useState, useCallback } from "react";
import { Upload, FileText, Landmark } from "lucide-react";

interface FileDropZoneProps {
  onFileSelected: (file: File) => void;
  accept?: string;
  disabled?: boolean;
}

const ACCEPT = ".csv,.ofx,.qfx";

export function FileDropZone({ onFileSelected, accept = ACCEPT, disabled }: FileDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragIn = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.items?.length) setIsDragging(true);
  }, []);

  const handleDragOut = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFileSelected(file);
  }, [onFileSelected]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFileSelected(file);
    // Reset so same file can be re-uploaded
    e.target.value = "";
  }, [onFileSelected]);

  return (
    <div
      onClick={() => !disabled && inputRef.current?.click()}
      onDragEnter={handleDragIn}
      onDragLeave={handleDragOut}
      onDragOver={handleDrag}
      onDrop={handleDrop}
      className={`
        relative flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 transition-colors
        ${isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50"}
        ${disabled ? "pointer-events-none opacity-50" : ""}
      `}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handleChange}
        className="hidden"
      />
      <div className="flex items-center gap-2">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          <Upload className="h-6 w-6 text-primary" />
        </div>
      </div>
      <div className="text-center">
        <p className="text-sm font-medium">
          {isDragging ? "Drop your file here" : "Drag & drop or click to upload"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Supports CSV, OFX, and QFX files
        </p>
      </div>
      <div className="flex items-center gap-3 text-muted-foreground">
        <div className="flex items-center gap-1 text-xs">
          <FileText className="h-3.5 w-3.5" />
          CSV
        </div>
        <div className="flex items-center gap-1 text-xs">
          <Landmark className="h-3.5 w-3.5" />
          OFX/QFX
        </div>
      </div>
    </div>
  );
}
