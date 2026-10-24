# Explicit decisions

Use `memory_query_decisions` when work depends on a user's recorded choice. Do not
infer current policy from the newest note. Legacy prose remains unclassified.

When the user explicitly sets, corrects or withdraws a choice that guides the
ongoing task or later work, save a structured decision checkpoint on your owned
active task before finishing, without requiring a separate request to record it.
A mention in the task goal or final summary does not create decision history.
Preserve the user's actual scope, including a named test-only task; do not turn a
one-response formatting preference into a lasting project policy. Keep synthetic
test choices clearly separate from real policies and label their source honestly.
Start by reading that subject to obtain the current IDs, even for a first choice.
If the scope or the intended change is unclear, ask instead of inventing a choice.

For a selected subject, preserve resolved project/repository/environment and the
explicit component/feature scope. Query with subject and use an empty string for a
common component/feature filter when needed. Omitted filters span all declared scopes. Read every subject page and follow history_next_offset as history_offset for older entries. A truncated
history or incomplete active IDs is unknown, never a valid mutation base.

On an owned active task, `memory_checkpoint(kind: decision)` accepts `decision`:
`subject`, `title`, `action` (`decide`, `replace`, `withdraw`, `propose`), `choice_key`
(omit for withdrawal), `targets`, `expected_current_ids`, optional `component_key`
and `feature_key`, and `source: {kind, reference, quote}`. Declare known components
and features on the task first. Keep the selected user's statement in body and
its actual reference/quote in source. Never invent an approval or inspect private
transcripts. `user_statement` is supplied attribution, not authenticated consent.

Use the exact full `active_record_ids` from that subject detail as expected IDs.
Replace/withdraw only explicitly selected active targets in the same scope.
Different active choice keys stay conflicting; never silently select latest.
Choice keys are explicit labels, not semantic equivalence or verified truth.
Proposals use `source.kind: agent_proposal` and action propose. Historical reports
must remain retrospective and cannot change current decisions. Withdrawing a
replacement never reactivates its ancestor. Do not use supersedes for these links.

After saving, query again and report current/previous/withdrawn/conflict separately
from correctness. All claims remain unverified. A conflict error needs a fresh
read and human intent if a choice is unclear; never auto-rewrite expected IDs or
the original retained retry. Original evidence is available by record ID.
