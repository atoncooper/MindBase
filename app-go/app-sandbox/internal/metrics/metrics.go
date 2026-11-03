// Package metrics is a dependency-free Prometheus text exposition registry: the
// control plane needs a few counters plus gauges computed from live services,
// which does not justify pulling in the client library.
package metrics

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

// Metrics is a concurrency-safe counter/gauge registry.
type Metrics struct {
	mu      sync.RWMutex
	series  map[string]*series
	gauges  map[string]*gauge
	started string
}

type series struct {
	labels  map[string]string
	counter atomic.Int64
	// gaugeSeries marks values registered through AddGauge (all others count
	// monotonically and are exposed as Prometheus counters).
	gaugeSeries bool
}

type gauge struct {
	labels map[string]string
	fn     func() int64
}

// New returns an empty registry.
func New() *Metrics {
	return &Metrics{
		series: make(map[string]*series),
		gauges: make(map[string]*gauge),
	}
}

func key(name string, labels map[string]string) string {
	if len(labels) == 0 {
		return name
	}
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(name)
	b.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, "%s=%q", k, labels[k])
	}
	b.WriteByte('}')
	return b.String()
}

// metricName strips the label set from an exposition key.
func metricName(key string) string {
	if idx := strings.IndexByte(key, '{'); idx >= 0 {
		return key[:idx]
	}
	return key
}

// Inc adds one to the counter with the given name/labels (creating it lazily).
func (m *Metrics) Inc(name string, labels map[string]string) {
	m.Add(name, labels, 1)
}

// Add adds delta to the counter with the given name/labels.
func (m *Metrics) Add(name string, labels map[string]string, delta int64) {
	k := key(name, labels)
	m.mu.RLock()
	s := m.series[k]
	m.mu.RUnlock()
	if s == nil {
		m.mu.Lock()
		if s = m.series[k]; s == nil {
			s = &series{labels: labels}
			m.series[k] = s
		}
		m.mu.Unlock()
	}
	s.counter.Add(delta)
}

// AddGauge registers (or replaces) a gauge callback scraped at exposition time.
func (m *Metrics) AddGauge(name string, labels map[string]string, fn func() int64) {
	k := key(name, labels)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gauges[k] = &gauge{labels: labels, fn: fn}
}

// Render produces the Prometheus text exposition format.
func (m *Metrics) Render() string {
	m.mu.RLock()
	type row struct {
		key string
		val int64
	}
	rows := make([]row, 0, len(m.series)+len(m.gauges))
	kinds := make(map[string]string, len(m.series)+len(m.gauges))
	for k, s := range m.series {
		rows = append(rows, row{key: k, val: s.counter.Load()})
		kinds[metricName(k)] = "counter"
	}
	for k, g := range m.gauges {
		rows = append(rows, row{key: k, val: g.fn()})
		kinds[metricName(k)] = "gauge"
	}
	m.mu.RUnlock()

	sort.Slice(rows, func(i, j int) bool { return rows[i].key < rows[j].key })
	var b strings.Builder
	declared := make(map[string]bool, len(kinds))
	for _, r := range rows {
		name := metricName(r.key)
		if !declared[name] {
			declared[name] = true
			fmt.Fprintf(&b, "# TYPE %s %s\n", name, kinds[name])
		}
		fmt.Fprintf(&b, "%s %d\n", r.key, r.val)
	}
	return b.String()
}
