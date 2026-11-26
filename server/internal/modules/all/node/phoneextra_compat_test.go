//go:build (persona_core_only && !persona_without_phone_extra) || persona_without_phone_extra

package node

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/moduleswitch"
	"github.com/nwverse/persona/server/internal/node/iphoneport"
	"github.com/nwverse/persona/server/internal/nodecmd/commandport"
	"github.com/nwverse/persona/server/internal/osproc"
)

const fakeIPhoneProviderConfig = ".fake-installed-iphone-provider.json"

type fakeIPhoneProviderOptions struct {
	Stdout string `json:"stdout,omitempty"`
	Stderr string `json:"stderr,omitempty"`
	Exit   int    `json:"exit,omitempty"`
	Block  bool   `json:"block,omitempty"`
}

// TestMain turns this test binary into the fake installed provider when a child gets a PERSONA_HOME with the marker.
// No test-only arguments are inserted: the helper sees exactly the argv that the compatibility command received.
func TestMain(m *testing.M) {
	home := os.Getenv("PERSONA_HOME")
	if home != "" {
		if raw, err := os.ReadFile(filepath.Join(home, fakeIPhoneProviderConfig)); err == nil {
			var opts fakeIPhoneProviderOptions
			if json.Unmarshal(raw, &opts) != nil {
				os.Exit(98)
			}
			os.Exit(fakeIPhoneProvider(home, opts))
		}
	}
	os.Exit(m.Run())
}

func fakeIPhoneProvider(home string, opts fakeIPhoneProviderOptions) int {
	stdin, err := io.ReadAll(os.Stdin)
	if err != nil {
		return 97
	}
	// Record only whether sensitive variables are present, never their values. The argv and stdin fixtures are benign.
	trace := struct {
		Args  []string        `json:"args"`
		Stdin string          `json:"stdin"`
		Env   map[string]bool `json:"env"`
	}{Args: os.Args[1:], Stdin: string(stdin), Env: map[string]bool{}}
	for _, name := range []string{
		"PERSONA_HOME", "PATH", "PERSONA_IPHONE_BRIDGE", "PERSONA_IPHONE_DDI_DIR",
		"PERSONA_TEST_PAIRING_PASSCODE", "PERSONA_TEST_HUB_TOKEN", "JARVIS_HUB_TOKEN", "DATABASE_URL",
		installedIPhoneProviderLauncherEnv,
	} {
		_, trace.Env[name] = os.LookupEnv(name)
	}
	raw, err := json.Marshal(trace)
	if err != nil || os.WriteFile(filepath.Join(home, "provider-trace.json"), raw, 0o600) != nil {
		return 96
	}
	if opts.Block {
		pid := []byte(strconv.Itoa(os.Getpid()))
		if err := os.WriteFile(filepath.Join(home, "provider-started"), pid, 0o600); err != nil {
			return 95
		}
	}
	_, _ = io.WriteString(os.Stdout, opts.Stdout)
	_, _ = io.WriteString(os.Stderr, opts.Stderr)
	if opts.Block {
		for {
			time.Sleep(time.Hour)
		}
	}
	return opts.Exit
}

func writeFakeIPhoneProvider(t *testing.T, home string, opts fakeIPhoneProviderOptions) {
	t.Helper()
	raw, err := json.Marshal(opts)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, fakeIPhoneProviderConfig), raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func writePairingFixture(t *testing.T, home string) map[string]string {
	t.Helper()
	dir := filepath.Join(home, "iphone", "00000000-TESTPHONE0001")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"device.json":    "{\"udid\":\"00000000-TESTPHONE0001\",\"name\":\"Existing phone\"}\n",
		"pairing.record": "test-only opaque pairing bytes\x00\xff\n",
	}
	for name, contents := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return pairingSnapshot(t, home)
}

