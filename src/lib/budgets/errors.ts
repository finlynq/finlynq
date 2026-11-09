/** A refused budget write, with the HTTP status the routes answer with. Shared by write.ts and rule-store.ts. */
export class BudgetWriteError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
  }
}
