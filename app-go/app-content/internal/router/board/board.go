package router

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	boarddto "app-content/internal/dto/board"
	"app-content/internal/middleware"
	boardsvc "app-content/internal/service/board"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// registerBoardRoutes mounts the /board/* user endpoints. Auth model: APISIX
// forward-auth validated bili_session and injected X-Uid; every query is
// scoped to that uid.
func registerBoardRoutes(e *gin.Engine, svc *boardsvc.BoardService) {
	g := e.Group("/board", middleware.RequireUID())
	g.GET("/boards", listBoards(svc))
	g.POST("/boards", createBoard(svc))
	g.GET("/boards/:uuid", getBoard(svc))
	g.PUT("/boards/:uuid", updateBoard(svc))
	g.DELETE("/boards/:uuid", deleteBoard(svc))
	g.PATCH("/boards/:uuid/pin", pinBoard(svc))
}

// registerInternalRoutes exposes the same handlers under /internal/board with
// an additional X-Internal-Key check (APISIX key-auth injects it).
func registerInternalRoutes(e *gin.Engine, svc *boardsvc.BoardService, internalAPIKey string) {
	g := e.Group("/internal/board", middleware.InternalAuth(internalAPIKey), middleware.RequireUID())
	g.GET("/boards", listBoards(svc))
	g.POST("/boards", createBoard(svc))
	g.GET("/boards/:uuid", getBoard(svc))
	g.PUT("/boards/:uuid", updateBoard(svc))
	g.DELETE("/boards/:uuid", deleteBoard(svc))
	g.PATCH("/boards/:uuid/pin", pinBoard(svc))
}

func uidFrom(c *gin.Context) int64 {
	v, _ := c.Get("uid")
	uid, _ := v.(int64)
	return uid
}

// mapServiceError renders the shared apperr model; every board service error
// is an *apperr.Error (wrapped errors keep errors.As working).
func mapServiceError(c *gin.Context, err error, _ string) bool {
	return middleware.RespondError(c, err)
}

func createBoard(svc *boardsvc.BoardService) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req boarddto.CreateRequest
		if !middleware.BindJSON(c, &req) {
			return
		}
		kind := req.Kind
		if kind == "" {
			kind = boardsvc.KindMindmap
		}
		var content string
		if req.Content != nil {
			content = string(*req.Content)
		}
		title := ""
		if req.Title != nil {
			title = strings.TrimSpace(*req.Title)
		}
		meta, err := svc.Create(c.Request.Context(), uidFrom(c), title, kind, content)
		if mapServiceError(c, err, "create board") {
			return
		}
		c.JSON(http.StatusCreated, toMetaDTO(*meta))
	}
}

func listBoards(svc *boardsvc.BoardService) gin.HandlerFunc {
	return func(c *gin.Context) {
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
		q := boarddto.ListQuery{Kind: strings.TrimSpace(c.Query("kind")), Page: page, PageSize: pageSize}
		if !q.Normalize() {
			middleware.Error(c, http.StatusBadRequest, "invalid kind/page/page_size")
			return
		}
		boards, total, err := svc.ListMetas(c.Request.Context(), uidFrom(c), q.Kind, q.Page, q.PageSize)
		if mapServiceError(c, err, "list boards") {
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"items":    toMetaDTOs(boards),
			"total":    total,
			"page":     q.Page,
			"pageSize": q.PageSize,
		})
	}
}

func getBoard(svc *boardsvc.BoardService) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := pathUUID(c)
		if !ok {
			return
		}
		detail, err := svc.GetDetail(c.Request.Context(), uidFrom(c), id)
		if mapServiceError(c, err, "get board") {
			return
		}
		c.Header("ETag", strconv.FormatInt(detail.Version, 10))
		c.JSON(http.StatusOK, toDetailDTO(*detail))
	}
}

func updateBoard(svc *boardsvc.BoardService) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := pathUUID(c)
		if !ok {
			return
		}
		ifMatch, err := parseIfMatch(c.GetHeader("If-Match"))
		if err != nil {
			middleware.Error(c, http.StatusPreconditionRequired,
				`If-Match header with the board's current version is required (optimistic locking)`)
			return
		}
		var req boarddto.UpdateRequest
		if !middleware.BindJSON(c, &req) {
			return
		}
		p := boardsvc.UpdateParams{Title: req.Title, IsPinned: req.IsPinned}
		if req.Content != nil {
			s := string(*req.Content)
			p.Content = &s
		}
		meta, err := svc.Update(c.Request.Context(), uidFrom(c), id, ifMatch, p)
		if mapServiceError(c, err, "update board") {
			return
		}
		c.JSON(http.StatusOK, toMetaDTO(*meta))
	}
}

func deleteBoard(svc *boardsvc.BoardService) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := pathUUID(c)
		if !ok {
			return
		}
		if mapServiceError(c, svc.Delete(c.Request.Context(), uidFrom(c), id), "delete board") {
			return
		}
		c.Status(http.StatusNoContent)
	}
}

func pinBoard(svc *boardsvc.BoardService) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := pathUUID(c)
		if !ok {
			return
		}
		var req boarddto.PinRequest
		if !middleware.BindJSON(c, &req) {
			return
		}
		if req.IsPinned == nil {
			middleware.Error(c, http.StatusBadRequest, "isPinned is required")
			return
		}
		meta, err := svc.SetPin(c.Request.Context(), uidFrom(c), id, *req.IsPinned)
		if mapServiceError(c, err, "pin board") {
			return
		}
		c.JSON(http.StatusOK, toMetaDTO(*meta))
	}
}

func pathUUID(c *gin.Context) (string, bool) {
	raw := strings.TrimSpace(c.Param("uuid"))
	parsed, err := uuid.Parse(raw)
	if err != nil {
		middleware.Error(c, http.StatusBadRequest, "invalid board uuid")
		return "", false
	}
	return parsed.String(), true
}

// Wire mappers live in the controller: the DTO package stays free of service
// dependencies (router -> service -> repo direction only).
const boardTimeLayout = "2006-01-02T15:04:05.999999999Z07:00"

func toMetaDTO(m boardsvc.BoardMeta) boarddto.Meta {
	return boarddto.Meta{
		UUID:      m.UUID,
		Title:     m.Title,
		Kind:      m.Kind,
		Version:   m.Version,
		IsPinned:  m.IsPinned,
		CreatedAt: m.CreatedAt.UTC().Format(boardTimeLayout),
		UpdatedAt: m.UpdatedAt.UTC().Format(boardTimeLayout),
	}
}

func toMetaDTOs(items []boardsvc.BoardMeta) []boarddto.Meta {
	out := make([]boarddto.Meta, 0, len(items))
	for _, m := range items {
		out = append(out, toMetaDTO(m))
	}
	return out
}

func toDetailDTO(d boardsvc.BoardDetail) boarddto.Detail {
	return boarddto.Detail{Meta: toMetaDTO(d.BoardMeta), Content: d.Content}
}

func parseIfMatch(header string) (int64, error) {
	h := strings.TrimSpace(header)
	h = strings.TrimPrefix(h, "W/")
	h = strings.Trim(h, `"`)
	if h == "" {
		return 0, errors.New("missing If-Match")
	}
	return strconv.ParseInt(h, 10, 64)
}
