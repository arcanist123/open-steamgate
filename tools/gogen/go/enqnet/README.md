# enqnet -- the lock table over a socket (ENQ E3)

The lock server of `go/enq` for several processes (ADR 0008 E3, ADR 0010 slice 3): the gateway
(`go/osgw`) owns one `enq.Server` and serves it here; every osgo sidecar's ENQUEUE is a client.

The same table for several processes: `Serve(srv, ln, ServeOptions)` /
`ServeConn(srv, conn, o)` serve newline-delimited JSON over a stream (a Unix
socket in practice); `Dial(network, addr, Hello{Generation, Name})` /
`NewClient(conn, hello)` give a `*Client`, an `enq.Locks` like the in-process `*enq.Server`, so `adtenq`, `adtlock` and
`adtsystem` run unchanged against a table in another process.
One attempt per ENQUEUE crosses the socket; the `_WAIT` schedule
runs in the client (`enq.Retry`), so a waiting session never holds the server.

Owner identity: a connection's hello names its generation, and a session it
opens is `enq.Server.OpenIn(user, generation)`: an owner is (generation, session, LUW
= `UpdateOwner`), and `Row.Generation` says whose a row is. When a connection
goes, every session it opened and did not `End` is `Lost(sid, inline)`: its
dialog halves and its open LUW's halves go (the same release as `End`);
halves of an update owner a COMMIT handed to the update task stay until
`UpdateDone` -- from any connection -- unless `ServeOptions.InlineUpdates`
says the update ran in the process that died; then they go too.

Nothing is aborted there: the release is sound because of an ordering in
osgo, not because the lock server can stop anything. osgo's update task runs
inline, and an explicit COMMIT WORK (`GeneratedCommitWork`, `abap/luw.go`)
commits the database **before** its host hook hands the LUW's locks over and
says `UpdateDone` (`adtlock.Host.Commit`). A process that dies before that
database commit leaves no rows (its transaction rolls back with it); one that
dies after it leaves rows that are durable, and its locks go after them,
never before. `abap`'s `TestGeneratedLUWDatabaseOrder` fails if the order is
turned round. One older divergence stays: a stateful LUW that spans dialog
steps commits each step's database work, inline-update writes included, at
the end of that step, before its COMMIT WORK; a crash between the two keeps
those rows and releases the locks, where a system would have thrown the
unrun update away.

A connection can also break while its process lives on, and that process
could still commit. `ServeOptions.BeforeRelease` runs before anything is
released: the gateway kills the sidecar the hello's `PID` names and waits for
its exit there, so locks never go while their process can still write.

The hello carries `ProtocolVersion` both ways; a server refuses another
version and a client refuses a server that answers with another one or none,
both at `Dial`, wrapping `ErrProtocol`. A request the server refuses (an
unknown op, a session another connection opened) answers the caller as a
closed server -- ENQUEUE SYSTEM_FAILURE, counted in `Client.Refused` -- and
never panics in the work process. `UpdateDone` alone may name a session of
another connection (an update task outside the process that committed).
A client whose connection is gone answers as a closed server (`Open` 0,
ENQUEUE SYSTEM_FAILURE) and closes `Done()`.

Tests: `enq`'s `TestContractOverSocket` runs every contract case through a client;
`wire_test.go` here the lost-connection rule both ways, `_WAIT` across the
socket, a client of a closed server, the version check at dial, a refusal as
SYSTEM_FAILURE, `BeforeRelease` before the release.

No import of `osg/gogen/abap`; standard library and `go/enq` only.

```sh
go test -race ./enqnet/ ./enq/
```
