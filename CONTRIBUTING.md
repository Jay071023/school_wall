# Contributing to Campus Wall

Thanks for helping improve the public mirror. It is safe to discuss and change application code here, but it must remain independent from any production campus service.

## Before you start

1. Search existing issues before opening a new one.
2. Create a focused branch from `main` and keep one concern per pull request.
3. Copy `.env.example` to a local `.env`; never commit real credentials, private domains, user content, uploads, logs or database files.

## Making a change

1. Read `docs/PROJECT_INDEX.md` to find the responsible page, route, service and test.
2. Keep `frontend/` and `public/` identical when changing HTML, page JavaScript or CSS.
3. Cover the affected desktop and mobile layout, including `768px/769px`, empty, loading, error and permission states where applicable.
4. Update the code map when an entry point moves or its responsibility changes.

## Verify before opening a pull request

```powershell
npm run check:mirrors
npm run check:privacy
npm run check:deployment
npm test
git diff --check
```

State the commands actually run and any checks you could not run in the pull-request description.

## Review expectations

Pull requests need a clear trigger, expected behavior and focused diff. Maintainers may request tests, responsive evidence or removal of material that could identify a real school, student, service or credential.

By submitting a contribution, you agree that it is provided under the repository's [Apache-2.0 license](LICENSE). Preserve [NOTICE](NOTICE) when distributing the project or a derivative.
