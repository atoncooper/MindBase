package tests

import (
	"app-sandbox/internal/runtime"
)

// RuntimeDefaults is the canned success behaviour used by most tests.
func RuntimeDefaults() runtime.FakeOptions {
	return runtime.FakeOptions{Stdout: "hello from sandbox\n", ExitCode: 0}
}
