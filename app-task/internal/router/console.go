package router

import (
	"io/fs"
	"net/http"
	"strings"

	"app-task/internal/config"
	"app-task/web"

	"github.com/gin-gonic/gin"
)

// indexHTML / loginHTML are read once from the embedded assets at startup.
var (
	indexHTML []byte
	loginHTML []byte
)

func init() {
	indexHTML, _ = web.FS.ReadFile("assets/index.html")
	loginHTML, _ = web.FS.ReadFile("assets/login.html")
}

// registerWebRoutes serves the embedded admin console pages:
//
//   - GET /login — standalone login page (no app shell, no data).
//   - GET /      — the console SPA, served ONLY to authenticated sessions
//     when a token is configured; everyone else is redirected to /login
//     BEFORE any app HTML is sent.
//
// Static assets under /assets/* stay public (CSS/JS are not sensitive); the
// HTML pages themselves are hidden from the static route so unauthenticated
// clients cannot fetch the app shell via /assets/index.html.
func registerWebRoutes(e *gin.Engine, cfg *config.Config, auth *webuiAuthenticator) {
	assetFS, err := fs.Sub(web.FS, "assets")
	if err != nil {
		panic("web assets missing: " + err.Error())
	}
	e.StaticFS("/assets", http.FS(noHTMLFS{assetFS}))

	e.GET("/login", func(c *gin.Context) {
		// Already authenticated: nothing to do here.
		if _, ok := auth.authenticate(auth.extractToken(c)); ok {
			c.Redirect(http.StatusFound, "/")
			return
		}
		if len(loginHTML) == 0 {
			c.Data(http.StatusNotFound, "text/plain; charset=utf-8", []byte("login page not embedded"))
			return
		}
		c.Data(http.StatusOK, "text/html; charset=utf-8", loginHTML)
	})

	e.GET("/", func(c *gin.Context) {
		if len(indexHTML) == 0 {
			c.Data(http.StatusNotFound, "text/plain; charset=utf-8", []byte("web assets not embedded"))
			return
		}
		if _, ok := auth.authenticate(auth.extractToken(c)); !ok {
			c.Redirect(http.StatusFound, "/login")
			return
		}
		c.Data(http.StatusOK, "text/html; charset=utf-8", indexHTML)
	})
}

// noHTMLFS hides *.html from the public /assets static route: the console and
// login pages are only served through their gated handlers above.
type noHTMLFS struct{ fs.FS }

func (n noHTMLFS) Open(name string) (fs.File, error) {
	if strings.HasSuffix(name, ".html") {
		return nil, fs.ErrNotExist
	}
	return n.FS.Open(name)
}
