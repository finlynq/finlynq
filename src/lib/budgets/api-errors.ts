import { apiError } from "@/lib/api-response";
import { BudgetWriteError } from "./write";

/** `apiHandler` mapError for the budget write routes. */
export const budgetMapError = (err: unknown) =>
  err instanceof BudgetWriteError ? apiError(err.message, err.status) : null;
