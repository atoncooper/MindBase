package tests

// 批量多选端点（移入回收站 / 回收站恢复 / 彻底删除）的守护测试：
//   - 请求边界（去重/去空白/上限/单项长度）与逐项结果的纯逻辑；
//   - HTTP 层在触碰任何存储之前完成校验（422 + 中文 detail），
//     身份只来自网关注入的 X-Uid（缺省 401），不信任请求体；
//   - 依赖缺失时返回 503 而不是 panic（路由已注册）。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"app-cloud/internal/config"
	"app-cloud/internal/model"
	"app-cloud/internal/router"
	"app-cloud/internal/service"

	"github.com/gin-gonic/gin"
)

// newBatchRouter 只装配配置：批量端点必须在访问存储前完成校验，因此空 Deps 足以
// 覆盖 401/422/503 分支（不触发任何 DB/MinIO 调用）。
func newBatchRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	return router.New(router.Deps{Cfg: &config.Config{}})
}

// doBatchJSON 发一个带 X-Uid 的 JSON POST，并解析响应体。
func doBatchJSON(t *testing.T, e *gin.Engine, path, uid, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if uid != "" {
		req.Header.Set("X-Uid", uid)
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	out := map[string]any{}
	if rec.Body.Len() > 0 {
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
	}
	return rec.Code, out
}

// 三个批量端点共用同一套边界语义。
var batchPaths = []string{
	"/cloud/videos/batch-delete",
	"/cloud/trash/batch-restore",
	"/cloud/trash/batch-purge",
}

// itoa 是测试用的小整数转字符串（避免为表驱动引入额外依赖）。
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func TestNormalizeBatchUUIDs(t *testing.T) {
	t.Run("去重保序并去空白", func(t *testing.T) {
		got, err := service.NormalizeBatchUUIDs([]string{" a ", "b", "a", "", "c"})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := []string{"a", "b", "c"}
		if len(got) != len(want) {
			t.Fatalf("got %v, want %v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("got %v, want %v", got, want)
			}
		}
	})

	t.Run("空列表", func(t *testing.T) {
		if _, err := service.NormalizeBatchUUIDs(nil); err != service.ErrBatchEmpty {
			t.Fatalf("nil err = %v, want ErrBatchEmpty", err)
		}
		if _, err := service.NormalizeBatchUUIDs([]string{"", "  "}); err != service.ErrBatchEmpty {
			t.Fatalf("blank err = %v, want ErrBatchEmpty", err)
		}
	})

	t.Run("超过上限", func(t *testing.T) {
		raw := make([]string, service.MaxBatchItems+1)
		for i := range raw {
			raw[i] = "uuid-" + itoa(i)
		}
		if _, err := service.NormalizeBatchUUIDs(raw); err != service.ErrBatchTooLarge {
			t.Fatalf("err = %v, want ErrBatchTooLarge", err)
		}
	})

	t.Run("单项超长", func(t *testing.T) {
		long := strings.Repeat("a", 65)
		if _, err := service.NormalizeBatchUUIDs([]string{long}); err != service.ErrBatchUUIDInvalid {
			t.Fatalf("err = %v, want ErrBatchUUIDInvalid", err)
		}
	})
}

func TestPartitionByOwnership(t *testing.T) {
	owned := []model.CloudFile{
		{ID: 7, UploadUUID: "b"},
		{ID: 9, UploadUUID: "a"},
	}
	rows, missing := service.PartitionByOwnership([]string{"a", "ghost", "b"}, owned)
	if len(rows) != 2 || rows[0].UploadUUID != "a" || rows[1].UploadUUID != "b" {
		t.Fatalf("rows = %+v, want [a b] in request order", rows)
	}
	if len(missing) != 1 || missing[0] != "ghost" {
		t.Fatalf("missing = %v, want [ghost]", missing)
	}
}

func TestSummarizeBatch(t *testing.T) {
	ok, failed := service.SummarizeBatch([]service.BatchItem{
		{UploadUUID: "a", OK: true},
		{UploadUUID: "b", Detail: "x"},
		{UploadUUID: "c", OK: true},
	})
	if ok != 2 || failed != 1 {
		t.Fatalf("ok=%d failed=%d, want 2/1", ok, failed)
	}
}

func TestBatchEndpointsValidateBeforeStore(t *testing.T) {
	e := newBatchRouter(t)
	tooMany := make([]string, service.MaxBatchItems+1)
	for i := range tooMany {
		tooMany[i] = "u" + itoa(i)
	}
	tooManyJSON, _ := json.Marshal(map[string]any{"uuids": tooMany})
	longUUID := strings.Repeat("a", 65)

	cases := []struct {
		name string
		uid  string
		body string
		want int
		// detail 为期望的中文错误文案；空 = 只校验状态码。
		detail string
	}{
		{name: "缺少身份", uid: "", body: "{\"uuids\":[\"a\"]}", want: http.StatusUnauthorized, detail: "未提供认证 token"},
		{name: "空对象", uid: "42", body: "{}", want: http.StatusUnprocessableEntity, detail: "请选择要操作的文件"},
		{name: "空列表", uid: "42", body: "{\"uuids\":[]}", want: http.StatusUnprocessableEntity, detail: "请选择要操作的文件"},
		{name: "全空白", uid: "42", body: "{\"uuids\":[\"  \"]}", want: http.StatusUnprocessableEntity, detail: "请选择要操作的文件"},
		{name: "超过上限", uid: "42", body: string(tooManyJSON), want: http.StatusUnprocessableEntity, detail: "单次最多操作 200 个文件"},
		{name: "单项超长", uid: "42", body: "{\"uuids\":[\"" + longUUID + "\"]}", want: http.StatusUnprocessableEntity, detail: "文件标识不合法"},
		{name: "非法 JSON", uid: "42", body: "{\"uuids\":", want: http.StatusUnprocessableEntity, detail: "请求参数不合法"},
	}

	for _, path := range batchPaths {
		for _, tc := range cases {
			t.Run(path+"/"+tc.name, func(t *testing.T) {
				code, body := doBatchJSON(t, e, path, tc.uid, tc.body)
				if code != tc.want {
					t.Fatalf("status = %d, want %d (body=%v)", code, tc.want, body)
				}
				if tc.detail != "" {
					if got, _ := body["detail"].(string); got != tc.detail {
						t.Fatalf("detail = %q, want %q", got, tc.detail)
					}
				}
			})
		}
	}
}

// 合法请求在依赖未装配时返回 503（证明路由已注册且不会 nil panic）。
func TestBatchEndpointsUnavailableWithoutStores(t *testing.T) {
	e := newBatchRouter(t)
	for _, path := range batchPaths {
		t.Run(path, func(t *testing.T) {
			code, body := doBatchJSON(t, e, path, "42", "{\"uuids\":[\"1b4e28ba-2fa1-11d2-883f-0016d3cca427\"]}")
			if code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503 (body=%v)", code, body)
			}
			if got, _ := body["detail"].(string); got != "批量操作暂不可用" {
				t.Fatalf("detail = %q, want 批量操作暂不可用", got)
			}
		})
	}
}
