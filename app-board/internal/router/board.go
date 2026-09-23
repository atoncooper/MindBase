package router

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"app-board/internal/service"

	"github.com/gin-gonic/gin"
)

// registerBoardRoutes mounts the /board/* user endpoints. Auth model: APISIX
// forward-auth validated bili_session and injected X-Uid; we scope every
// query to that uid.
func registerBoardRoutes(e *gin.Engine, svc *service.BoardService) {
	g := e.Group("/board", requireXUid())

	g.GET("/boards", listBoards(svc))
	g.POST("/boards", createBoard(svc))
	g.GET("/boards/:uuid", getBoard(svc))
	g.PUT("/boards/:uuid", updateBoard(svc))
	g.DELETE("/boards/:uuid", deleteBoard(svc))
	g.PATCH("/boards/:uuid/pin", pinBoard(svc))
}

func parsePositiveInt64(s string) (int64, error) {
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil || v <= 0 {
		return 0, errors.New("not a positive int64")
	}
	return v, nil
}

func uidFrom(c *gin.Context) int64 {
	v, _ := c.Get("uid")
	uid, _ := v.(int64)
	return uid
}

// mapServiceError converts service sentinel errors to HTTP responses.
func mapServiceError(c *gin.Context, err error, context string) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, service.ErrNotFound):
		jsonError(c, http.StatusNotFound, "board not found")
	case errors.Is(err, service.ErrConflict):
		jsonError(c, http.StatusConflict, "version conflict: board was modified concurrently, reload and retry")
	case errors.Is(err, service.ErrPrecondition):
		// Not currently produced (Update treats missing If-Match as 400
		// before the service call) — kept for contract completeness.
		jsonError(c, http.StatusPreconditionRequired, "If-Match header required")
	case errors.Is(err, service.ErrContentTooBig):
		jsonError(c, http.StatusRequestEntityTooLarge, "content exceeds the 8MB limit")
	case errors.Is(err, service.ErrInvalidInput):
		jsonError(c, http.StatusBadRequest, err.Error())
	case errors.Is(err, service.ErrDuplicateName):
		// 重名是用户可自行纠正的输入问题 -> 400，文案直接可读。
		jsonError(c, http.StatusBadRequest, err.Error())
	case errors.Is(err, service.ErrStorage):
		internalError(c, err, context)
	default:
		internalError(c, err, context)
	}
	return true
}

// ── handlers ────────────────────────────────────────────────────────

type createBoardRequest struct {
	Title   *string         `json:"title"`
	Kind    string          `json:"kind"`
	Content *jsonRawContent `json:"content"`
}

// jsonRawContent keeps the client's JSON verbatim (the editors' formats are
// opaque to app-board: simple-mind-map tree / Excalidraw scene).
//
// Two client shapes are accepted:
//   - raw object/array token:  {"content": {"root": ...}}  -> stored verbatim;
//   - pre-stringified string:  {"content": "{\"root\": ...}"}  -> unquoted,
//     because the editor bridge stringifies the doc before sending (boardsApi
//     update sends content as a JSON string). Storing the token verbatim would
//     double-encode the document.
type jsonRawContent string

func (j *jsonRawContent) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if len(trimmed) > 0 && trimmed[0] == '"' {
		var unquoted string
		if err := json.Unmarshal(data, &unquoted); err != nil {
			return err
		}
		*j = jsonRawContent(unquoted)
		return nil
	}
	*j = jsonRawContent(data)
	return nil
}

func createBoard(svc *service.BoardService) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req createBoardRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			jsonError(c, http.StatusBadRequest, "invalid request body: "+err.Error())
			return
		}
		if req.Kind == "" {
			req.Kind = service.KindMindmap
		}
		var content string
		if req.Content != nil {
			content = string(*req.Content)
		}
		title := ""
		if req.Title != nil {
			title = strings.TrimSpace(*req.Title)
		}
		meta, err := svc.Create(c.Request.Context(), uidFrom(c), title, req.Kind, content)
		if mapServiceError(c, err, "create board") {
			return
		}
		c.JSON(http.StatusCreated, meta)
	}
}

func listBoards(svc *service.BoardService) gin.HandlerFunc {
	return func(c *gin.Context) {
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
		boards, total, err := svc.ListMetas(c.Request.Context(), uidFrom(c),
			strings.TrimSpace(c.Query("kind")), page, pageSize)
		if mapServiceError(c, err, "list boards") {
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"items":    boards,
			"total":    total,
			"page":     page,
			"pageSize": pageSize,
		})
	}
}

func getBoard(svc *service.BoardService) gin.HandlerFunc {
	return func(c *gin.Context) {
		detail, err := svc.GetDetail(c.Request.Context(), uidFrom(c), c.Param("uuid"))
		if mapServiceError(c, err, "get board") {
			return
		}
		c.Header("ETag", strconv.FormatInt(detail.Version, 10))
		c.JSON(http.StatusOK, detail)
	}
}

type updateBoardRequest struct {
	Title    *string         `json:"title"`
	Content  *jsonRawContent `json:"content"`
	IsPinned *bool           `json:"isPinned"`
}

func updateBoard(svc *service.BoardService) gin.HandlerFunc {
	return func(c *gin.Context) {
		ifMatch, err := parseIfMatch(c.GetHeader("If-Match"))
		if err != nil {
			jsonError(c, http.StatusPreconditionRequired,
				`If-Match header with the board's current version is required (optimistic locking)`)
			return
		}
		var req updateBoardRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			jsonError(c, http.StatusBadRequest, "invalid request body: "+err.Error())
			return
		}
		p := service.UpdateParams{Title: req.Title, IsPinned: req.IsPinned}
		if req.Content != nil {
			s := string(*req.Content)
			p.Content = &s
		}
		meta, err := svc.Update(c.Request.Context(), uidFrom(c), c.Param("uuid"), ifMatch, p)
		if mapServiceError(c, err, "update board") {
			return
		}
		c.JSON(http.StatusOK, meta)
	}
}

func parseIfMatch(header string) (int64, error) {
	h := strings.TrimSpace(header)
	// Tolerate the W/"..." strong-weak prefix some HTTP clients add.
	h = strings.TrimPrefix(h, "W/")
	h = strings.Trim(h, `"`)
	if h == "" {
		return 0, errors.New("missing If-Match")
	}
	return strconv.ParseInt(h, 10, 64)
}

func deleteBoard(svc *service.BoardService) gin.HandlerFunc {
	return func(c *gin.Context) {
		err := svc.Delete(c.Request.Context(), uidFrom(c), c.Param("uuid"))
		if mapServiceError(c, err, "delete board") {
			return
		}
		c.Status(http.StatusNoContent)
	}
}

type pinBoardRequest struct {
	IsPinned bool `json:"isPinned"`
}

func pinBoard(svc *service.BoardService) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req pinBoardRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			jsonError(c, http.StatusBadRequest, "invalid request body: "+err.Error())
			return
		}
		meta, err := svc.SetPin(c.Request.Context(), uidFrom(c), c.Param("uuid"), req.IsPinned)
		if mapServiceError(c, err, "pin board") {
			return
		}
		c.JSON(http.StatusOK, meta)
	}
}
