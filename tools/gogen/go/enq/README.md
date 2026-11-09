# enq -- the lock server (ENQ E1)

What: the table ENQUEUE_<obj>, DEQUEUE_<obj>, DEQUEUE_ALL and ENQUEUE_READ work on, as measured on a system
(`docs/enq-contract.md`, fixtures in `test/fixtures/enq/contract.json`). `tools/osd-enq.mjs` is the same
server for Node and the browser, gated on the same cases.

API: `New(instance)`, then per session `Open(user)` (or `OpenIn(user, generation)`), `Enqueue(sid, req, wait)`,
`EnqueueWith(sid, req, wait, sleep)`, `Dequeue`, `DequeueAll`,
`Commit(sid, updated) -> ended`, `UpdateDone(sid, ended)`, `Rollback`, `End`, `Lost(sid, inlineUpdates)`, `Read(filter)`, `UpdateOwner`; `Close`.

Invariants: one goroutine owns the table and runs every request sent on its channel (no mutex); `_WAIT`
waits in the caller between attempts. A session has a dialog owner (_SCOPE 1) and an update owner per LUW
(_SCOPE 2); the conflicting lock taken first decides 601 or 602. No import of go/abap.

`Locks` is the interface the callers take (`adtenq`, `adtlock`, `adtsystem`): this `*Server` in one
process, or an `enqnet.Client` of a server in another (the E3 socket, `go/enqnet`, ADR 0010 slice 3).
`OpenIn(user, generation)` makes the owner (generation, session, LUW = `UpdateOwner`) and stamps
`Row.Generation`; `Lost(sid, inlineUpdates)` ends the session of a process that died (the release of
`End`, plus the halves of handed-over update owners when the update ran inside that process);
`Retry` is the `_WAIT` schedule a remote client runs on its side. `RunContract` (a test export) runs
the contract against any `Locks`; `socket_contract_test.go` runs it through `go/enqnet`.
