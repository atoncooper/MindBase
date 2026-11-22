// Command apisix-sync bootstraps and maintains APISIX's etcd-backed config
// from the rendered declarative seed (apisix.yaml), and is baked into the
// mindbase derived APISIX image.
//
// Why this exists: APISIX 3.20's "apisix init_etcd" does NOT import
// conf/apisix.yaml into etcd. Traditional + etcd mode therefore starts with an
// empty config, and certificate/consumer rotation no longer flows from
// render-config.sh. This tool closes both gaps:
//
//  1. first boot (etcd routes empty): import the whole rendered seed
//     (ssls -> consumers -> upstreams -> routes) through the Admin API;
//  2. every sync interval: upsert ssls (cert rotation) and internal consumers
//     (API keys from .env) only when they changed.
//
// Routes/upstreams become etcd-managed after the first import: subsequent
// changes go through the Dashboard UI / Admin API, and the seed is only a
// disaster-recovery baseline.
package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type seed struct {
	Upstreams []map[string]any `yaml:"upstreams"`
	Routes    []map[string]any `yaml:"routes"`
	SSLS      []map[string]any `yaml:"ssls"`
	Consumers []map[string]any `yaml:"consumers"`
	// Optional sections, supported for forward compatibility.
	Services       []map[string]any `yaml:"services"`
	PluginConfigs  []map[string]any `yaml:"plugin_configs"`
	GlobalRules    []map[string]any `yaml:"global_rules"`
	StreamRoutes   []map[string]any `yaml:"stream_routes"`
	PluginMetadata map[string]any   `yaml:"plugin_metadata"`
}

type adminClient struct {
	base   string
	apiKey string
	http   *http.Client
}

func newAdminClient(base, key, caFile, serverName string) (*adminClient, error) {
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, fmt.Errorf("read CA %s: %w", caFile, err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("no certificates parsed from %s", caFile)
		}
		tlsCfg.RootCAs = pool
	}
	if serverName != "" {
		tlsCfg.ServerName = serverName
	}
	transport := &http.Transport{TLSClientConfig: tlsCfg, Proxy: nil}
	return &adminClient{
		base:   strings.TrimRight(base, "/"),
		apiKey: key,
		http:   &http.Client{Timeout: 15 * time.Second, Transport: transport},
	}, nil
}

func (c *adminClient) do(method, path string, body any) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, c.base+path, reader)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("X-API-KEY", c.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	out, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return res.StatusCode, nil, err
	}
	return res.StatusCode, out, nil
}

// valueOf fetches a single Admin API resource and returns its "value" object.
func (c *adminClient) valueOf(path string) (map[string]any, bool, error) {
	code, body, err := c.do(http.MethodGet, path, nil)
	if err != nil {
		return nil, false, err
	}
	if code == http.StatusNotFound {
		return nil, false, nil
	}
	if code != http.StatusOK {
		return nil, false, fmt.Errorf("GET %s -> %d: %s", path, code, truncate(string(body), 200))
	}
	var wrapper struct {
		Value map[string]any `json:"value"`
	}
	if err := json.Unmarshal(body, &wrapper); err != nil {
		return nil, false, fmt.Errorf("decode GET %s: %w", path, err)
	}
	return wrapper.Value, true, nil
}

func (c *adminClient) put(path string, body any) error {
	code, out, err := c.do(http.MethodPut, path, body)
	if err != nil {
		return err
	}
	if code != http.StatusOK && code != http.StatusCreated {
		return fmt.Errorf("PUT %s -> %d: %s", path, code, truncate(string(out), 300))
	}
	return nil
}

