<!-- Thanks for contributing to agentmap! Keep the diff minimal and on-scope. -->

## What & why

<!-- One paragraph. Link the issue this addresses. -->

## Checklist

- [ ] `node --test test/` passes locally (Node 18+).
- [ ] No new runtime dependency (ts-morph stays the only one).
- [ ] Still a single published artifact (`agentmap.mjs`, `#!/usr/bin/env node` shebang intact).
- [ ] Freshness invariant intact — the cache is never served on a dirty tree / SHA mismatch; no "skip freshness" flag added.
- [ ] If `map.json` shape changed: `SCHEMA_VERSION` bumped.
- [ ] Output of shipped commands is byte-identical — unless the change *is* the output (call out any intended diff).
- [ ] Docs / CHANGELOG updated if user-facing.
