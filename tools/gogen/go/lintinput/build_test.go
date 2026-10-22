package lintinput

import (
	"encoding/json"
	"os/exec"
	"osg/gogen/lintresolve"
	"path/filepath"
	"testing"
)

// Node is a test/build oracle only. Bind its embedded policy to this fixture;
// production New binds policy per instance and never uses this global seam.
func buildSpec(t *testing.T, root string) Spec {
	t.Helper()
	repo, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", filepath.Join(repo, "tools/step3/lint-inputs.mjs"), root)
	raw, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("build oracle: %v\n%s", err, raw)
	}
	var spec Spec
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}
	saved := Resolve
	Resolve = func(root string) (Spec, error) { return lintresolve.Resolve(root, spec.Rules) }
	t.Cleanup(func() { Resolve = saved })
	return spec
}
