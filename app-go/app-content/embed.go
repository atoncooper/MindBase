// Package appcontent exposes the embedded single configuration file.
package appcontent

import _ "embed"

//go:embed default.yaml
var DefaultYAML []byte
