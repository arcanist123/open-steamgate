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
says the update ran in the process that died, which aborts it. A client whose
connection is gone answers as a closed server (`Open` 0, ENQUEUE
SYSTEM_FAILURE) and closes `Done()`.

Tests: `enq`'s `TestContractOverSocket` runs every contract case through a client;
`wire_test.go` here the lost-connection rule both ways, `_WAIT` across the
socket, a client of a closed server.

No import of `osg/gogen/abap`; standard library and `go/enq` only.

```sh
go test -race ./enqnet/ ./enq/
```
