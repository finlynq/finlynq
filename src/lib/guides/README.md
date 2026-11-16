# AI guidance (FINLYNQ-219)

Two kinds of guidance an AI assistant reads before working in Finlynq:

- **Finlynq guides** (this folder, `modules/`): general, written by us, the same for everyone. Served by MCP `finlynq_help(topic)` and `get_guidance(module)`, and shown read-only on Settings → AI guidance.
- **Personal notes** (`notes-store.ts`, tables `user_guidance_notes` + `user_guidance_note_revisions`): one user's facts about their own money, encrypted with their key. The assistant saves them with `manage_guidance_notes`; the user sees, edits and retires them on Settings → AI guidance.

## Adding a guide module

1. Create `modules/<id>.ts` exporting `guide: GuideModule` (`id`, `title`, one-line `summary`, `order`, `markdown`).
2. Add it to `GUIDE_MODULES` in `registry.ts`.

That's all: the `finlynq_help` topic list, the `get_guidance` index and the Settings page pick it up. `tests/guidance-modules.test.ts` fails if a file isn't registered, an id repeats, a module is over 3,000 estimated tokens, or a module names an MCP tool that isn't registered.

Write for the web (HTTP) connection's tool names, in short plain sentences. Guides are information, never permission.
