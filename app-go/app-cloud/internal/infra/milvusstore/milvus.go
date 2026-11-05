package milvusstore

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"app-cloud/internal/config"
	"app-cloud/internal/model"
	"app-cloud/internal/utils"

	"github.com/milvus-io/milvus/client/v2/column"
	"github.com/milvus-io/milvus/client/v2/entity"
	"github.com/milvus-io/milvus/client/v2/index"
	"github.com/milvus-io/milvus/client/v2/milvusclient"
)

// MilvusStore writes chunk vectors into the existing cloud_drive collection.
//
// SCHEMA GUARD: the collection is owned by this pipeline but was originally
// created by the Python backend — at startup we verify the live schema
// contains the expected fields with the configured embedding dimension, and
// refuse to start on mismatch (a dim drift would silently poison retrieval).
// If the collection does not exist, it is created with the exact Python
// schema (app/repository/vector_store_milvus.py::_build_cloud_drive_schema).
type MilvusStore struct {
	cli    *milvusclient.Client
	cfg    config.MilvusConfig
	dim    int
	prefix string // analyzer name for logging only
}

func NewMilvusStore(ctx context.Context, cfg config.MilvusConfig, dim int) (*MilvusStore, error) {
	cli, err := milvusclient.New(ctx, &milvusclient.ClientConfig{
		Address: strings.TrimPrefix(strings.TrimPrefix(cfg.URI, "http://"), "https://"),
		APIKey:  cfg.Token,
	})
	if err != nil {
		return nil, fmt.Errorf("milvus connect: %w", err)
	}
	s := &MilvusStore{cli: cli, cfg: cfg, dim: dim, prefix: cfg.Analyzer}
	if err := s.ensureCollection(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// expectedCloudFields — field name → (must-exist check). The sparse/BM25
// fields exist only on Milvus 2.5+ collections; only dense-only fields are
// strictly required here (sparse fields are auto-populated by function).
var expectedCloudFields = []string{
	"upload_uuid", "uid", "chunk_index", "chunk_id", "title", "source",
	"source_type", "section_title", "content_type", "text", "embedding",
}

func (s *MilvusStore) ensureCollection(ctx context.Context) error {
	has, err := s.cli.HasCollection(ctx, milvusclient.NewHasCollectionOption(s.cfg.Collection))
	if err != nil {
		return fmt.Errorf("milvus has_collection: %w", err)
	}
	if !has {
		slog.Warn("[MILVUS] cloud_drive collection missing — creating with Python-compatible schema")
		return s.createCollection(ctx)
	}
	coll, err := s.cli.DescribeCollection(ctx, milvusclient.NewDescribeCollectionOption(s.cfg.Collection))
	if err != nil {
		return fmt.Errorf("milvus describe_collection: %w", err)
	}
	present := map[string]int64{}
	embDim := int64(0)
	for _, f := range coll.Schema.Fields {
		if f.Name == "embedding" {
			if v, ok := f.TypeParams["dim"]; ok {
				fmt.Sscanf(v, "%d", &embDim)
			}
			continue
		}
		present[f.Name] = 0
	}
	for _, name := range expectedCloudFields {
		if name == "embedding" {
			continue // dimension checked separately below
		}
		if _, ok := present[name]; !ok {
			return fmt.Errorf("MILVUS SCHEMA GUARD: cloud_drive is missing field %q — refusing to start "+
				"(the collection was likely created by a different schema version)", name)
		}
	}
	if embDim != 0 && embDim != int64(s.dim) {
		return fmt.Errorf("MILVUS SCHEMA GUARD: embedding dim %d != configured %d — refusing to start "+
			"(model change requires a full collection rebuild)", embDim, s.dim)
	}
	return nil
}

func (s *MilvusStore) createCollection(ctx context.Context) error {
	schema := entity.NewSchema().
		WithName(s.cfg.Collection).
		WithAutoID(true).
		WithField(entity.NewField().WithName("id").WithDataType(entity.FieldTypeInt64).WithIsPrimaryKey(true).WithIsAutoID(true)).
		WithField(entity.NewField().WithName("upload_uuid").WithDataType(entity.FieldTypeVarChar).WithMaxLength(64)).
		WithField(entity.NewField().WithName("uid").WithDataType(entity.FieldTypeInt64)).
		WithField(entity.NewField().WithName("chunk_index").WithDataType(entity.FieldTypeInt64)).
		WithField(entity.NewField().WithName("chunk_id").WithDataType(entity.FieldTypeVarChar).WithMaxLength(128)).
		WithField(entity.NewField().WithName("title").WithDataType(entity.FieldTypeVarChar).WithMaxLength(512)).
		WithField(entity.NewField().WithName("source").WithDataType(entity.FieldTypeVarChar).WithMaxLength(32)).
		WithField(entity.NewField().WithName("source_type").WithDataType(entity.FieldTypeVarChar).WithMaxLength(16)).
		WithField(entity.NewField().WithName("section_title").WithDataType(entity.FieldTypeVarChar).WithMaxLength(256)).
		WithField(entity.NewField().WithName("content_type").WithDataType(entity.FieldTypeVarChar).WithMaxLength(32)).
		WithField(entity.NewField().WithName("text").WithDataType(entity.FieldTypeVarChar).WithMaxLength(65535)).
		WithField(entity.NewField().WithName("embedding").WithDataType(entity.FieldTypeFloatVector).WithDim(int64(s.dim)))
	err := s.cli.CreateCollection(ctx, milvusclient.NewCreateCollectionOption(s.cfg.Collection, schema))
	if err != nil {
		return fmt.Errorf("milvus create_collection: %w", err)
	}
	// dense index on embedding (HNSW/COSINE — matches the Python index config)
	_, err = s.cli.CreateIndex(ctx, milvusclient.NewCreateIndexOption(s.cfg.Collection, "embedding",
		index.NewHNSWIndex(entity.COSINE, 24, 360)))
	if err != nil {
		return fmt.Errorf("milvus create_index: %w", err)
	}
	return nil
}

// partitionName — parity with the Python partition scheme (monthly buckets
// keyed by file creation time, `_YYYY_MM`).
func partitionName(t time.Time) string {
	return t.Format("_2006_01")
}

// InsertChunks writes chunk rows into the file's monthly partition.
func (s *MilvusStore) InsertChunks(ctx context.Context, uploadUUID string, uid int64,
	partition time.Time, rows []model.ChunkRow) error {
	if len(rows) == 0 {
		return nil
	}
	p := partitionName(partition)
	_ = s.cli.CreatePartition(ctx, milvusclient.NewCreatePartitionOption(s.cfg.Collection, p))

	n := len(rows)
	uploadUUIDs := make([]string, n)
	uids := make([]int64, n)
	chunkIdx := make([]int64, n)
	chunkIDs := make([]string, n)
	titles := make([]string, n)
	sources := make([]string, n)
	sourceTypes := make([]string, n)
	sectionTitles := make([]string, n)
	contentTypes := make([]string, n)
	texts := make([]string, n)
	vecs := make([][]float32, n)
	for i := range rows {
		uploadUUIDs[i] = uploadUUID
		uids[i] = uid
		chunkIdx[i] = int64(rows[i].ChunkIndex)
		chunkIDs[i] = rows[i].ChunkID
		titles[i] = utils.TruncateBytes(rows[i].Title, 512)
		sources[i] = utils.TruncateBytes(rows[i].Source, 32)
		sourceTypes[i] = utils.TruncateBytes(rows[i].SourceType, 16)
		sectionTitles[i] = utils.TruncateBytes(rows[i].SectionTitle, 256)
		contentTypes[i] = utils.TruncateBytes(rows[i].ContentType, 32)
		texts[i] = utils.TruncateBytes(rows[i].Text, 65000)
		vecs[i] = rows[i].Vector
	}
	_, err := s.cli.Insert(ctx, milvusclient.NewColumnBasedInsertOption(s.cfg.Collection,
		column.NewColumnVarChar("upload_uuid", uploadUUIDs),
		column.NewColumnInt64("uid", uids),
		column.NewColumnInt64("chunk_index", chunkIdx),
		column.NewColumnVarChar("chunk_id", chunkIDs),
		column.NewColumnVarChar("title", titles),
		column.NewColumnVarChar("source", sources),
		column.NewColumnVarChar("source_type", sourceTypes),
		column.NewColumnVarChar("section_title", sectionTitles),
		column.NewColumnVarChar("content_type", contentTypes),
		column.NewColumnVarChar("text", texts),
		column.NewColumnFloatVector("embedding", s.dim, vecs),
	).WithPartition(p))
	if err != nil {
		return fmt.Errorf("milvus insert: %w", err)
	}
	return nil
}

// CountByUploadUUID returns the number of vectors for an upload_uuid.
func (s *MilvusStore) CountByUploadUUID(ctx context.Context, uploadUUID string) (int, error) {
	rs, err := s.cli.Query(ctx, milvusclient.NewQueryOption(s.cfg.Collection).
		WithFilter(fmt.Sprintf(`upload_uuid == "%s"`, escapeExpr(uploadUUID))).
		WithOutputFields("count(*)").
		// Strong consistency: the consistency check runs right after insert,
		// before the data is flushed — default bounded consistency reads 0.
		WithConsistencyLevel(entity.ClStrong))
	if err != nil {
		return 0, fmt.Errorf("milvus count query: %w", err)
	}
	col := rs.GetColumn("count(*)")
	if col == nil {
		return 0, nil
	}
	vals, err := col.GetAsInt64(0)
	if err != nil {
		return 0, nil
	}
	return int(vals), nil
}

// SearchChunks runs a dense ANN query against the chunk collection and
// returns the top matches in descending score order. filter is assembled by
// the caller from trusted fields only (uid / upload_uuid) — never from client
// input; nothing else is interpolated into the expression here.
func (s *MilvusStore) SearchChunks(ctx context.Context, vector []float32,
	filter string, limit int) ([]model.ChunkHit, error) {
	if len(vector) == 0 {
		return nil, fmt.Errorf("milvus search: empty query vector")
	}
	if limit <= 0 {
		return nil, nil
	}
	opt := milvusclient.NewSearchOption(s.cfg.Collection, limit,
		[]entity.Vector{entity.FloatVector(vector)}).
		WithOutputFields("upload_uuid", "title", "section_title", "text")
	if strings.TrimSpace(filter) != "" {
		opt = opt.WithFilter(filter)
	}
	sets, err := s.cli.Search(ctx, opt)
	if err != nil {
		return nil, fmt.Errorf("milvus search: %w", err)
	}
	hits := make([]model.ChunkHit, 0, limit)
	for _, rs := range sets {
		uuidCol := rs.GetColumn("upload_uuid")
		titleCol := rs.GetColumn("title")
		sectionCol := rs.GetColumn("section_title")
		textCol := rs.GetColumn("text")
		for i := 0; i < rs.Len(); i++ {
			hit := model.ChunkHit{}
			if i < len(rs.Scores) {
				hit.Score = float64(rs.Scores[i])
			}
			if uuidCol != nil {
				hit.UploadUUID, _ = uuidCol.GetAsString(i)
			}
			if titleCol != nil {
				hit.Title, _ = titleCol.GetAsString(i)
			}
			if sectionCol != nil {
				hit.SectionTitle, _ = sectionCol.GetAsString(i)
			}
			if textCol != nil {
				hit.Text, _ = textCol.GetAsString(i)
			}
			hits = append(hits, hit)
		}
	}
	return hits, nil
}

// DeleteByUploadUUID removes all vectors for an upload_uuid (idempotent).
func (s *MilvusStore) DeleteByUploadUUID(ctx context.Context, uploadUUID string) error {
	_, err := s.cli.Delete(ctx, milvusclient.NewDeleteOption(s.cfg.Collection).
		WithExpr(fmt.Sprintf(`upload_uuid == "%s"`, escapeExpr(uploadUUID))))
	return err
}

func escapeExpr(s string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s)
}
