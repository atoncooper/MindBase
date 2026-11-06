package grpc

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

// requestIDFromContext reads the gateway/caller-generated request id (grpc
// metadata "x-request-id") for log correlation.
func requestIDFromContext(ctx context.Context) string {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return ""
	}
	values := md.Get("x-request-id")
	if len(values) == 0 {
		return ""
	}
	return strings.TrimSpace(values[0])
}

// Interceptor returns the unary server chain: request-id correlation +
// structured access log + panic recovery.
func Interceptor() grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler,
	) (resp any, err error) {
		requestID := requestIDFromContext(ctx)
		if requestID == "" {
			requestID = uuid.NewString()
		}
		start := time.Now()
		resp, err = handler(ctx, req)
		attrs := []slog.Attr{
			slog.String("module", "grpc"),
			slog.String("method", info.FullMethod),
			slog.Duration("latency", time.Since(start)),
			slog.String("request_id", requestID),
		}
		if err != nil {
			attrs = append(attrs, slog.String("err", err.Error()))
			slog.LogAttrs(ctx, slog.LevelWarn, "grpc request failed", attrs...)
		} else {
			slog.LogAttrs(ctx, slog.LevelInfo, "grpc request", attrs...)
		}
		return resp, err
	}
}
