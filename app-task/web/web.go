// Package web embeds the admin console: server-rendered html/template pages
// (templates/) + the stylesheet (assets/, no build step, no frontend JS
// framework). The whole service stays a single self-contained binary
// (distroless-friendly).
package web

import "embed"

// Templates holds the html/template sources; the router parses base.tmpl with
// each page into a per-page template set at startup.
//
//go:embed all:templates
var Templates embed.FS

// Assets holds static files served publicly at /assets (stylesheet only).
//
//go:embed all:assets
var Assets embed.FS
