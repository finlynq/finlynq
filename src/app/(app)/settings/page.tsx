import { redirect } from "next/navigation";

/**
 * /settings landing — server-side redirect to /settings/general.
 *
 * The 1573-line monolith was split into 8 grouped sub-pages (issue #57).
 * Inbound deep links to bare /settings keep working via this redirect.
 */
export default function SettingsIndex(): never {
  redirect("/settings/general");
}