func pairingSnapshot(t *testing.T, home string) map[string]string {
	t.Helper()
	root := filepath.Join(home, "iphone")
	out := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		out[rel] = string(raw)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func requirePairingUnchanged(t *testing.T, home string, before map[string]string) {
	t.Helper()
	if after := pairingSnapshot(t, home); !reflect.DeepEqual(after, before) {
		t.Fatal("pairing state changed")
	}
}

func compatCommand(t *testing.T) commandport.Command {
	t.Helper()
	run, ok := commandport.LookupCommand("iphone")
	if !ok {
		t.Fatal("personad / persona-node iphone compatibility command is not registered")
	}
	return run
}

func prepareFakeIPhoneProvider(t *testing.T, opts fakeIPhoneProviderOptions) (string, commandport.Command, map[string]string) {
	t.Helper()
	home := t.TempDir()
	before := writePairingFixture(t, home)
	writeFakeIPhoneProvider(t, home, opts)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	exe, err = filepath.Abs(exe)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PERSONA_HOME", home)
	t.Setenv(installedIPhoneProviderLauncherEnv, exe)
	t.Setenv("PERSONA_IPHONE_BRIDGE", filepath.Join(home, "bin", "persona-iphone-bridge"))
	t.Setenv("PERSONA_IPHONE_DDI_DIR", filepath.Join(home, "ddi"))
	t.Setenv("PERSONA_TEST_PAIRING_PASSCODE", "test-only-pairing-passcode")
	t.Setenv("PERSONA_TEST_HUB_TOKEN", "test-only-hub-token")
	t.Setenv("JARVIS_HUB_TOKEN", "test-only-legacy-hub-token")
	t.Setenv("DATABASE_URL", "postgres://test-only:not-forwarded@example.invalid/persona")
	return home, compatCommand(t), before
}

func readProviderTrace(t *testing.T, home string) (args []string, stdin string, env map[string]bool) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(home, "provider-trace.json"))
	if err != nil {
		t.Fatal(err)
	}
	var trace struct {
		Args  []string        `json:"args"`
		Stdin string          `json:"stdin"`
		Env   map[string]bool `json:"env"`
	}
	if err := json.Unmarshal(raw, &trace); err != nil {
		t.Fatal(err)
	}
	return trace.Args, trace.Stdin, trace.Env
}

func TestIPhoneCompatOnlyRegistersTheCLI(t *testing.T) {
	compatCommand(t)
	if got := iphoneport.Get(moduleswitch.Set{}); got != nil {
		t.Fatal("the compatibility CLI unexpectedly registered the in-process node provider")
	}
}

func TestIPhoneCompatStableLauncherLocation(t *testing.T) {
	home := t.TempDir()
	t.Setenv("PERSONA_HOME", home)
	t.Setenv(installedIPhoneProviderLauncherEnv, "")
	name := installedIPhoneProviderName
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	want := filepath.Join(home, "node-plugins", "iphone", "bin", name)
	if got := installedIPhoneProviderLauncher(); got != want {
		t.Fatalf("launcher = %q, want %q", got, want)
	}
}

func TestIPhoneCompatForwardsArgvStdioAndExitCode(t *testing.T) {
	tests := []struct {
		name       string
		args       []string
		stdin      string
		opts       fakeIPhoneProviderOptions
		wantStatus int
	}{
		{
			name:  "list preserves opaque arguments and shell punctuation literally",
			args:  []string{"list", "--json", "argument with spaces", `{"literal":"; echo not-a-shell"}`},
			stdin: "first stdin line\nsecond stdin line\n",
			opts:  fakeIPhoneProviderOptions{Stdout: "provider stdout\n", Stderr: "provider stderr\n"},
		},
		{
			name:  "pair forwards stdin",
			args:  []string{"pair", "00000000-TESTPHONE0001"},
			stdin: "pair stdin\n",
			opts:  fakeIPhoneProviderOptions{Stdout: "paired\n"},
		},
		{
			name:       "forget failure returns provider status and preserves existing bytes",
			args:       []string{"forget", "00000000-TESTPHONE0001"},
			stdin:      "forget stdin\n",
			opts:       fakeIPhoneProviderOptions{Stdout: "partial stdout\n", Stderr: "provider failure\n", Exit: 37},
			wantStatus: 37,
		},
		{
			name:  "call forwards current operation and JSON",
			args:  []string{"call", "00000000-TESTPHONE0001", "device_info", `{}`},
			stdin: "call stdin\n",
			opts:  fakeIPhoneProviderOptions{Stdout: "{\"ok\":true}\n"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			home, run, before := prepareFakeIPhoneProvider(t, test.opts)
			var stdout, stderr bytes.Buffer
			if got := run(context.Background(), test.args, strings.NewReader(test.stdin), &stdout, &stderr); got != test.wantStatus {
				t.Fatalf("exit status = %d, want %d", got, test.wantStatus)
			}
			if stdout.String() != test.opts.Stdout || stderr.String() != test.opts.Stderr {
				t.Fatalf("stdout/stderr = %q / %q, want %q / %q", stdout.String(), stderr.String(), test.opts.Stdout, test.opts.Stderr)
			}
			args, stdin, env := readProviderTrace(t, home)
			if !reflect.DeepEqual(args, test.args) {
				t.Fatalf("argv = %#v, want %#v", args, test.args)
			}
			if stdin != test.stdin {
				t.Fatalf("stdin = %q, want %q", stdin, test.stdin)
			}
			if !env["PERSONA_HOME"] || !env["PATH"] || !env["PERSONA_IPHONE_BRIDGE"] || !env["PERSONA_IPHONE_DDI_DIR"] {
				t.Fatalf("provider did not get its home and required operational paths: %#v", env)
			}
			for _, name := range []string{"PERSONA_TEST_PAIRING_PASSCODE", "PERSONA_TEST_HUB_TOKEN", "JARVIS_HUB_TOKEN", "DATABASE_URL", installedIPhoneProviderLauncherEnv} {
				if env[name] {
					t.Errorf("provider received sensitive or launcher variable %s", name)
				}
			}
			requirePairingUnchanged(t, home, before)
		})
	}
}

