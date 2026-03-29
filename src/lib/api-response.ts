// Standardized API response helpers
// Format: { success: boolean, data?: T, error?: string, meta?: object }

import { NextResponse } from "next/server";

type ApiSuccessResponse<T> = {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
};

type ApiErrorResponse = {
  success: false;
  error: string;
};

export function apiSuccess<T>(data: T, meta?: Record<string, unknown>): NextResponse<ApiSuccessResponse<T>> {
  const body: ApiSuccessResponse<T> = { success: true, data };
  if (meta) body.meta = meta;
  return NextResponse.json(body);
}

export function apiError(message: string, status: number = 400): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ success: false, error: message }, { status });
}