func (c *adminClient) routesEmpty() (bool, error) {
	code, body, err := c.do(http.MethodGet, "/apisix/admin/routes", nil)
	if err != nil {
		return false, err
	}
	if code != http.StatusOK {
		return false, fmt.Errorf("GET routes -> %d: %s", code, truncate(string(body), 200))
	}
	var payload struct {
		Total int   `json:"total"`
		List  []any `json:"list"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return false, err
	}
	return payload.Total == 0 && len(payload.List) == 0, nil
}

func loadSeed(path string) (*seed, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var s seed
	if err := yaml.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("parse seed %s: %w", path, err)
	}
	return &s, nil
}

func idOf(item map[string]any) string {
	if v, ok := item["id"].(string); ok {
		return v
	}
	if v, ok := item["id"].(int); ok {
		return fmt.Sprint(v)
	}
	return ""
}

func usernameOf(item map[string]any) string {
	v, _ := item["username"].(string)
	return v
}

func importSeed(c *adminClient, s *seed) error {
	total := 0
	for _, item := range s.SSLS {
		id := idOf(item)
		if id == "" {
			return fmt.Errorf("ssl without id")
		}
		if err := c.put("/apisix/admin/ssls/"+id, item); err != nil {
			return err
		}
		total++
	}
	for _, item := range s.Consumers {
		if usernameOf(item) == "" {
			return fmt.Errorf("consumer without username")
		}
		if err := c.put("/apisix/admin/consumers", item); err != nil {
			return err
		}
		total++
	}
	putList := func(items []map[string]any, base string) error {
		for _, item := range items {
			id := idOf(item)
			if id == "" {
				return fmt.Errorf("%s item without id", base)
			}
			if err := c.put(base+"/"+id, item); err != nil {
				return err
			}
			total++
		}
		return nil
	}
	if err := putList(s.Services, "/apisix/admin/services"); err != nil {
		return err
	}
	if err := putList(s.Upstreams, "/apisix/admin/upstreams"); err != nil {
		return err
	}
	if err := putList(s.PluginConfigs, "/apisix/admin/plugin_configs"); err != nil {
		return err
	}
	if err := putList(s.GlobalRules, "/apisix/admin/global_rules"); err != nil {
		return err
	}
	for name, meta := range s.PluginMetadata {
		if err := c.put("/apisix/admin/plugin_metadata/"+name, meta); err != nil {
			return err
		}
		total++
	}
	if err := putList(s.Routes, "/apisix/admin/routes"); err != nil {
		return err
	}
	if err := putList(s.StreamRoutes, "/apisix/admin/stream_routes"); err != nil {
		return err
	}
	log.Printf("seed imported: %d resources", total)
	return nil
}

// sameSubset reports whether all wanted keys in want are present in got with
// equal values, using JSON round-trips for type normalisation.
func sameSubset(want, got map[string]any, keys ...string) bool {
	for _, k := range keys {
		w, ok := want[k]
		if !ok {
			continue
		}
		g, ok := got[k]
		if !ok {
			return false
		}
		wb, _ := json.Marshal(w)
		gb, _ := json.Marshal(g)
		if !bytes.Equal(wb, gb) {
			return false
		}
	}
	return true
}

func syncSSLS(c *adminClient, s *seed) {
	for _, item := range s.SSLS {
		id := idOf(item)
		if id == "" {
			continue
		}
		got, ok, err := c.valueOf("/apisix/admin/ssls/" + id)
		if err != nil {
			log.Printf("sync ssl %s: read: %v", id, err)
			continue
		}
		if ok && sameSubset(item, got, "cert", "key", "snis") {
			continue
		}
		if err := c.put("/apisix/admin/ssls/"+id, item); err != nil {
			log.Printf("sync ssl %s: write: %v", id, err)
			continue
		}
		log.Printf("ssl %s synced", id)
	}
}

func syncConsumers(c *adminClient, s *seed) {
	for _, item := range s.Consumers {
		username := usernameOf(item)
		if username == "" {
			continue
		}
		got, ok, err := c.valueOf("/apisix/admin/consumers/" + username)
		if err != nil {
			log.Printf("sync consumer %s: read: %v", username, err)
			continue
		}
		if ok && sameSubset(item, got, "plugins") {
			continue
		}
		if err := c.put("/apisix/admin/consumers", item); err != nil {
			log.Printf("sync consumer %s: write: %v", username, err)
			continue
		}
		log.Printf("consumer %s synced", username)
	}
}

func envBool(name string) bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv(name)))
	return v == "1" || v == "true" || v == "yes"
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func main() {
	var (
		seedPath   = flag.String("seed", "/rendered/apisix.yaml", "rendered declarative seed")
		adminURL   = flag.String("admin-url", "https://127.0.0.1:9180", "APISIX Admin API base URL")
		caFile     = flag.String("ca", "/tmp/ca-bundle.crt", "CA bundle used to verify the Admin API TLS cert")
		serverName = flag.String("server-name", "localhost", "TLS server name for the Admin API cert")
		interval   = flag.Duration("interval", 60*time.Second, "managed-resource sync interval (0 = sync once)")
		waitFor    = flag.Duration("wait", 180*time.Second, "how long to wait for the Admin API")
		force      = flag.Bool("force-import", envBool("APISIX_SYNC_FORCE_IMPORT"), "import the seed even when etcd already has routes (one-off migration override)")
	)
	flag.Parse()

	key := strings.TrimSpace(os.Getenv("APISIX_ADMIN_KEY"))
	if key == "" {
		log.Fatal("APISIX_ADMIN_KEY is required")
	}
	client, err := newAdminClient(*adminURL, key, *caFile, *serverName)
	if err != nil {
		log.Fatalf("admin client: %v", err)
	}

	deadline := time.Now().Add(*waitFor)
	for {
		if _, err := client.routesEmpty(); err == nil {
			break
		} else if time.Now().After(deadline) {
			log.Fatalf("Admin API not ready: %v", err)
		}
		time.Sleep(2 * time.Second)
	}

	s, err := loadSeed(*seedPath)
	if err != nil {
		log.Fatalf("load seed: %v", err)
	}
	empty, err := client.routesEmpty()
	if err != nil {
		log.Fatalf("read routes: %v", err)
	}
	if empty || *force {
		if *force && !empty {
			log.Printf("force-import enabled: overwriting existing etcd resources from seed")
		}
		if err := importSeed(client, s); err != nil {
			log.Printf("seed import failed (will retry on next sync): %v", err)
		}
	} else {
		log.Printf("etcd already has routes; skipping seed import (seed is DR baseline only)")
	}

	syncManaged := func() {
		syncSSLS(client, s)
		syncConsumers(client, s)
	}
	syncManaged()
	if *interval <= 0 {
		return
	}
	ticker := time.NewTicker(*interval)
	defer ticker.Stop()
	for range ticker.C {
		syncManaged()
	}
}
