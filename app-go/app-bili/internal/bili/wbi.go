// WBI signature — port of app/services/wbi.py (algorithm per
// bilibili-API-collect docs). The mixin table and md5 pipeline are pinned by
// wbi_test.go with Python-generated fixtures; do not "optimize" the pipeline.
package bili

import (
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// mixinKeyEncTab — WBI 混淆表.
var mixinKeyEncTab = [64]int{
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
	27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
	37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
	22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
}

// mixinKey reorders orig by the table and truncates to 32 chars.
func mixinKey(orig string) string {
	var b strings.Builder
	for _, i := range mixinKeyEncTab {
		if i < len(orig) {
			b.WriteByte(orig[i])
		}
	}
	return b.String()[:32]
}

// wbiKeys holds the rotated img/sub keys. Keys are public device/IP-scoped
// params rotated a few times per day; 6h refresh matches the Python signer.
type wbiKeys struct {
	mu         sync.RWMutex
	mixin      string
	lastUpdate time.Time
	interval   time.Duration
}

func newWbiKeys() *wbiKeys { return &wbiKeys{interval: 6 * time.Hour} }

func (k *wbiKeys) get() (string, bool) {
	k.mu.RLock()
	defer k.mu.RUnlock()
	if k.mixin == "" || time.Since(k.lastUpdate) > k.interval {
		return "", false
	}
	return k.mixin, true
}

func (k *wbiKeys) set(imgKey, subKey string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.mixin = mixinKey(imgKey + subKey)
	k.lastUpdate = time.Now()
}

// invalidate forces a refresh (wired to 412 / auth failures on WBI routes).
func (k *wbiKeys) invalidate() {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.lastUpdate = time.Time{}
}

// extractWbiKeys pulls img/sub keys from a /x/web-interface/nav payload.
// /nav returns code=-101 when anonymous but still carries wbi_img — keys are
// public; only a missing wbi_img is an error.
func extractWbiKeys(navPayload map[string]any) (imgKey, subKey string, err error) {
	data, _ := navPayload["data"].(map[string]any)
	wbiImg, _ := data["wbi_img"].(map[string]any)
	imgURL, _ := wbiImg["img_url"].(string)
	subURL, _ := wbiImg["sub_url"].(string)
	if imgURL == "" || subURL == "" {
		return "", "", fmt.Errorf("nav payload missing wbi_img")
	}
	imgKey = fileNameStem(imgURL)
	subKey = fileNameStem(subURL)
	return imgKey, subKey, nil
}

func fileNameStem(u string) string {
	i := strings.LastIndex(u, "/")
	if i >= 0 {
		u = u[i+1:]
	}
	if j := strings.Index(u, "."); j >= 0 {
		u = u[:j]
	}
	return u
}

// filterParamValue strips characters B站 excludes from the signed query.
func filterParamValue(v string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case '!', '\'', '(', '*', ')':
			return -1
		}
		return r
	}, v)
}

// signParams computes w_rid over the sorted filtered params + wts, returning
// the full signed query values (original params + wts + w_rid).
func signParams(params map[string]string, mixin string, now time.Time) url.Values {
	filtered := url.Values{}
	for k, v := range params {
		filtered.Set(k, filterParamValue(v))
	}
	filtered.Set("wts", strconv.FormatInt(now.Unix(), 10))

	keys := make([]string, 0, len(filtered))
	for k := range filtered {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var b strings.Builder
	for i, k := range keys {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(url.QueryEscape(k))
		b.WriteByte('=')
		b.WriteString(url.QueryEscape(filtered.Get(k)))
	}
	sum := md5.Sum([]byte(b.String() + mixin))
	wRid := hex.EncodeToString(sum[:])

	filtered.Set("w_rid", wRid)
	return filtered
}
