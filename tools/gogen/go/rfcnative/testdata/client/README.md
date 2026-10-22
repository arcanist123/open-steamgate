# Public RFC client session

`go run ./rfcnative/testdata/client PORT` uses open-rfc-go's public pooled
client and pins a session for ADT discovery followed by CHECKRUN. It prints
errors by stage as well as successful results; the client can require metadata
outside the bridge's advertised subset. Synthetic demo credentials only.
