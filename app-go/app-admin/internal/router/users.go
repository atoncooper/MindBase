// Read-only user endpoints (viewer and above): GET /api/users
// (q / mode / page / pageSize) and GET /api/users/:uid (detail + full rbac
// binding list). q is an exact UID / 11-digit phone / email; mode is an
// optional client hint that the service re-validates against the value. NO
// file / storage information leaks through these DTOs on purpose.
package router

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

func (r *Router) apiListUsers(c *gin.Context) {
	page, pageSize, ok := r.parsePage(c)
	if !ok {
		detail(c, http.StatusBadRequest, "page must be >= 1 and pageSize within 1..100")
		return
	}
	result, err := r.users.List(c.Query("q"), c.Query("mode"), page, pageSize)
	if err != nil {
		badRequest(c, err)
		return
	}
	c.JSON(http.StatusOK, result)
}

func (r *Router) apiUserDetail(c *gin.Context) {
	uid, err := strconv.ParseInt(c.Param("uid"), 10, 64)
	if err != nil {
		detail(c, http.StatusBadRequest, "uid must be an integer")
		return
	}
	result, err := r.users.Detail(uid)
	if err != nil {
		badRequest(c, err)
		return
	}
	if result == nil {
		detail(c, http.StatusNotFound, "user not found")
		return
	}
	c.JSON(http.StatusOK, result)
}
