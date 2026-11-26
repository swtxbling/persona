//go:build !persona_without_phone_extra && !persona_core_only

package node

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/nwverse/persona/server/internal/nodecmd/commandport"
)

func init() { want = append(want, "phone-extra") }

// A duplicate registration would panic during init. Answering help locally also distinguishes the original command
// from phoneextra_compat.go, which must fail closed when no installed provider launcher exists.
func TestPhoneExtraDefaultUsesOriginalCLI(t *testing.T) {
	run, ok := commandport.LookupCommand("iphone")
	if !ok {
		t.Fatal("personad iphone is not registered")
	}
	var stdout, stderr bytes.Buffer
	if got := run(context.Background(), []string{"help"}, strings.NewReader(""), &stdout, &stderr); got != 0 {
		t.Fatalf("iphone help exit = %d, stderr %q", got, stderr.String())
	}
	if !strings.Contains(stdout.String(), "personad iphone pair [<udid>]") || stderr.Len() != 0 {
		t.Fatalf("iphone help stdout/stderr = %q / %q", stdout.String(), stderr.String())
	}
}
