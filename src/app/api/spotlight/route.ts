import { NextResponse } from "next/server";
import { getSpotlightItems } from "@/lib/spotlight";
import { requireUnlock } from "@/lib/require-unlock";

export async function GET() {
  const locked = requireUnlock(); if (locked) return locked;
  const items = getSpotlightItems();
  return NextResponse.json({ items });
}
