package tests

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"app-cloud/internal/infra/mongostore"
	"app-cloud/internal/model"
	"app-cloud/internal/service"
)

func semanticCatalog() *fakeFileCatalog {
	u1 := cloudFile("u1", 42)
	u1.Title = strPtr("文档一")
	u2 := cloudFile("u2", 42)
	u2.Title = strPtr("文档二")
	return &fakeFileCatalog{files: map[string]*model.CloudFile{"u1": u1, "u2": u2}}
}

func TestSearchSemanticAggregatesByFile(t *testing.T) {
	index := &fakeSemanticIndex{hits: []model.ChunkHit{
		{UploadUUID: "u1", Text: "片段A", Score: 0.92},
		{UploadUUID: "u1", Text: "片段B", Score: 0.81},
		{UploadUUID: "u1", Text: "片段A", Score: 0.70},
		{UploadUUID: "u2", Text: "片段C", Score: 0.88},
		{UploadUUID: "ghost", Text: "已删除文件的片段", Score: 0.99},
	}}
	emb := &fakeEmbedder{}
	svc := service.NewSearchServiceWithPorts(nil, semanticCatalog(), &fakeFolderTree{}, nil, emb, index)

	results, err := svc.SearchSemantic(context.Background(), 42, "  检索词  ", nil, 10)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("results = %d, want 2 owned files (unknown uuid dropped)", len(results))
	}
	if results[0].UploadUUID != "u1" || results[0].Score != 0.92 {
		t.Fatalf("ranking wrong: %+v", results[0])
	}
	if len(results[0].Snippets) != 2 {
		t.Fatalf("snippets must dedupe and cap: %+v", results[0].Snippets)
	}
	if results[0].Title != "文档一" || results[0].OriginalName != "u1.pdf" || results[0].FileSize != 100 {
		t.Fatalf("metadata hydration wrong: %+v", results[0])
	}
	if index.gotFilter != "uid == 42" {
		t.Fatalf("identity filter = %q, want the authenticated uid only", index.gotFilter)
	}
	if index.gotLimit < 20 {
		t.Fatalf("over-fetch limit = %d, want aggregation headroom", index.gotLimit)
	}
	if len(emb.gotTexts) != 1 || emb.gotTexts[0] != "检索词" {
		t.Fatalf("embedded texts = %#v", emb.gotTexts)
	}
}

func TestSearchSemanticRespectsLimit(t *testing.T) {
	hits := []model.ChunkHit{
		{UploadUUID: "u1", Text: "a", Score: 0.9},
		{UploadUUID: "u2", Text: "b", Score: 0.8},
	}
	svc := service.NewSearchServiceWithPorts(nil, semanticCatalog(), &fakeFolderTree{}, nil,
		&fakeEmbedder{}, &fakeSemanticIndex{hits: hits})
	results, err := svc.SearchSemantic(context.Background(), 42, "q", nil, 1)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(results) != 1 || results[0].UploadUUID != "u1" {
		t.Fatalf("limit not applied: %+v", results)
	}
}

