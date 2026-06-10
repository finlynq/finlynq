# Hosted-mode overlay (`PF_CLOUD`)

Finlynq is a complete, fully functional application in this repository — there
are no paid features, license keys, or crippled codepaths. Self-hosted is the
product.

The **managed service** at finlynq.com additionally needs things that are
meaningless to a self-hoster: billing, hosted-account administration, quotas.
Rather than mixing that into the open-source tree, the hosted deployment
applies a build-time overlay from a private repository:

- `src/app/(cloud)/` — hosted-only pages and API routes (e.g. billing)
- `src/lib/cloud/` — hosted-only logic

Both paths are gitignored here. They are copied in on the hosted box before
`npm run build`, so:

- a self-hosted build never contains them (the routes simply don't exist),
- the public tree is never dirtied by hosted concerns,
- there is exactly one codebase to maintain.

## `PF_CLOUD`

The single environment flag marking a managed deployment. Default: unset/off.

Public code may use it only for small touchpoints (e.g. showing a Billing link
in settings when the overlay routes exist). It must never gate features —
anything functional belongs to everyone.

| Value | Meaning |
|---|---|
| unset / anything else | Self-hosted (default). No overlay, no hosted UI touchpoints. |
| `1` | Managed deployment — overlay routes present at build time. |

## Why this design

It keeps the open-source promise honest (nothing hidden, nothing gated) while
letting the managed service fund the project. The same pattern is used by
Plausible, Cal.com, and other open-core-hosting projects — the code is free,
the convenience is paid.
