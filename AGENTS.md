# Campus Wall public mirror

This worktree is a public, sanitized mirror. Read `docs/PROJECT_INDEX.md` before making a change.

- Do not add production data, uploads, logs, backups, real credentials, private endpoints or deployment configuration.
- Do not run production deployments from this mirror. GitHub `main` is for reviewed public-source updates only.
- Keep `frontend/` and `public/` mirrored after HTML, page JavaScript or CSS changes; run `npm run check:mirrors`.
- Use `769px+` for desktop layout and `768px-` for mobile layout. Check empty, loading, error and permission states when they are affected.
- Run affected tests, `npm run check:privacy`, `npm run check:deployment` and `git diff --check` before a pull request.
- Update `docs/PROJECT_INDEX.md` when a public page, route, service, test or documentation entry changes responsibility or location.