func TestIPhoneCompatMissingLauncherFailsClosed(t *testing.T) {
	t.Run("default location", func(t *testing.T) {
		home := t.TempDir()
		before := writePairingFixture(t, home)
		t.Setenv("PERSONA_HOME", home)
		t.Setenv(installedIPhoneProviderLauncherEnv, "")
		var stdout, stderr bytes.Buffer
		if got := compatCommand(t)(context.Background(), []string{"call", "00000000-TESTPHONE0001", "device_info"}, strings.NewReader("unused"), &stdout, &stderr); got != 1 {
			t.Fatalf("exit status = %d, want 1", got)
		}
		if stdout.Len() != 0 || !strings.Contains(stderr.String(), "no installed iPhone provider launcher") {
			t.Fatalf("stdout/stderr = %q / %q", stdout.String(), stderr.String())
		}
		requirePairingUnchanged(t, home, before)
	})
	t.Run("missing override does not log arguments", func(t *testing.T) {
		home := t.TempDir()
		before := writePairingFixture(t, home)
		t.Setenv("PERSONA_HOME", home)
		t.Setenv(installedIPhoneProviderLauncherEnv, filepath.Join(home, "missing-provider"))
		secret := "test-only-pairing-passcode-argument"
		var stdout, stderr bytes.Buffer
		if got := compatCommand(t)(context.Background(), []string{"pair", secret}, strings.NewReader("unused"), &stdout, &stderr); got != 1 {
			t.Fatalf("exit status = %d, want 1", got)
		}
		if strings.Contains(stderr.String(), secret) {
			t.Fatal("launcher failure logged a pairing argument")
		}
		requirePairingUnchanged(t, home, before)
	})
	t.Run("relative override never searches PATH", func(t *testing.T) {
		home := t.TempDir()
		before := writePairingFixture(t, home)
		bin := t.TempDir()
		if err := os.WriteFile(filepath.Join(bin, installedIPhoneProviderName), []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", bin)
		t.Setenv("PERSONA_HOME", home)
		t.Setenv(installedIPhoneProviderLauncherEnv, installedIPhoneProviderName)
		var stdout, stderr bytes.Buffer
		if got := compatCommand(t)(context.Background(), []string{"list"}, strings.NewReader(""), &stdout, &stderr); got != 1 {
			t.Fatalf("exit status = %d, want 1", got)
		}
		if !strings.Contains(stderr.String(), "PATH is not searched") {
			t.Fatalf("stderr = %q", stderr.String())
		}
		requirePairingUnchanged(t, home, before)
	})
}

func TestIPhoneCompatExecutionFailurePreservesPairing(t *testing.T) {
	home := t.TempDir()
	before := writePairingFixture(t, home)
	launcher := filepath.Join(home, "not-executable-provider")
	if err := os.WriteFile(launcher, []byte("not an installed provider"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PERSONA_HOME", home)
	t.Setenv(installedIPhoneProviderLauncherEnv, launcher)
	var stdout, stderr bytes.Buffer
	if got := compatCommand(t)(context.Background(), []string{"forget", "00000000-TESTPHONE0001"}, strings.NewReader("unused"), &stdout, &stderr); got != 1 {
		t.Fatalf("exit status = %d, want 1", got)
	}
	if runtime.GOOS != "windows" && !strings.Contains(stderr.String(), "not executable") {
		t.Fatalf("stderr = %q", stderr.String())
	}
	requirePairingUnchanged(t, home, before)
}

func TestIPhoneCompatCancellationStopsProviderAndPreservesPairing(t *testing.T) {
	home, run, before := prepareFakeIPhoneProvider(t, fakeIPhoneProviderOptions{Block: true})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	type result struct {
		status int
		stdout string
		stderr string
	}
	done := make(chan result, 1)
	go func() {
		var stdout, stderr bytes.Buffer
		status := run(ctx, []string{"pair", "00000000-TESTPHONE0001"}, strings.NewReader("cancel this provider\n"), &stdout, &stderr)
		done <- result{status, stdout.String(), stderr.String()}
	}()
	var pid int
	deadline := time.Now().Add(10 * time.Second)
	for {
		raw, err := os.ReadFile(filepath.Join(home, "provider-started"))
		if err == nil {
			pid, err = strconv.Atoi(string(raw))
			if err != nil {
				t.Fatal(err)
			}
			break
		}
		if !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatal("fake provider did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case got := <-done:
		if got.status != 1 || !strings.Contains(got.stderr, "context canceled") {
			t.Fatalf("cancel result = %+v, want status 1 and context cancellation", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("provider did not stop after context cancellation")
	}
	for osproc.Alive(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("provider process %d is still alive", pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
	requirePairingUnchanged(t, home, before)
}
