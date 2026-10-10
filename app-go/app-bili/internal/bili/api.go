// API surface — port of app/services/bilibili.py. Typed only where the
// service layer needs fields; raw payloads pass through as maps elsewhere.
package bili

import (
	"context"

	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// FavFolder mirrors the created/list-all entry (fields the service uses).
// 注意字段映射：list-all 条目的收藏夹 ID 在 "id" 里（Python 原版
// f.get("id") or f.get("media_id")，见 app/services/favorite/service.py），
// 响应中没有 "media_id" 键 —— tag 写错会让 MediaID 全为 0，
// 被 SyncFolders 的零值过滤整个清空（2026-10-08 修复）。
type FavFolder struct {
	ID         int64  `json:"id"`
	FID        int64  `json:"fid"`
	MediaID    int64  `json:"media_id"`
	Title      string `json:"title"`
	MediaCount int    `json:"media_count"`
	Attr       int    `json:"attr"`
	Type       int    `json:"type"`
	FavState   int    `json:"fav_state"`
}

// FavMedia mirrors one fav/resource/list entry.
type FavMedia struct {
	ID       int64  `json:"id"`
	Type     int    `json:"type"`
	BvID     string `json:"bvid"`
	Title    string `json:"title"`
	Cover    string `json:"cover"`
	Intro    string `json:"intro"`
	Duration int    `json:"duration"`
	Attr     int    `json:"attr"`
	Upper    struct {
		Mid  int64  `json:"mid"`
		Name string `json:"name"`
	} `json:"upper"`
	UGC struct {
		FirstCID int64 `json:"first_cid"`
	} `json:"ugc"`
	CntInfo struct {
		Collect int `json:"collect"`
	} `json:"cnt_info"`
}

// FavPage is one fav/resource/list page.
type FavPage struct {
	Info    map[string]any `json:"info"`
	Medias  []FavMedia     `json:"medias"`
	HasMore bool           `json:"has_more"`
}

// GetFavorites returns every folder of the linked user.
func (c *Client) GetFavorites(ctx context.Context) ([]FavFolder, error) {
	if c.mid == 0 {
		return nil, fmt.Errorf("未指定用户 ID")
	}
	q := url.Values{"up_mid": {fmtInt(c.mid)}}
	var payload struct {
		Data struct {
			List []FavFolder `json:"list"`
		} `json:"data"`
	}
	if err := c.doJSON(ctx, http.MethodGet, apiBase+"/x/v3/fav/folder/created/list-all", q, nil, &payload, false); err != nil {
		return nil, err
	}
	out := payload.Data.List
	for i := range out {
		if out[i].MediaID == 0 {
			out[i].MediaID = out[i].ID
		}
	}
	return out, nil
}

// GetFavoriteContent fetches one page of a folder (ps capped at 20 — the API
// rejects larger values).
func (c *Client) GetFavoriteContent(ctx context.Context, mediaID int64, pn, ps int) (*FavPage, error) {
	if ps > 20 {
		ps = 20
	}
	q := url.Values{
		"media_id": {fmtInt(mediaID)},
		"pn":       {fmtInt(int64(pn))},
		"ps":       {fmtInt(int64(ps))},
		"platform": {"web"},
	}
	// doJSON 的 out 接收完整信封（code/message/data）——必须先解包 data，
	// 否则 medias 永远解析为空（2026-10-08 修复：此前把信封直接解析进 FavPage）。
	var payload struct {
		Data FavPage `json:"data"`
	}
	if err := c.doJSON(ctx, http.MethodGet, apiBase+"/x/v3/fav/resource/list", q, nil, &payload, false); err != nil {
		return nil, err
	}
	return &payload.Data, nil
}

// GetAllFavoriteVideos walks every page of a folder with web-like pacing.
func (c *Client) GetAllFavoriteVideos(ctx context.Context, mediaID int64) ([]FavMedia, error) {
	var all []FavMedia
	pn := 1
	for {
		page, err := c.GetFavoriteContent(ctx, mediaID, pn, 20)
		if err != nil {
			return nil, err
		}
		all = append(all, page.Medias...)
		if !page.HasMore {
			return all, nil
		}
		pn++
		SleepJitter(ctx, c.cfg.Bili.PageDelayMinMS, c.cfg.Bili.PageDelayMaxMS)
	}
}

// MoveFavoriteResources moves entries between folders (write flow — needs
// bili_jct as csrf).
func (c *Client) MoveFavoriteResources(ctx context.Context, srcMediaID, tarMediaID int64, resources []string) (map[string]any, error) {
	if c.biliJct == "" {
		return nil, fmt.Errorf("缺少 bili_jct，无法进行收藏夹移动")
	}
	if len(resources) == 0 {
		return map[string]any{}, nil
	}
	form := url.Values{
		"src_media_id": {fmtInt(srcMediaID)},
		"tar_media_id": {fmtInt(tarMediaID)},
		"resources":    {strings.Join(resources, ",")},
		"csrf":         {c.biliJct},
	}
	if c.dedeUserID != "" {
		form.Set("mid", c.dedeUserID)
	}
	var data map[string]any
	if err := c.doJSON(ctx, http.MethodPost, apiBase+"/x/v3/fav/resource/move", nil, form, &data, false); err != nil {
		return nil, err
	}
	return data, nil
}

// CleanFavorite cleans invalid entries of a folder (write flow).
func (c *Client) CleanFavorite(ctx context.Context, mediaID int64) (map[string]any, error) {
	if c.biliJct == "" {
		return nil, fmt.Errorf("缺少 bili_jct，无法清理失效内容")
	}
	form := url.Values{"media_id": {fmtInt(mediaID)}, "csrf": {c.biliJct}}
	var data map[string]any
	if err := c.doJSON(ctx, http.MethodPost, apiBase+"/x/v3/fav/resource/clean", nil, form, &data, false); err != nil {
		return nil, err
	}
	return data, nil
}

// GetVideoInfo fetches /x/web-interface/view.
func (c *Client) GetVideoInfo(ctx context.Context, bvid string) (map[string]any, error) {
	q := url.Values{"bvid": {bvid}}
	var data map[string]any
	if err := c.doJSON(ctx, http.MethodGet, apiBase+"/x/web-interface/view", q, nil, &data, false); err != nil {
		return nil, err
	}
	return data, nil
}

// GetVideoSummary fetches the B站-provided AI conclusion (wbi-signed). A
// missing conclusion returns nil — callers fall back to other content.
func (c *Client) GetVideoSummary(ctx context.Context, bvid string, cid int64, upMid int64) (map[string]any, error) {
	q := url.Values{"bvid": {bvid}, "cid": {fmtInt(cid)}}
	if upMid > 0 {
		q.Set("up_mid", fmtInt(upMid))
	}
	var data map[string]any
	err := c.doJSON(ctx, http.MethodGet, apiBase+"/x/web-interface/view/conclusion/get", q, nil, &data, true)
	if err != nil {
		var apiErr *APIError
		if isAPIErr(err, &apiErr) {
			return nil, nil // non-zero code = no conclusion; not fatal
		}
		return nil, err
	}
	return data, nil
}

// GetPlayerInfo fetches player info incl. subtitle list — WBI variant
// first, plain endpoint as fallback (parity with Python).
func (c *Client) GetPlayerInfo(ctx context.Context, bvid string, cid int64, aid int64) map[string]any {
	q := url.Values{"bvid": {bvid}, "cid": {fmtInt(cid)}}
	if aid > 0 {
		q.Set("aid", fmtInt(aid))
	}
	var data map[string]any
	if err := c.doJSON(ctx, http.MethodGet, apiBase+"/x/player/wbi/v2", q, nil, &data, true); err == nil {
		return data
	}
	if err := c.doJSON(ctx, http.MethodGet, apiBase+"/x/player/v2", q, nil, &data, false); err != nil {
		return nil
	}
	return data
}

// AudioChoice picks the playurl audio stream: highest bandwidth ≤64k, else
// the lowest available (parity with the Python selector).
func AudioChoice(dashAudio []map[string]any) map[string]any {
	bw := func(m map[string]any) int64 {
		for _, k := range []string{"bandwidth", "bandWidth"} {
			if v, ok := m[k].(float64); ok && v > 0 {
				return int64(v)
			}
		}
		return 0
	}
	var candidates []map[string]any
	for _, a := range dashAudio {
		if bw(a) > 0 {
			candidates = append(candidates, a)
		}
	}
	const maxBW = int64(64_000)
	var best map[string]any
	if len(candidates) > 0 {
		var preferred []map[string]any
		for _, a := range candidates {
			if bw(a) <= maxBW {
				preferred = append(preferred, a)
			}
		}
		if len(preferred) > 0 {
			best = preferred[0]
			for _, a := range preferred[1:] {
				if bw(a) > bw(best) {
					best = a
				}
			}
		} else {
			best = candidates[0]
			for _, a := range candidates[1:] {
				if bw(a) < bw(best) {
					best = a
				}
			}
		}
	}
	return best
}

// GetAudioURL resolves the audio stream URL for ASR (wbi first, fallback to
// the plain playurl). Returns "" when none.
func (c *Client) GetAudioURL(ctx context.Context, bvid string, cid int64) string {
	q := url.Values{
		"bvid":  {bvid},
		"cid":   {fmtInt(cid)},
		"fnval": {"16"},
		"fnver": {"0"},
		"fourk": {"1"},
	}
	var payload struct {
		Code int `json:"code"`
		Data struct {
			Dash struct {
				Audio []map[string]any `json:"audio"`
			} `json:"dash"`
			DURL []map[string]any `json:"durl"`
		} `json:"data"`
	}
	wbiErr := c.doJSON(ctx, http.MethodGet, apiBase+"/x/player/wbi/playurl", q, nil, &payload, true)
	if wbiErr != nil || payload.Code != 0 {
		payload.Data.Dash.Audio = nil
		payload.Data.DURL = nil
		if err := c.doJSON(ctx, http.MethodGet, apiBase+"/x/player/playurl", q, nil, &payload, false); err != nil {
			return ""
		}
		if payload.Code != 0 {
			return ""
		}
	}
	if best := AudioChoice(payload.Data.Dash.Audio); best != nil {
		for _, k := range []string{"baseUrl", "base_url", "url"} {
			if v, ok := best[k].(string); ok && v != "" {
				return v
			}
		}
	}
	if len(payload.Data.DURL) > 0 {
		if v, ok := payload.Data.DURL[0]["url"].(string); ok {
			return v
		}
	}
	return ""
}

// DownloadSubtitle fetches and joins a subtitle JSON body.
func (c *Client) DownloadSubtitle(ctx context.Context, subtitleURL string) (string, error) {
	if strings.HasPrefix(subtitleURL, "//") {
		subtitleURL = "https:" + subtitleURL
	}
	var payload struct {
		Body []struct {
			Content string `json:"content"`
		} `json:"body"`
	}
	if err := c.doJSON(ctx, http.MethodGet, subtitleURL, nil, nil, &payload, false); err != nil {
		return "", err
	}
	var b strings.Builder
	for i, item := range payload.Body {
		if item.Content != "" {
			if i > 0 {
				b.WriteByte('\n')
			}
			b.WriteString(item.Content)
		}
	}
	return b.String(), nil
}

// DownloadAudioToFile streams the audio URL to disk (200/206 accepted).
func (c *Client) DownloadAudioToFile(ctx context.Context, audioURL, filePath string) (bool, error) {
	if audioURL == "" {
		return false, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, audioURL, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Referer", "https://www.bilibili.com/")
	req.Header.Set("Origin", "https://www.bilibili.com")
	req.AddCookie(&http.Cookie{Name: "SESSDATA", Value: c.sessdata, Domain: ".bilibili.com", Path: "/"})

	resp, err := c.http.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		return false, fmt.Errorf("download audio: HTTP %d", resp.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		return false, err
	}
	f, err := os.Create(filePath)
	if err != nil {
		return false, err
	}
	defer f.Close()
	if _, err := io.Copy(f, resp.Body); err != nil {
		return false, err
	}
	return true, nil
}

// GetUserInfo fetches /x/web-interface/nav data (mid, wbi_img, ...).
func (c *Client) GetUserInfo(ctx context.Context) (map[string]any, error) {
	var payload struct {
		Code int            `json:"code"`
		Data map[string]any `json:"data"`
	}
	if err := c.doJSON(ctx, http.MethodGet, apiBase+"/x/web-interface/nav", nil, nil, &payload, false); err != nil {
		return nil, err
	}
	if payload.Code != 0 {
		return nil, &APIError{Code: payload.Code, Message: "获取用户信息失败"}
	}
	return payload.Data, nil
}

// isAPIErr reports whether err carries a bilibili APIError.
func isAPIErr(err error, target **APIError) bool {
	return errors.As(err, target)
}
