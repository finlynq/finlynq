/**
 * Type declarations for the runtime-patched .all(), .get(), .run() methods
 * added by src/db/pg-shim.ts to Drizzle ORM PG query builders.
 *
 * At runtime, pg-shim.ts patches these methods onto the prototype of each
 * PG query builder class. This declaration file makes TypeScript aware of
 * them so call sites compile without errors.
 */

import type { PgDeleteBase } from "drizzle-orm/pg-core/query-builders/delete";
import type { PgInsertBase } from "drizzle-orm/pg-core/query-builders/insert";
import type { PgUpdateBase } from "drizzle-orm/pg-core/query-builders/update";
import type { PgSelectBase } from "drizzle-orm/pg-core/query-builders/select";

declare module "drizzle-orm/pg-core/query-builders/select" {
  interface PgSelectBase<
    TTableName,
    TSelection,
    TSelectMode,
    TNullabilityMap,
    TDynamic,
    TExcludedMethods,
    TResult,
    TSelectedFields,
  > {
    /** Return all rows (same as awaiting the builder). Patched by pg-shim. */
    all(): Promise<TResult>;
    /** Return the first row or undefined. Patched by pg-shim. */
    get(): Promise<TResult extends (infer U)[] ? U | undefined : TResult>;
    /** Execute without returning rows. Patched by pg-shim. */
    run(): Promise<TResult>;
  }
}

declare module "drizzle-orm/pg-core/query-builders/insert" {
  interface PgInsertBase<
    TTable,
    TQueryResult,
    TSelectedFields,
    TReturning,
    TDynamic,
    TExcludedMethods,
  > {
    all(): Promise<TReturning extends undefined ? any : TReturning[]>;
    get(): Promise<TReturning extends undefined ? any : TReturning extends (infer U)[] ? U | undefined : TReturning>;
    run(): Promise<any>;
  }
}

declare module "drizzle-orm/pg-core/query-builders/update" {
  interface PgUpdateBase<
    TTable,
    TQueryResult,
    TFrom,
    TSelectedFields,
    TReturning,
    TNullabilityMap,
    TJoins,
    TDynamic,
    TExcludedMethods,
  > {
    all(): Promise<TReturning extends undefined ? any : TReturning[]>;
    get(): Promise<TReturning extends undefined ? any : TReturning extends (infer U)[] ? U | undefined : TReturning>;
    run(): Promise<any>;
  }
}

declare module "drizzle-orm/pg-core/query-builders/delete" {
  interface PgDeleteBase<
    TTable,
    TQueryResult,
    TSelectedFields,
    TReturning,
    TDynamic,
    TExcludedMethods,
  > {
    all(): Promise<TReturning extends undefined ? any : TReturning[]>;
    get(): Promise<TReturning extends undefined ? any : TReturning extends (infer U)[] ? U | undefined : TReturning>;
    run(): Promise<any>;
  }
}
