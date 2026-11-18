package router

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// runtimeInfo exposes the sandbox runtime contract to the agent (image, limits,
// egress policy and which language families the control plane accepts). It does
// not execute a probe; image-level tools/packages remain image-dependent.
func runtimeInfo(c *gin.Context, d Deps) {
	if d.Cfg == nil {
		apiErr(c, http.StatusServiceUnavailable, "配置不可用")
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"runtime":              d.RuntimeName,
		"image":                d.Cfg.Runtime.Image,
		"cpu":                  d.Cfg.Runtime.Resources.CPU,
		"memory":               d.Cfg.Runtime.Resources.Memory,
		"networkDefaultAction": d.Cfg.Network.EgressDefaultAction,
		"egressAllow":          d.Cfg.Network.EgressAllow,
		"acceptedLanguages":    []string{"python", "javascript", "bash", "sh", "pwsh"},
		"notes": []string{
			"bash may be absent in alpine-based images (sh fallback is used)",
			"javascript requires node in the image",
			"pwsh requires PowerShell 7 in the image",
			"python packages depend on the image; stdlib is always available",
		},
	})
}
