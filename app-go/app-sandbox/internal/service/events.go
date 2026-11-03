package service

import "sync"

// Event is one SSE frame published for an execution.
type Event struct {
	Type string
	Data map[string]any
}

const eventHistoryLimit = 128

// eventHub fans execution events out to SSE subscribers and keeps a bounded
// replay buffer so a client that connects after the fact still sees the status
// transitions (the done frame is delivered by closing the channel).
type eventHub struct {
	mu     sync.Mutex
	topics map[string]*eventTopic
}

type eventTopic struct {
	history []Event
	subs    map[chan Event]struct{}
	closed  bool
}

func newEventHub() *eventHub {
	return &eventHub{topics: make(map[string]*eventTopic)}
}

func (h *eventHub) topic(executionID string) *eventTopic {
	t, ok := h.topics[executionID]
	if !ok {
		t = &eventTopic{subs: make(map[chan Event]struct{})}
		h.topics[executionID] = t
	}
	return t
}

// Subscribe returns the replay history, a live channel and a cancel func. When
// the execution already finished, the live channel is closed immediately.
func (h *eventHub) Subscribe(executionID string) ([]Event, <-chan Event, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	t := h.topic(executionID)
	history := append([]Event(nil), t.history...)
	if t.closed {
		done := make(chan Event)
		close(done)
		return history, done, func() {}
	}
	ch := make(chan Event, 64)
	t.subs[ch] = struct{}{}
	cancel := func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if _, ok := t.subs[ch]; ok {
			delete(t.subs, ch)
			close(ch)
		}
	}
	return history, ch, cancel
}

// Publish appends to the replay history and fans out to live subscribers. A slow
// subscriber drops frames (it can still poll GET /v1/executions/{id}).
func (h *eventHub) Publish(executionID string, ev Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	t := h.topic(executionID)
	if len(t.history) >= eventHistoryLimit {
		t.history = t.history[1:]
	}
	t.history = append(t.history, ev)
	if t.closed {
		return
	}
	for ch := range t.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// Close marks the topic finished and closes every live subscriber channel; the
// history stays readable for late subscribers.
func (h *eventHub) Close(executionID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	t := h.topic(executionID)
	if t.closed {
		return
	}
	t.closed = true
	for ch := range t.subs {
		close(ch)
	}
	t.subs = make(map[chan Event]struct{})
}
