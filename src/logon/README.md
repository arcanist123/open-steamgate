# src/logon -- who sends the request

`ZCL_OSD_LOGON` answers one question: which user a request runs for. On a
system that is `SY-UNAME`, set by the logon. This tree has no logon and one
`SY-UNAME` for the whole process ([tools/osd-identity.mjs](../../tools/osd-identity.mjs)),
so a RAP draft could not tell its owner from anybody else
([docs/rap-runtime.md](../../docs/rap-runtime.md), R9).

- `ENTER( authorization )`: called by the HTTP fronts (`ZCL_STG_HTTP_HANDLER`,
  `ZCL_OSD_V4_HTTP`) with the request's `Authorization` header at entry. The
  user name of a `Basic` credential becomes the request's user, upper case.
  **The password is not checked**: identification, not authentication.
- `LEAVE( )`: called by the same fronts when the request is answered; the
  user ends with the request.
- `USER( )`: that user, or `SY-UNAME` when the request carried none (and in
  ABAP Unit, EML and every caller outside an HTTP request).
- `SET( user )`: for a test, run as that user.

Read by the RAP runtime (`ZCL_OSD_RAP_RUNTIME`: the managed `*_BY` audit
fields of every managed BO, draft or not; the draft's owner in
`ZOSD_DRAFT_ADM`, the owner lock; `ZCL_OSD_RAP_DRAFT`: which drafts a user
sees; `ZCL_OSD_DRAFT_ADM_CALC`: `DraftIsCreatedByMe` and its siblings).
Nothing else in the tree asks yet. `SY-UNAME` itself is untouched.