// A small folder scope is pushed into the vector expression so files outside
// the folder cannot fill the top-N and produce a false-empty result. With the
// default limit 10 the fetch budget is 10 x 4.
func TestSearchSemanticFolderScopeSmallSetPushesUUIDFilter(t *testing.T) {
	u1 := cloudFile("u1", 42)
	u1.FolderID = int64Ptr(5)
	u2 := cloudFile("u2", 42)
	u2.FolderID = int64Ptr(5)
	outside := cloudFile("outside", 42)
	outside.FolderID = int64Ptr(9)
	catalog := &fakeFileCatalog{
		files:       map[string]*model.CloudFile{"u1": u1, "u2": u2, "outside": outside},
		folderFiles: []model.CloudFile{*u1, *u2},
	}
	index := &fakeSemanticIndex{hits: []model.ChunkHit{
		{UploadUUID: "u1", Text: "文件夹内命中", Score: 0.8},
	}}
	folderID := int64(5)
	svc := service.NewSearchServiceWithPorts(nil, catalog, &fakeFolderTree{ids: []int64{5}}, nil,
		&fakeEmbedder{}, index)

	results, err := svc.SearchSemantic(context.Background(), 42, "关键词", &folderID, 10)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(results) != 1 || results[0].UploadUUID != "u1" {
		t.Fatalf("folder-scope hit lost: %+v", results)
	}
	want := "uid == 42 && upload_uuid in [\"u1\", \"u2\"]"
	if index.gotFilter != want {
		t.Fatalf("filter = %q, want %q", index.gotFilter, want)
	}
	if index.gotLimit != 40 {
		t.Fatalf("fetch limit = %d, want the normal 4x over-fetch of limit 10", index.gotLimit)
	}
}

// Above 200 scoped files the in-list would be huge: the expression stays
// uid-only and the over-fetch widens instead.
func TestSearchSemanticFolderScopeLargeSetWidensOverfetch(t *testing.T) {
	const scopedFiles = 201
	folderFiles := make([]model.CloudFile, 0, scopedFiles)
	files := make(map[string]*model.CloudFile, scopedFiles)
	for i := 0; i < scopedFiles; i++ {
		file := cloudFile(fmt.Sprintf("u%d", i), 42)
		file.FolderID = int64Ptr(5)
		folderFiles = append(folderFiles, *file)
		files[file.UploadUUID] = file
	}
	catalog := &fakeFileCatalog{files: files, folderFiles: folderFiles}
	index := &fakeSemanticIndex{hits: []model.ChunkHit{
		{UploadUUID: "u0", Text: "命中", Score: 0.8},
	}}
	folderID := int64(5)
	svc := service.NewSearchServiceWithPorts(nil, catalog, &fakeFolderTree{ids: []int64{5}}, nil,
		&fakeEmbedder{}, index)

	results, err := svc.SearchSemantic(context.Background(), 42, "关键词", &folderID, 10)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("large-scope hit lost: %+v", results)
	}
	if index.gotFilter != "uid == 42" {
		t.Fatalf("large scope must not inline hundreds of uuids: %q", index.gotFilter)
	}
	if index.gotLimit <= 40 {
		t.Fatalf("large scope must over-fetch beyond the normal 40, got %d", index.gotLimit)
	}
}

func TestSearchSemanticEmptyFolderShortCircuits(t *testing.T) {
	index := &fakeSemanticIndex{}
	folderID := int64(5)
	svc := service.NewSearchServiceWithPorts(nil, &fakeFileCatalog{files: map[string]*model.CloudFile{}},
		&fakeFolderTree{}, nil, &fakeEmbedder{}, index)
	results, err := svc.SearchSemantic(context.Background(), 42, "q", &folderID, 10)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("empty folder must yield no results: %+v", results)
	}
	if index.calls != 0 {
		t.Fatalf("an empty folder scope must not query the vector store, calls = %d", index.calls)
	}
}

func TestSearchSemanticUnavailable(t *testing.T) {
	disabled := service.NewSearchServiceWithPorts(nil, semanticCatalog(), &fakeFolderTree{}, nil, nil, nil)
	if _, err := disabled.SearchSemantic(context.Background(), 42, "q", nil, 10); !errors.Is(err, service.ErrSemanticUnavailable) {
		t.Fatalf("nil ports must be unavailable, got %v", err)
	}
	embedDown := service.NewSearchServiceWithPorts(nil, semanticCatalog(), &fakeFolderTree{}, nil,
		&fakeEmbedder{err: errors.New("gateway down")}, &fakeSemanticIndex{})
	if _, err := embedDown.SearchSemantic(context.Background(), 42, "q", nil, 10); !errors.Is(err, service.ErrSemanticUnavailable) {
		t.Fatalf("embedding failure must be unavailable, got %v", err)
	}
	indexDown := service.NewSearchServiceWithPorts(nil, semanticCatalog(), &fakeFolderTree{}, nil,
		&fakeEmbedder{}, &fakeSemanticIndex{err: errors.New("milvus down")})
	if _, err := indexDown.SearchSemantic(context.Background(), 42, "q", nil, 10); !errors.Is(err, service.ErrSemanticUnavailable) {
		t.Fatalf("index failure must be unavailable, got %v", err)
	}
}

