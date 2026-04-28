/**
 * Polyfill .get(), .all(), .run() on Drizzle PG query builders
 */
export async function patchDrizzlePgCompat() {
  try {
    const pgCore = await import("drizzle-orm/pg-core");
    const classNames = ["PgSelectBase", "PgInsertBase", "PgUpdateBase", "PgDeleteBase"];
    let patched = 0;

    for (const name of classNames) {
      const Cls = (pgCore as any)[name];
      if (!Cls?.prototype) continue;
      
      const proto = Cls.prototype;
      if (!proto.get) {
        proto.get = async function(this: any) {
          const r = await this;
          return Array.isArray(r) ? r[0] : r;
        };
        patched++;
      }
      if (!proto.all) {
        proto.all = async function(this: any) {
          return await this;
        };
        patched++;
      }
      if (!proto.run) {
        proto.run = async function(this: any) {
          return await this;
        };
        patched++;
      }
    }
    console.log("[pg-compat] Patched " + patched + " methods on PG query builders");
  } catch (e: any) {
    console.error("[pg-compat] Failed:", e?.message || e);
  }
}
