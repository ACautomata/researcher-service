# #786 teammate runtime acceptance

2026-10-04. Follow-up to local integration commit `6013a1b`; spec: [#786](https://github.com/ACautomata/researcher-service/issues/786), parent #747 and #742 resolution.

## Runtime and replay contract

- Every run command starts with an independent LangChain async context. Inline teammate dispatch must not inherit the leader's Pregel execution context.
- Named teammates share the parent's sandbox but have independent checkpoint threads. Only leader `spawn_teammate` creates them; teammates use `request_teammate`. Builtin anonymous `task` delegation is hidden and rejected when the teammate runtime is enabled.
- Quota is charged to the leader session. Point-to-point delivery resumes only its persisted recipient wait; delayed timeout commands are self-contained and can survive queue worker restart.
- Teammate events, including approval timeout and rejection events, use the parent session ID and top-level `teammateId`.
- `GET /api/v1/sessions/:id/messages` keeps leader `messages` unchanged and adds optional `teammates`: `id`, `name`, `task`, `status`, `messages`, `mailbox`, optional `inFlight`. The array is omitted when empty. Archived teammate history remains available. Invalidated and expired unread mail is excluded; read communication history remains visible.
- Mail and a TextTrace audit record commit atomically. Audit snapshots sender/recipient names and content hash, survives session deletion, and follows the owner's lifetime. Delivery revalidates actor activity inside that transaction.
- Archive is terminal: stale completion/status writes cannot restore an archived teammate. Closing or rewind invalidation stops active runs and retires parked scheduling while preserving checkpoints. A shared session cannot be deleted while live teammates still run or wait.

## Evidence

`server/test/teammateRuntime.test.ts` covers eight S1/S2 flows: real REST, SQLite, LangGraph checkpoints, event hub and teammate tools; only LLM/Docker/time boundaries are scripted.

1. Real spawn checkpoint crossed by rewind: archive, retire parked scheduling, invalidate unread mail, retain permanent audit.
2. Nested builtin task and direct child spawning denied; request travels through the leader mailbox.
3. Close preserves checkpoint/history, rejects delayed wake, and cannot be undone by stale status writes.
4. Mail expires across service restart, while audit survives deleting the session.
5. REST folded projection excludes expired unread mail.
6. Approval freezes only its teammate; leader completes, suspension events remain tagged, parent-addressed resolution resumes the child.
7. Delayed timeout resumes its waiter, broadcasts follow-up, rejects duplicate wake without duplicate mail.
8. Quota one: leader and two teammates concurrently live; peer-to-peer mail resumes the waiting peer; leader timeline and named child histories remain distinct.

Real Redis at temporary local port 16386 additionally verifies a delayed mailbox command survives worker shutdown/recreation. Final affected-suite run: **77 tests passed in seven files**; `npm run typecheck` and `git diff --check` passed.

Full server run before review repairs: **1415 passed, 1 test failed, 4 skipped; 113 files passed, 2 failed, 1 skipped**. Known failures: `providerDefaults.test.ts` reads the user's pre-existing modified `deploy/openclaw.json`; `pairingSmoke.test.ts` requires absent `openclaw-gw-pairing-smoke`. User configuration was preserved byte-for-byte. Review repairs were verified by the final affected-suite run.

## Review and pending integration

Matt code-review's parallel Standards and Spec reviews were repeated after repairs. No remaining blocking finding within the reviewed runtime follow-up. Review discovered and fixed archive resurrection and expired unread REST mail.

This is **not full #786 product acceptance**:

- [#793](https://github.com/ACautomata/researcher-service/issues/793): frontend REST/SSE rewrite must consume the named projection and teammate event grouping to render folded sections.
- [#781](https://github.com/ACautomata/researcher-service/issues/781): rewind/branch-switch product entry must invoke `RunService.teammatesForRewind` at the chosen checkpoint.
- [#782](https://github.com/ACautomata/researcher-service/issues/782): global file replay, write fence, and survivor mailbox notification must be integrated with that rewind flow.
- Owner plugin enablement snapshot must follow the plugin runtime when that consumer exists; this follow-up does not implement a plugin execution system. Official skill/command inheritance remains provided by #787's shared catalog and run construction.

Keep #786 open until these consumer integrations are exercised together. No conversation-only rewind endpoint is introduced here.