func TestSimilarExcludesSelfAndUsesSummaryOverview(t *testing.T) {
	target := cloudFile("target", 42)
	target.Title = strPtr("目标文档")
	target.ContentHash = strPtr("hash-1")
	other := cloudFile("other", 42)
	catalog := &fakeFileCatalog{files: map[string]*model.CloudFile{"target": target, "other": other}}
	store := &fakeSummaryStore{stored: map[string]*mongostore.StoredSummary{
		"target": {
			Model:       "m",
			ContentHash: "hash-1",
			Summary:     map[string]any{"overview": "目标文件的概述"},
		},
	}}
	summarySvc := service.NewSummaryServiceWithPorts(nil, catalog, store)
	emb := &fakeEmbedder{}
	index := &fakeSemanticIndex{hits: []model.ChunkHit{
		{UploadUUID: "target", Text: "自身片段", Score: 0.99},
		{UploadUUID: "other", Text: "相似片段", Score: 0.85},
	}}
	svc := service.NewSearchServiceWithPorts(nil, catalog, &fakeFolderTree{}, summarySvc, emb, index)

	results, err := svc.Similar(context.Background(), 42, "target", 5)
	if err != nil {
		t.Fatalf("similar: %v", err)
	}
	if len(results) != 1 || results[0].UploadUUID != "other" {
		t.Fatalf("self must be excluded: %+v", results)
	}
	if len(emb.gotTexts) != 1 || !strings.Contains(emb.gotTexts[0], "目标文档") ||
		!strings.Contains(emb.gotTexts[0], "目标文件的概述") {
		t.Fatalf("probe text must combine title and summary overview: %#v", emb.gotTexts)
	}
	if index.gotFilter != "uid == 42" {
		t.Fatalf("filter = %q", index.gotFilter)
	}
}

func TestSimilarFallsBackToTitleWithoutSummary(t *testing.T) {
	target := cloudFile("target", 42)
	catalog := &fakeFileCatalog{files: map[string]*model.CloudFile{"target": target}}
	emb := &fakeEmbedder{}
	svc := service.NewSearchServiceWithPorts(nil, catalog, &fakeFolderTree{}, nil, emb, &fakeSemanticIndex{})
	if _, err := svc.Similar(context.Background(), 42, "target", 5); err != nil {
		t.Fatalf("similar: %v", err)
	}
	if len(emb.gotTexts) != 1 || emb.gotTexts[0] != "target.pdf" {
		t.Fatalf("probe text = %#v, want the file name", emb.gotTexts)
	}
}

func TestSimilarNotFoundAndUnavailable(t *testing.T) {
	svc := service.NewSearchServiceWithPorts(nil, semanticCatalog(), &fakeFolderTree{}, nil,
		&fakeEmbedder{}, &fakeSemanticIndex{})
	if _, err := svc.Similar(context.Background(), 42, "missing", 5); !errors.Is(err, service.ErrNotFound) {
		t.Fatalf("missing file must be ErrNotFound, got %v", err)
	}
	disabled := service.NewSearchServiceWithPorts(nil, semanticCatalog(), &fakeFolderTree{}, nil, nil, nil)
	if _, err := disabled.Similar(context.Background(), 42, "u1", 5); !errors.Is(err, service.ErrSemanticUnavailable) {
		t.Fatalf("disabled search must be unavailable, got %v", err)
	}
}
