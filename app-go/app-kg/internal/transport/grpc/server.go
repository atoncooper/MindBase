// Package grpc is app-kg's gRPC transport boundary (kg.v1.KgGraph): proto ↔
// service mapping plus request-id correlation, structured access logging and
// panic recovery. It holds no graph/SQL logic — business rules live in
// internal/service, data access in internal/repo.
package grpc

import (
	"errors"

	"app-kg/internal/kgpb"
	"app-kg/internal/service"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Deps wires the service into the gRPC transport.
type Deps struct {
	KG *service.KGService
}

// Server implements kgpb.KgGraphServer as a pure protocol adapter.
type Server struct {
	kgpb.UnimplementedKgGraphServer
	kg *service.KGService
}

// New builds the transport.
func New(d Deps) *Server { return &Server{kg: d.KG} }

// mapError translates service-layer errors to gRPC statuses: domain
// validation → InvalidArgument, everything else → Internal with the operation
// name (Neo4j/MySQL unavailability surfaces as Internal; the app-ts side
// degrades or fails the build page, never the whole service).
func mapError(op string, err error) error {
	var inv *service.InvalidArgumentError
	if errors.As(err, &inv) {
		return status.Error(codes.InvalidArgument, inv.Error())
	}
	return status.Errorf(codes.Internal, "%s: %v", op, err)
}
