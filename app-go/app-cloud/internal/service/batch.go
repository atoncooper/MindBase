package service

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"app-cloud/internal/model"
	"app-cloud/internal/repo"

	"gorm.io/gorm"
)

// MaxBatchItems — 单次批量操作允许的最大文件数。批量端点有界（请求体与逐项
// 处理开销都可控）：超过直接 422，不做静默截断。
const MaxBatchItems = 200

// maxBatchUUIDLen — upload_uuid 的长度上限（当前为 36 字符 UUID，留余量）。
const maxBatchUUIDLen = 64

// 批量请求边界错误（router 映射 422 + 中文 detail）。
var (
	ErrBatchEmpty       = errors.New("请选择要操作的文件")
	ErrBatchTooLarge    = fmt.Errorf("单次最多操作 %d 个文件", MaxBatchItems)
	ErrBatchUUIDInvalid = errors.New("文件标识不合法")
)

// 逐项失败的中文原因（与单文件端点的 detail 风格一致）。
const (
	batchDeleteMissingDetail = "文件不存在或不属于当前账号"
	batchTrashMissingDetail  = "文件不在回收站中或不属于当前账号"
	batchDeleteFailedDetail  = "删除失败，请稍后重试"
	batchRestoreFailedDetail = "恢复失败，请稍后重试"
	batchPurgeFailedDetail   = "彻底删除失败，请稍后重试"
	batchServiceErrorDetail  = "服务异常，请稍后重试"
)

// NormalizeBatchUUIDs 规范化批量请求的 upload_uuid 列表：去首尾空白、丢弃空串、
// 去重（保留首次出现的顺序），并校验单项长度与总量上限。返回值即逐项执行的顺序，
// 响应 results 与之对齐。
func NormalizeBatchUUIDs(raw []string) ([]string, error) {
	if len(raw) == 0 {
		return nil, ErrBatchEmpty
	}
	if len(raw) > MaxBatchItems {
		return nil, ErrBatchTooLarge
	}
	seen := make(map[string]struct{}, len(raw))
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		uuid := strings.TrimSpace(item)
		if uuid == "" {
			continue
		}
		if len(uuid) > maxBatchUUIDLen {
			return nil, ErrBatchUUIDInvalid
		}
		if _, dup := seen[uuid]; dup {
			continue
		}
		seen[uuid] = struct{}{}
		out = append(out, uuid)
	}
	if len(out) == 0 {
		return nil, ErrBatchEmpty
	}
	return out, nil
}

// BatchItem 是单个文件的批量执行结果。
type BatchItem struct {
	UploadUUID string
	OK         bool
	Detail     string
}

// SummarizeBatch 统计逐项结果的成功/失败数（响应组装与前端提示共用语义）。
func SummarizeBatch(items []BatchItem) (succeeded, failed int) {
	for i := range items {
		if items[i].OK {
			succeeded++
		} else {
			failed++
		}
	}
	return succeeded, failed
}

// PartitionByOwnership 按请求顺序把 upload_uuid 分成「命中的文件行」与「缺失 /
// 不归属的 uuid」两部分。归属判定由调用方用 uid 作用域的仓储查询完成，这里只做
// 纯比对（无 DB 依赖，可单测）。
func PartitionByOwnership(requested []string, owned []model.CloudFile) (rows []model.CloudFile, missing []string) {
	byUUID := make(map[string]model.CloudFile, len(owned))
	for i := range owned {
		byUUID[owned[i].UploadUUID] = owned[i]
	}
	rows = make([]model.CloudFile, 0, len(owned))
	missing = make([]string, 0, len(requested)-len(owned))
	for _, uuid := range requested {
		if row, ok := byUUID[uuid]; ok {
			rows = append(rows, row)
			continue
		}
		missing = append(missing, uuid)
	}
	return rows, missing
}

// BatchService — 批量文件操作：把一次批量请求拆成逐项执行、逐项隔离失败，复用
// 单文件端点的语义：
//
//   - 移入回收站 = 软删除（保留 MinIO/Mongo/Milvus 对象，30 天后 sweeper 清理），
//     并撤销该文件的 HLS 播放令牌与全部分享（与 DELETE /cloud/video/{uuid} 一致）；
//   - 恢复 = 撤销软删除并回补配额（复用 FileRepo.Restore）；
//   - 彻底删除 = PurgeService 的三存储物理清理 + 硬删行 + HLS 资产清理（复用
//     DELETE /cloud/trash/{uuid} 的语义）。
//
// 归属校验依赖 repo 的 uid 作用域查询：非本人文件与不存在的文件表现一致（逐项
// 失败），不存在跨账号操作路径。
type BatchService struct {
	db     *gorm.DB
	files  *repo.FileRepo
	hls    *HLSService
	shares *ShareService
	purge  *PurgeService
}

