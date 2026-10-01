// Shared fetch state for the report detail screens (Income statement, Balance
// sheet, Trends, Cash flow, Year over year): initial load, pull-to-refresh, and
// a request-sequence guard so a slow earlier response can never overwrite a
// newer one (e.g. switching Trends granularity twice quickly, or a refresh
// racing a filter change). Pass a `fetcher` memoized with useCallback — a new
// fetcher identity is what triggers a reload.
import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "../logger";
import type { ApiResponse } from "../../../../shared/types";

export interface ReportDataState<T> {
  data: T | null;
  /** First load / reload after a filter change (screen shows a spinner). */
  loading: boolean;
  /** Pull-to-refresh in flight (content stays on screen). */
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
}

export function useReportData<T>(
  fetcher: () => Promise<ApiResponse<T>>,
  logTag: string
): ReportDataState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const run = useCallback(
    async (mode: "load" | "refresh") => {
      const id = ++seq.current;
      if (mode === "load") setLoading(true);
      else setRefreshing(true);
      try {
        const res = await fetcher();
        if (id !== seq.current) return; // superseded by a newer request
        if (res.success) {
          setData(res.data);
          setError(null);
        } else {
          logger.warn(logTag, "fetch failed", { error: res.error });
          setError(res.error || "Couldn't load this report");
        }
      } catch (e) {
        if (id !== seq.current) return;
        logger.error(logTag, "fetch threw", { detail: String(e) });
        setError("Cannot connect to server");
      } finally {
        // Only the newest request settles the spinners — a stale one finishing
        // late must not hide the spinner of the request still in flight.
        if (id === seq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [fetcher, logTag]
  );

  useEffect(() => {
    void run("load");
    return () => {
      // Invalidate whatever is in flight (filter change or unmount).
      seq.current++;
    };
  }, [run]);

  const refresh = useCallback(() => {
    void run("refresh");
  }, [run]);

  return { data, loading, refreshing, error, refresh };
}
