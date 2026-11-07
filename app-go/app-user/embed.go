// Package appuser exposes embedded assets for the app-user service.
package appuser

import _ "embed"

//go:embed default.yaml
var DefaultYAML []byte
