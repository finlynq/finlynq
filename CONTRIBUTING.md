# Contributing to Finlynq

Thank you for your interest in contributing! Finlynq is a community project and all contributions are welcome.

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/finlynq.git`
3. Install dependencies: `cd finlynq && npm install`
4. Set up Postgres locally, or use Docker: `docker compose up db -d`
5. Copy `.env.example` to `.env.local` and fill in your values
6. Apply the schema: `npm run db:push`
7. Start the dev server: `npm run dev`

## Branch Strategy

- `main` — production, never target this directly
- `staging` — pre-production/demo, never target this directly
- `dev` — **all PRs must target `dev`**

Always branch from `dev`:
```bash
git checkout dev
git pull origin dev
git checkout -b feature/your-feature-name
```

## PR Guidelines

- One feature or fix per PR — keep it focused
- Target the `dev` branch
- Make sure `npm run build` passes locally before submitting
- Update `CHANGELOG.md` if your change is user-facing

## PR Title Format

```
feat(scope): short description
fix(scope): short description
chore(scope): short description
docs(scope): short description
```

Examples:
- `feat(mcp): add portfolio-history tool`
- `fix(import): handle duplicate OFX transaction IDs`
- `docs(readme): add self-hosting instructions`

## Areas Where Contributions Are Especially Welcome

- Bank statement CSV/OFX parsers for different banks and regions
- New MCP tools in `mcp-server/`
- UI improvements and accessibility
- Internationalization (i18n)
- Documentation and getting-started guides
- Bug fixes and performance improvements

## Code Conventions

- TypeScript throughout — avoid `any`
- Follow patterns already established in the codebase (see `CLAUDE.md`)
- Use the shared color palette from `src/lib/chart-colors.ts`
- shadcn/ui v4 uses `@base-ui/react` — use the `render` prop pattern, not `asChild`
- Form validation: use `useState<Record<string, string>>({})` for errors

## Questions?

Open a [GitHub Discussion](https://github.com/finlynq/finlynq/discussions) — happy to help you get started.
