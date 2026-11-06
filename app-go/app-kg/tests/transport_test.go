package tests

import (
	"context"
	"testing"

	"app-kg/internal/kgpb"
	"app-kg/internal/service"
	transportgrpc "app-kg/internal/transport/grpc"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Guard: domain validation errors surface as codes.InvalidArgument with the
// original message (clients treat them as caller bugs). The service validates
// before touching any repository, so nil repos exercise the real handler path.
func TestTransportMapsValidationErrors(t *testing.T) {
	ctx := context.Background()
	srv := transportgrpc.New(transportgrpc.Deps{KG: service.NewKG(nil, nil)})

	checks := []struct {
		name string
		err  error
		want string
	}{
		{
			"resolve scope uid",
			secondResp(srv.ResolveScope(ctx, &kgpb.ResolveScopeRequest{Uid: 0})),
			"uid must be positive",
		},
		{
			"begin page bvid",
			secondResp(srv.BeginPage(ctx, &kgpb.BeginPageRequest{Bvid: ""})),
			"bvid is required",
		},
		{
			"cloud link uid",
			secondResp(srv.LinkCloudDocAppearances(ctx, &kgpb.LinkCloudDocAppearancesRequest{Uid: 0, UploadUuid: "u"})),
			"uid must be positive",
		},
		{
			"cloud evidence limit",
			secondResp(srv.FetchCloudDocEvidence(ctx, &kgpb.FetchCloudDocEvidenceRequest{Eids: []string{"e"}, Uid: 1, Limit: 0})),
			"limit must be positive",
		},
	}
	for _, c := range checks {
		if status.Code(c.err) != codes.InvalidArgument {
			t.Errorf("%s: code = %v, want InvalidArgument", c.name, status.Code(c.err))
			continue
		}
		if got := status.Convert(c.err).Message(); got != c.want {
			t.Errorf("%s: message = %q, want %q", c.name, got, c.want)
		}
	}
}

func secondResp(_ any, err error) error { return err }
