package router

import (
	"errors"
	"net/http"

	"app-cloud/internal/dto"
	"app-cloud/internal/middleware"
	"app-cloud/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/go-playground/validator/v10"
)

// registerBatchRoutes 挂载批量文件端点（多选删除 / 回收站批量恢复 / 批量彻底
// 删除）。与单文件端点共用 /cloud 组与 X-Uid 鉴权链；网关无需改动（APISIX/nginx
// 已按 /cloud/* 前缀转发到 app-cloud）。
func registerBatchRoutes(e *gin.Engine, d Deps) {
	g := e.Group("/cloud")
	g.Use(middleware.RequireUID())
	g.POST("/videos/batch-delete", batchDeleteVideos(d))
	g.POST("/trash/batch-restore", batchRestoreTrash(d))
	g.POST("/trash/batch-purge", batchPurgeTrash(d))
}

// newBatchService 在路由层按请求构造轻量批量服务：只依赖 Deps 已装配的单文件
// 仓储/服务，因此无需新增 Deps 字段（main.go 组合根无需改动）。
func newBatchService(d Deps) *service.BatchService {
	return service.NewBatchService(d.DB, d.Files, d.HLS, d.Share, d.Purge)
}

// batchDeleteVideos — POST /cloud/videos/batch-delete（移入回收站，软删除）。
func batchDeleteVideos(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		uuids, ok := bindBatchUUIDs(c)
		if !ok {
			return
		}
		if d.DB == nil || d.Files == nil {
			apiErr(c, http.StatusServiceUnavailable, "批量操作暂不可用")
			return
		}
		items := newBatchService(d).SoftDeleteMany(c.Request.Context(), uid, uuids)
		if succeeded, _ := service.SummarizeBatch(items); succeeded > 0 {
			invalidateFolderCache(d, c)
		}
		c.JSON(http.StatusOK, batchResultResponse(items))
	}
}

// batchRestoreTrash — POST /cloud/trash/batch-restore（恢复到原文件夹）。
func batchRestoreTrash(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		uuids, ok := bindBatchUUIDs(c)
		if !ok {
			return
		}
		if d.DB == nil || d.Files == nil {
			apiErr(c, http.StatusServiceUnavailable, "批量操作暂不可用")
			return
		}
		items := newBatchService(d).RestoreMany(c.Request.Context(), uid, uuids)
		if succeeded, _ := service.SummarizeBatch(items); succeeded > 0 {
			invalidateFolderCache(d, c)
		}
		c.JSON(http.StatusOK, batchResultResponse(items))
	}
}

// batchPurgeTrash — POST /cloud/trash/batch-purge（彻底删除，不可恢复）。
func batchPurgeTrash(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		uuids, ok := bindBatchUUIDs(c)
		if !ok {
			return
		}
		if d.Purge == nil {
			apiErr(c, http.StatusServiceUnavailable, "批量操作暂不可用")
			return
		}
		items := newBatchService(d).PurgeMany(c.Request.Context(), uid, uuids)
		c.JSON(http.StatusOK, batchResultResponse(items))
	}
}

// bindBatchUUIDs 解析并规范化批量请求体。校验在触碰任何存储之前完成，因此空体 /
// 超限 / 非法标识统一返回 422 + 中文 detail。
func bindBatchUUIDs(c *gin.Context) ([]string, bool) {
	var req dto.BatchUUIDsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		apiErr(c, http.StatusUnprocessableEntity, batchBindDetail(err))
		return nil, false
	}
	uuids, err := service.NormalizeBatchUUIDs(req.UUIDs)
	if err != nil {
		apiErr(c, http.StatusUnprocessableEntity, err.Error())
		return nil, false
	}
	return uuids, true
}

// batchBindDetail 把绑定/校验错误翻译成与既有端点一致的中文 422 detail。
func batchBindDetail(err error) string {
	var verrs validator.ValidationErrors
	if errors.As(err, &verrs) {
		for _, fe := range verrs {
			switch fe.Tag() {
			case "required", "min":
				return service.ErrBatchEmpty.Error()
			case "max":
				// 列表上限（field=UUIDs）与单项长度（dive 后 field=UUIDs[i]）
				// 共用 max tag，按字段位置区分。
				if fe.Field() == "UUIDs" {
					return service.ErrBatchTooLarge.Error()
				}
				return service.ErrBatchUUIDInvalid.Error()
			}
		}
	}
	return "请求参数不合法"
}

// batchResultResponse 把服务层的逐项结果映射为统一 wire 形状。
func batchResultResponse(items []service.BatchItem) dto.BatchResultResponse {
	out := dto.BatchResultResponse{Results: make([]dto.BatchItemResult, 0, len(items))}
	for i := range items {
		out.Results = append(out.Results, dto.BatchItemResult{
			UploadUUID: items[i].UploadUUID,
			OK:         items[i].OK,
			Detail:     items[i].Detail,
		})
	}
	out.Succeeded, out.Failed = service.SummarizeBatch(items)
	return out
}
