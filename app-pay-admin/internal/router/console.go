// Package router: server-rendered admin console pages (html/template).
//
// Rendering model: each page is parsed together with base.tmpl into its own
// template set at startup (the page's {{define "content"}} overrides the
// base's empty block). Data is pre-shaped in Go handlers (formatted money /
// times / status text+classes) so templates stay dumb and auto-escaping does
// the XSS work. Interactions follow the classic POST-redirect-GET pattern
// with ?ok=/?err= flash messages; the JSON /api/* group (webui.go) remains
// available for scripts / master-token callers.
//
// Page layout: MinIO-style top bar + horizontal tab navigation; information
// density, filter bars and status dots follow Aliyun console conventions.
package router

import (
	"html/template"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"

	"app-pay-admin/web"

	"github.com/gin-gonic/gin"
)

var pageTemplates map[string]*template.Template

func init() {
	ssrPages := []string{
		"orders", "order_detail", "memberships", "member_events",
		"events", "products", "grants", "users",
	}
	pageTemplates = make(map[string]*template.Template, len(ssrPages)+2)
	for _, p := range ssrPages {
		pageTemplates[p] = template.Must(template.New("base.tmpl").
			ParseFS(web.Templates, "templates/base.tmpl", "templates/"+p+".tmpl"))
	}
	pageTemplates["base"] = template.Must(template.New("base.tmpl").
		ParseFS(web.Templates, "templates/base.tmpl"))
	pageTemplates["login"] = template.Must(template.New("login.tmpl").
		ParseFS(web.Templates, "templates/login.tmpl"))
}

// renderPage executes a parsed page set. Console pages render from base.tmpl
// (which invokes the page's "content" block); login is standalone. Render
// errors are logged (headers may already be flushed).
func renderPage(w http.ResponseWriter, set string, data any) {
	t, ok := pageTemplates[set]
	if !ok {
		slog.Error("[PAGE] template set missing", "set", set)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	entry := "base.tmpl"
	if set == "login" {
		entry = "login.tmpl"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := t.ExecuteTemplate(w, entry, data); err != nil {
		slog.Error("[PAGE] render failed", "set", set, "err", err)
	}
}

// registerPages mounts the SSR console: standalone login/logout + the gated
// page tree. GET pages render; POST endpoints follow redirect-after-post.
func (r *Router) registerPages(e *gin.Engine, auth *webuiAuthenticator) {
	// Static assets (stylesheet) stay public; *.html is hidden from the static
	// route — pages are served only through the gated handlers below.
	assetFS, err := fs.Sub(web.Assets, "assets")
	if err != nil {
		panic("web assets missing: " + err.Error())
	}
	e.StaticFS("/assets", http.FS(noHTMLFS{assetFS}))

	e.GET("/login", loginPageHandler(auth))
	e.POST("/login", loginSubmitHandler(auth))
	e.POST("/logout", logoutSubmitHandler(auth))

	pages := e.Group("/", auth.pageGate())
	pages.GET("/", func(c *gin.Context) { c.Redirect(http.StatusFound, "/orders") })
	pages.GET("/orders", r.pageOrders)
	pages.GET("/orders/:order_no", r.pageOrderDetail)
	pages.GET("/memberships", r.pageMemberships)
	pages.GET("/memberships/:uid/events", r.pageMemberEvents)
	pages.GET("/events", r.pageEvents)
	pages.GET("/products", r.pageProducts)
	pages.GET("/grants", r.pageGrants)
	pages.POST("/grants", r.handleGrantForm)
	pages.GET("/users", r.pageUsers)
	pages.POST("/users", r.handleUserCreate)
	pages.POST("/users/:user_id/password", r.handleUserPassword)
	pages.POST("/users/:user_id/delete", r.handleUserDelete)
}

// ── login / logout (form flow) ──────────────────────────────────────

func loginPageHandler(auth *webuiAuthenticator) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Already authenticated: nothing to do here.
		if _, ok := auth.authenticate(auth.extractToken(c)); ok {
			c.Redirect(http.StatusFound, "/")
			return
		}
		renderPage(c.Writer, "login", gin.H{"Error": c.Query("err"), "Username": ""})
	}
}

func loginSubmitHandler(auth *webuiAuthenticator) gin.HandlerFunc {
	return func(c *gin.Context) {
		username := strings.TrimSpace(c.PostForm("username"))
		password := c.PostForm("password")
		ip := c.ClientIP()
		if !auth.allow(ip) {
			auth.throttleAbort(c)
			return
		}
		sess, ok := auth.verifyUser(username, password)
		if !ok {
			auth.fail(ip)
			renderPage(c.Writer, "login", gin.H{
				"Error":    "用户名或密码不正确",
				"Username": username,
			})
			return
		}
		auth.reset(ip)
		sid, err := auth.newSession(sess)
		if err != nil {
			slog.Error("[PAGE] issue session failed", "err", err)
			http.Error(c.Writer, "internal error", http.StatusInternalServerError)
			return
		}
		http.SetCookie(c.Writer, &http.Cookie{
			Name:     webuiSessionCookie,
			Value:    sid,
			Path:     "/",
			MaxAge:   int(auth.ttl.Seconds()),
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
			Secure:   c.Request.TLS != nil || c.GetHeader("X-Forwarded-Proto") == "https",
		})
		slog.Info("[AUTH] console login", "username", sess.Username, "ip", ip)
		c.Redirect(http.StatusSeeOther, "/")
	}
}

func logoutSubmitHandler(auth *webuiAuthenticator) gin.HandlerFunc {
	return func(c *gin.Context) {
		if tok := auth.extractToken(c); tok != "" {
			auth.mu.Lock()
			delete(auth.sessions, tok)
			auth.mu.Unlock()
		}
		http.SetCookie(c.Writer, &http.Cookie{
			Name:     webuiSessionCookie,
			Value:    "",
			Path:     "/",
			MaxAge:   -1,
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
		})
		c.Redirect(http.StatusSeeOther, "/login")
	}
}

// pageGate redirects unauthenticated page requests to /login BEFORE any HTML
// is sent, and stashes the identity for handlers (JSON middleware's 302 twin).
func (a *webuiAuthenticator) pageGate() gin.HandlerFunc {
	return func(c *gin.Context) {
		sess, ok := a.authenticate(a.extractToken(c))
		if !ok {
			c.Redirect(http.StatusFound, "/login")
			c.Abort()
			return
		}
		c.Set(webuiCtxUser, sess)
		c.Next()
	}
}

// noHTMLFS hides *.html from the public /assets static route: pages are only
// served through the gated handlers above.
type noHTMLFS struct{ fs.FS }

func (n noHTMLFS) Open(name string) (fs.File, error) {
	if strings.HasSuffix(name, ".html") {
		return nil, fs.ErrNotExist
	}
	return n.FS.Open(name)
}

// render404 renders the shell with an error flash (keeps nav usable).
func render404(c *gin.Context, msg string) {
	c.Writer.WriteHeader(http.StatusNotFound)
	b := newBase(c, "", "未找到", "")
	b.Flash = &flashData{Kind: "err", Msg: msg}
	renderPage(c.Writer, "base", b)
}
