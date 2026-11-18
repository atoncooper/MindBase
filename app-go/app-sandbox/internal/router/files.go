package router

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// readFile returns one offset-addressed slice of a sandbox text file. The
// response always carries hasMore/nextOffset so an agent can page until done.
func readFile(c *gin.Context, d Deps) {
	if d.Files == nil {
		apiErr(c, http.StatusServiceUnavailable, "文件工具未启用")
		return
	}
	uid := currentUID(c)
	rawPath := strings.TrimSpace(c.Query("path"))
	if rawPath == "" {
		apiErr(c, http.StatusBadRequest, "path 不能为空")
		return
	}
	offset := int64(0)
	if raw := strings.TrimSpace(c.Query("offset")); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			apiErr(c, http.StatusBadRequest, "offset 必须是非负整数")
			return
		}
		offset = parsed
	}
	limit := int64(0)
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed <= 0 {
			apiErr(c, http.StatusBadRequest, "limit 必须是正整数")
			return
		}
		limit = parsed
	}
	result, err := d.Files.Read(c.Request.Context(), uid, c.Query("projectId"), purposeOrDefault(c.Query("purpose")), rawPath, offset, limit)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, result)
}

type writeFileRequest struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	Encoding  string `json:"encoding"`
	ProjectID string `json:"projectId"`
	Purpose   string `json:"purpose"`
}

// writeFile writes one text file into the caller's reusable sandbox workspace.
func writeFile(c *gin.Context, d Deps) {
	if d.Files == nil {
		apiErr(c, http.StatusServiceUnavailable, "文件工具未启用")
		return
	}
	var req writeFileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		apiErr(c, http.StatusBadRequest, "请求体格式错误")
		return
	}
	if strings.TrimSpace(req.Path) == "" {
		apiErr(c, http.StatusBadRequest, "path 不能为空")
		return
	}
	if len(req.Content) > 12<<20 {
		apiErr(c, http.StatusBadRequest, "文件内容过大")
		return
	}
	result, err := d.Files.Write(c.Request.Context(), currentUID(c), req.ProjectID, purposeOrDefault(req.Purpose), req.Path, req.Content, strings.ToLower(strings.TrimSpace(req.Encoding)))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, result)
}

func purposeOrDefault(raw string) string {
	if purpose := strings.TrimSpace(raw); purpose != "" {
		return purpose
	}
	return "chat"
}
