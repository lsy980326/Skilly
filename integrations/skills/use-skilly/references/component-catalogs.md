### Component-specific catalogs

Use the known resolved component as `component` on `memory_query_plans`,
`memory_list_skills` and `memory_recovery_status` when the current schema exposes
it. Use `unclassified` only to find missing explicit links, never to infer them.
The filter is applied before pagination. Plans are selected by item declarations;
a selected mixed plan's progress and detail retain the whole-plan denominator.
Skills are classified by exact installations joined to explicitly allowed public
project bindings, not by their text. `installations_total` counts all installations;
the short installation preview respects the component filter. A saved file
observation never proves the host loaded or executed a skill.

A host may explicitly provide `skilly.components.json` beside `skilly.project.json`
with `{ "version": 1, "projects": ["/absolute/approved/project"] }` to declare
additional public binding roots (at most 15 plus the launched root). This is an
optional local allowlist, not a project discovery mechanism. Never create or
broaden it without authorized connection setup, follow roots from DB records,
scan siblings, or read private Codex config. A moved root needs a reviewed update.
Missing/invalid allowlists must not silently broaden access.

For a comparison with the storage-problem screen, request
`memory_recovery_status(include_rejected: true, component: ...)`. Its default
retains the older pending-only listing. MCP remains in the resolved repository
and environment and lists oldest requests first; the screen shows the service
scope, usually latest first. Compare request IDs and delivery states within the
same scope, not row position or total counts. Rejected requests without retained
input cannot be replayed. Empty results never prove zero missing records.
If a field is absent, disclose the old connection schema and check a fresh
supported connection; do not guess a tool or rewrite historical records.
