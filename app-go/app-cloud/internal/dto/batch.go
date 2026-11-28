package dto

// BatchUUIDsRequest 是批量文件操作（移入回收站 / 回收站恢复 / 彻底删除）的请求体。
//
// uuids 为 upload_uuid 列表：去重后 1..200 项，单个标识不超过 64 字符（当前为
// 36 字符 UUID，留余量给未来格式）。上限与 service.MaxBatchItems 一致；校验失败
// 由 router 映射为 422 + 中文 detail（与既有端点风格一致）。
type BatchUUIDsRequest struct {
	UUIDs []string `json:"uuids" binding:"required,min=1,max=200,dive,required,max=64"`
}

// BatchItemResult 是批量操作中单个文件的执行结果。ok=false 时 detail 给出中文
// 原因（不存在 / 不属于当前账号 / 服务异常）；逐项隔离失败，不影响其余文件。
type BatchItemResult struct {
	UploadUUID string `json:"upload_uuid"`
	OK         bool   `json:"ok"`
	Detail     string `json:"detail,omitempty"`
}

// BatchResultResponse 是三个批量端点共用的响应：成功/失败计数 + 逐项结果。
// results 的顺序与请求 uuids 一致，便于前端按行标记失败原因。
type BatchResultResponse struct {
	Succeeded int               `json:"succeeded"`
	Failed    int               `json:"failed"`
	Results   []BatchItemResult `json:"results"`
}
