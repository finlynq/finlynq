/**
 * Same-origin redirect-target validation. Pure + client-safe: shared by the
 * zero-click login routes (`?next=`) and the /cloud sign-in page
 * (`?redirect=`), which until 2026-10-07 pushed its param straight into
 * `router.push` unchecked.
 *
 *   - Must start with `/`
 *   - Must NOT start with `//` (that's a protocol-relative URL — `//evil.com`
 *     resolves to `https://evil.com`, an open-redirect bait-and-switch)
 *   - Must NOT contain `\` (Windows-style backslash; some path normalizers
 *     treat `\\evil.com` like `//evil.com`)
 */
export function isSafeNext(next: string | null | undefined): next is string {
  if (!next) return false;
  if (!next.startsWith("/")) return false;
  if (next.startsWith("//")) return false;
  if (next.includes("\\")) return false;
  return true;
}
