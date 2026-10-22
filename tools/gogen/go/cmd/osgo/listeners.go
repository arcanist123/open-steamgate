package main

import (
	"flag"
	"osg/gogen/hostports"
)

func selectedPort(value string, explicit bool, env func(string) string) (int, string, error) {
	return hostports.SelectedHTTP(value, explicit, env)
}

type httpsOptions struct{ port, cert, key *string }

func httpsFlags() httpsOptions {
	return httpsOptions{
		flag.String("tls-port", "", "HTTPS port (STG_TLS_PORT, else 443nn with INSTANCE; 0: off)"),
		flag.String("tls-cert", "", "PEM certificate (OSD_TLS_CERT, else OSD_TLS_DIR/osd.crt or <root>/.local/tls/osd.crt)"),
		flag.String("tls-key", "", "PEM private key (OSD_TLS_KEY, else beside osd.crt as osd.key)"),
	}
}

func (o httpsOptions) selected(root string, env func(string) string) (hostports.HTTPS, error) {
	explicit := map[string]bool{}
	flag.Visit(func(f *flag.Flag) { explicit[f.Name] = true })
	return hostports.SelectedHTTPS(root, *o.port, *o.cert, *o.key, explicit, env)
}
