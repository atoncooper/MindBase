package tests

import (
	"context"
	"errors"
	"testing"

	"app-kg/internal/service"
)

func isInvalid(err error, want string) bool {
	var inv *service.InvalidArgumentError
	return errors.As(err, &inv) && inv.Error() == want
}

// TestKGValidation: all domain validation must happen in the service layer,
// before any repo call — nil repositories prove the order.
func TestKGValidation(t *testing.T) {
	ctx := context.Background()
	kg := service.NewKG(nil, nil)

	checks := []struct {
		name string
		err  error
		want string
	}{
		{"scope uid", second(kg.ResolveScope(ctx, 0, nil)), "uid must be positive"},
		{"pending limit", second(kg.SelectPendingPages(ctx, []string{"BV1"}, 0)), "limit must be positive"},
		{"begin bvid", second(kg.BeginPage(ctx, "", 1, nil)), "bvid is required"},
		{"done bvid", kg.MarkPageDone(ctx, "", 1, 1), "bvid is required"},
		{"failed bvid", kg.MarkPageFailed(ctx, "", 1), "bvid is required"},
		{"neighbors limit", second(kg.Neighbors(ctx, []string{"e"}, nil, 0)), "limit must be positive"},
		{"evidence limit", second(kg.FetchEvidence(ctx, []string{"e"}, nil, 0)), "limit must be positive"},
		{"exposure limit", second(kg.EntityExposure(ctx, []string{"BV1"}, 0)), "limit must be positive"},
		{"appearances eid", second(kg.EntityAppearances(ctx, "", nil, 10)), "eid is required"},
		{"appearances limit", second(kg.EntityAppearances(ctx, "e", nil, 0)), "limit must be positive"},
		{"top limit", second(kg.TopEntities(ctx, 0)), "limit must be positive"},
		{
			"entity normalization",
			second(kg.UpsertEntities(ctx, []service.EntityInput{{Eid: "e1", Name: "Name"}})),
			"entity requires eid/name/name_lower (caller computes normalization)",
		},
		{"link bvid", second(kg.LinkAppearances(ctx, "", 0, nil)), "bvid is required"},
		{"delete evidence bvid", second(kg.DeletePageEvidence(ctx, "", 0)), "bvid is required"},
		{"delete video bvid", second3(kg.DeleteVideo(ctx, "")), "bvid is required"},
		{"cloud link uid", second(kg.LinkCloudDocAppearances(ctx, 0, "u", "", "", nil)), "uid must be positive"},
		{"cloud link upload_uuid", second(kg.LinkCloudDocAppearances(ctx, 1, "", "", "", nil)), "upload_uuid is required"},
		{"cloud delete uid", second3(kg.DeleteCloudDocAppearances(ctx, 0, "u")), "uid must be positive"},
		{"cloud delete upload_uuid", second3(kg.DeleteCloudDocAppearances(ctx, 1, "")), "upload_uuid is required"},
		{"cloud evidence uid", second(kg.FetchCloudDocEvidence(ctx, []string{"e"}, 0, nil, 10)), "uid must be positive"},
		{"cloud evidence limit", second(kg.FetchCloudDocEvidence(ctx, []string{"e"}, 1, nil, 0)), "limit must be positive"},
	}
	for _, c := range checks {
		if !isInvalid(c.err, c.want) {
			t.Errorf("%s: err = %v, want InvalidArgumentError(%q)", c.name, c.err, c.want)
		}
	}
}

// TestCloudDocValidation covers the internal JSON endpoint contract: invalid
// payloads are rejected by the service (transport maps them to HTTP 422).
func TestCloudDocValidation(t *testing.T) {
	ctx := context.Background()
	svc := service.NewCloudDoc(nil)

	if err := svc.Upsert(ctx, service.CloudDocGraph{UID: 0, UploadUUID: "u"}); !isInvalid(err, "uid and upload_uuid are required") {
		t.Errorf("upsert uid: err = %v", err)
	}
	if err := svc.Upsert(ctx, service.CloudDocGraph{UID: 1, UploadUUID: "  "}); !isInvalid(err, "uid and upload_uuid are required") {
		t.Errorf("upsert upload_uuid: err = %v", err)
	}
	if err := svc.Delete(ctx, 0, "u"); !isInvalid(err, "uid and upload_uuid are required") {
		t.Errorf("delete uid: err = %v", err)
	}
	if _, err := svc.Match(ctx, 0, []string{"k"}, 10); !isInvalid(err, "uid must be positive") {
		t.Errorf("match uid: err = %v", err)
	}
}

func second[T any](_ T, err error) error { return err }

func second3[T1, T2 any](_ T1, _ T2, err error) error { return err }
