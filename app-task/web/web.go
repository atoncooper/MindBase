// Package web embeds the admin console static assets (HTML/CSS/JS, no build
// step) into the app-task binary. The Gin router serves them at / so the
// whole service stays a single self-contained binary (distroless-friendly).
package web

import "embed"

//go:embed all:assets
var FS embed.FS
