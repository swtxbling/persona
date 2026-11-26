//go:build (persona_core_only && !persona_without_phone_extra) || persona_without_phone_extra

package node

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/nwverse/persona/server/internal/identity"
	"github.com/nwverse/persona/server/internal/nodecmd/commandport"
	"github.com/nwverse/persona/server/internal/osproc"
)

const (
	// installedIPhoneProviderLauncherEnv is an explicit test or operations override. Without it the compatibility
	// command uses only the stable, node-managed location below; it never searches PATH or installs a provider.
	installedIPhoneProviderLauncherEnv = "PERSONA_IPHONE_PROVIDER_LAUNCHER"
	installedIPhoneProviderName        = "persona-iphone-provider"
)

const installedIPhoneProviderUsage = `  personad iphone list|pair|forget|address|find|mount-ddi|call …
                           this computer's paired iPhones for phone control through the installed provider
                           (docs/extensions/iphone-pairing.md; personad iphone -h)`

func init() {
	// Only this file or phoneextra.go is in a build, so the original in-process provider and this compatibility
	// command cannot both register. The node capability itself is registered only by #16256's installed provider.
	commandport.AddCommand("iphone", installedIPhoneProviderUsage, runInstalledIPhoneProviderCommand)
}

func installedIPhoneProviderLauncher() string {
	if path := os.Getenv(installedIPhoneProviderLauncherEnv); path != "" {
		return path
	}
	name := installedIPhoneProviderName
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(identity.HomeDir(), "node-plugins", "iphone", "bin", name)
}

func checkInstalledIPhoneProviderLauncher(path string) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("%s must be an absolute path; PATH is not searched", installedIPhoneProviderLauncherEnv)
	}
	st, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("no installed iPhone provider launcher at %s", path)
	}
	if err != nil {
		return fmt.Errorf("installed iPhone provider launcher is unavailable: %w", err)
	}
	if !st.Mode().IsRegular() {
		return fmt.Errorf("installed iPhone provider launcher at %s is not a regular file", path)
	}
	if runtime.GOOS != "windows" && st.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("installed iPhone provider launcher at %s is not executable", path)
	}
	return nil
}

// installedIPhoneProviderEnvironment is the same kind of minimal environment an installed extension gets: locations,
// locale and network settings, but no hub configuration, tokens or other credentials. PERSONA_HOME is added explicitly
// so the provider reaches the existing node-local pairing store. No argument or environment value is logged here.
func installedIPhoneProviderEnvironment() []string {
	pass := []string{
		"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR",
		"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
		"SSL_CERT_FILE", "SSL_CERT_DIR",
		// The provider needs the same explicit bridge and developer-image locations as the original CLI. These are
		// paths, not credentials; do not broaden this list to hub configuration or other PERSONA_ variables.
		"PERSONA_IPHONE_BRIDGE", "PERSONA_IPHONE_DDI_DIR",
		// Windows needs these to start and locate system libraries. They carry no account or hub credential.
		"SystemRoot", "SystemDrive", "ComSpec", "PATHEXT", "OS", "PROCESSOR_ARCHITECTURE",
	}
	var base []string
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		for _, allowed := range pass {
			if name == allowed || (runtime.GOOS == "windows" && strings.EqualFold(name, allowed)) {
				base = append(base, entry)
				break
			}
		}
	}
	return identity.Environment(base, "PERSONA_HOME="+identity.HomeDir())
}

// runInstalledIPhoneProviderCommand is the old device CLI's compatibility entry when phone-extra is not linked. It
// forwards exactly the arguments and stdio it received, without a shell. It never opens or changes pairing records;
// only the explicitly installed provider can perform a requested operation.
func runInstalledIPhoneProviderCommand(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	path := installedIPhoneProviderLauncher()
	if err := checkInstalledIPhoneProviderLauncher(path); err != nil {
		fmt.Fprintf(stderr, "iPhone control is unavailable: %v\n", err)
		return 1
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
	cmd.Env = installedIPhoneProviderEnvironment()
	cmd.SysProcAttr = osproc.GroupAttr()
	cmd.Cancel = func() error { return osproc.StopGroup(cmd.Process.Pid, true) }
	cmd.WaitDelay = 2 * time.Second // a wrapper cannot hold the command's stdio open after cancellation
	err := cmd.Run()
	if err == nil {
		return 0
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() >= 0 {
		return exit.ExitCode() // the provider's own status and output pass through unchanged
	}
	if ctx.Err() != nil {
		fmt.Fprintf(stderr, "iPhone provider stopped: %v\n", ctx.Err())
		return 1
	}
	fmt.Fprintf(stderr, "iPhone provider could not run: %v\n", err)
	return 1
}
