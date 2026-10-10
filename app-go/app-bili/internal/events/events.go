// Package events — Redis pub/sub for cross-service hand-off. app-bili
// publishes (a) per-page ASR completion (`bili:page_ready`) for the Python
// AI stack to trigger vectorization, and (b) task progress (`bili:tasks`)
// for the WS bridge. Channels mirror the app-cloud ws_bridge convention.
package events

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/redis/go-redis/v9"
)

const (
	ChannelPageReady = "bili:page_ready"
	ChannelTasks     = "bili:tasks"
)

// PageReadyEvent — payload of bili:page_ready.
type PageReadyEvent struct {
	UID     int64  `json:"uid"`
	BvID    string `json:"bvid"`
	CID     int64  `json:"cid"`
	Version int    `json:"version"`
	TaskID  string `json:"task_id"`
}

// TaskEvent — payload of bili:tasks (shape mirrors the Python
// broadcast_task_update WS payload so the bridge stays a thin forwarder).
type TaskEvent struct {
	TaskID      string         `json:"task_id"`
	TaskType    string         `json:"task_type"`
	Status      string         `json:"status"`
	Progress    int            `json:"progress"`
	Message     string         `json:"message"`
	CurrentStep map[string]any `json:"cursor,omitempty"`
}

type Publisher struct{ rdb redis.UniversalClient }

func NewPublisher(rdb redis.UniversalClient) *Publisher { return &Publisher{rdb: rdb} }

func (p *Publisher) publish(ctx context.Context, channel string, payload any) {
	if p == nil || p.rdb == nil {
		return
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	if err := p.rdb.Publish(ctx, channel, raw).Err(); err != nil {
		slog.Warn("[BILI] publish failed", "channel", channel, "err", err)
	}
}

func (p *Publisher) PageReady(ctx context.Context, ev PageReadyEvent) {
	p.publish(ctx, ChannelPageReady, ev)
}

func (p *Publisher) Task(ctx context.Context, ev TaskEvent) {
	p.publish(ctx, ChannelTasks, ev)
}