// NewBatchService 组装批量服务。hls / shares / purge 可为 nil（能力关闭时跳过
// 对应副作用，与单文件端点的 nil-safe 处理一致）。
func NewBatchService(db *gorm.DB, files *repo.FileRepo, hls *HLSService, shares *ShareService, purge *PurgeService) *BatchService {
	return &BatchService{db: db, files: files, hls: hls, shares: shares, purge: purge}
}

// SoftDeleteMany 把选中的文件移入回收站。单文件失败不阻断其余项；成功后与单文件
// 删除一致，撤销该文件的 HLS 播放令牌与全部分享。
func (s *BatchService) SoftDeleteMany(ctx context.Context, uid int64, uuids []string) []BatchItem {
	if s == nil || s.db == nil || s.files == nil {
		return batchFailAll(uuids, batchServiceErrorDetail)
	}
	owned, err := s.files.ListByUUIDs(s.db, uid, uuids)
	if err != nil {
		return batchFailAll(uuids, batchServiceErrorDetail)
	}
	rows, _ := PartitionByOwnership(uuids, owned)
	rowByUUID := make(map[string]model.CloudFile, len(rows))
	for i := range rows {
		rowByUUID[rows[i].UploadUUID] = rows[i]
	}
	items := make([]BatchItem, 0, len(uuids))
	for _, uuid := range uuids {
		row, found := rowByUUID[uuid]
		if !found {
			items = append(items, BatchItem{UploadUUID: uuid, Detail: batchDeleteMissingDetail})
			continue
		}
		if err := s.files.SoftDelete(s.db, uuid, uid); err != nil {
			items = append(items, BatchItem{UploadUUID: uuid, Detail: batchDeleteFailedDetail})
			continue
		}
		// 已移入回收站的文件不得继续播放或分享（单文件删除同语义）。
		if s.hls != nil {
			s.hls.RevokeTokens(ctx, uuid)
		}
		if s.shares != nil {
			_ = s.shares.RevokeAllForFile(row.ID)
		}
		items = append(items, BatchItem{UploadUUID: uuid, OK: true})
	}
	return items
}

// RestoreMany 把回收站中选中的文件恢复到原文件夹（逐项隔离失败）。
func (s *BatchService) RestoreMany(_ context.Context, uid int64, uuids []string) []BatchItem {
	if s == nil || s.db == nil || s.files == nil {
		return batchFailAll(uuids, batchServiceErrorDetail)
	}
	items := make([]BatchItem, 0, len(uuids))
	for _, uuid := range uuids {
		err := s.files.Restore(s.db, uuid, uid)
		switch {
		case err == nil:
			items = append(items, BatchItem{UploadUUID: uuid, OK: true})
		case errors.Is(err, gorm.ErrRecordNotFound):
			items = append(items, BatchItem{UploadUUID: uuid, Detail: batchTrashMissingDetail})
		default:
			items = append(items, BatchItem{UploadUUID: uuid, Detail: batchRestoreFailedDetail})
		}
	}
	return items
}

// PurgeMany 彻底删除回收站中选中的文件（MinIO 对象 + HLS 资产/令牌 + Mongo 解析
// 文本 + Milvus 向量 + DB 行）。单项失败保留该行，回收站 sweeper 仍会重试。
func (s *BatchService) PurgeMany(ctx context.Context, uid int64, uuids []string) []BatchItem {
	if s == nil || s.purge == nil {
		return batchFailAll(uuids, batchServiceErrorDetail)
	}
	items := make([]BatchItem, 0, len(uuids))
	for _, uuid := range uuids {
		err := s.purge.PurgeFile(ctx, uuid, uid)
		switch {
		case err == nil:
			items = append(items, BatchItem{UploadUUID: uuid, OK: true})
		case errors.Is(err, ErrNotFound):
			items = append(items, BatchItem{UploadUUID: uuid, Detail: batchTrashMissingDetail})
		default:
			items = append(items, BatchItem{UploadUUID: uuid, Detail: batchPurgeFailedDetail})
		}
	}
	return items
}

// batchFailAll 在服务不可用时把全部请求项标记为失败（保持 results 与请求对齐）。
func batchFailAll(uuids []string, detail string) []BatchItem {
	items := make([]BatchItem, 0, len(uuids))
	for _, uuid := range uuids {
		items = append(items, BatchItem{UploadUUID: uuid, Detail: detail})
	}
	return items
}
