package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"app-auth/internal/config"

	"github.com/redis/go-redis/v9"
)

// WeChatService — Open Platform website-app OAuth (snsapi_login): the
// frontend renders WeChat's embedded QR; this service issues/consumes the
// one-time state (Redis, fail-closed) and exchanges the code for openid.
type WeChatService struct {
	cfg *config.Config
	rdb redis.UniversalClient
}

const (
	WeChatStateLogin = "login"
	WeChatStateBind  = "bind"
	wechatStateTTL   = 600 * time.Second
	wechatStateNS    = "mind-base:auth:wechat:state:"
)

func NewWeChatService(cfg *config.Config, rdb redis.UniversalClient) *WeChatService {
	return &WeChatService{cfg: cfg, rdb: rdb}
}

// IssueState creates a one-time OAuth state bound to a purpose.
func (s *WeChatService) IssueState(ctx context.Context, purpose string) (string, error) {
	state, err := randomToken(24)
	if err != nil {
		return "", err
	}
	return state, s.rdb.Set(ctx, wechatStateNS+state, purpose, wechatStateTTL).Err()
}

// ConsumeState atomically verifies + burns a state. Fail-closed on Redis
// errors (login cannot complete securely without state verification).
func (s *WeChatService) ConsumeState(ctx context.Context, state, purpose string) bool {
	if state == "" {
		return false
	}
	key := wechatStateNS + state
	stored, err := s.rdb.Get(ctx, key).Result()
	if err != nil || stored != purpose {
		return false
	}
	n, err := s.rdb.Del(ctx, key).Result()
	return err == nil && n > 0
}

// WeChatToken is the access_token exchange payload subset.
type WeChatToken struct {
	AccessToken  string `json:"access_token"`
	ExpiresIn    int64  `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
	OpenID       string `json:"openid"`
	UnionID      string `json:"unionid"`
	ErrCode      int64  `json:"errcode"`
	ErrMsg       string `json:"errmsg"`
}

// ExchangeCode swaps the one-time authorization code for token + openid.
func (s *WeChatService) ExchangeCode(ctx context.Context, code string) (*WeChatToken, error) {
	q := url.Values{
		"appid":      {s.cfg.WeChat.AppID},
		"secret":     {s.cfg.WeChat.AppSecret},
		"code":       {code},
		"grant_type": {"authorization_code"},
	}
	resp, err := httpGetJSON(ctx, "https://api.weixin.qq.com/sns/oauth2/access_token?"+q.Encode(), 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("微信登录服务暂不可用，请稍后重试")
	}
	tok := &WeChatToken{}
	if err := json.Unmarshal(resp, tok); err != nil {
		return nil, fmt.Errorf("微信登录失败，请重试")
	}
	if tok.ErrCode != 0 {
		return nil, fmt.Errorf("微信接口返回错误（errcode=%d）", tok.ErrCode)
	}
	return tok, nil
}

// WeChatProfile is the best-effort userinfo payload.
type WeChatProfile struct {
	Nickname   string `json:"nickname"`
	HeadImgURL string `json:"headimgurl"`
	ErrCode    int64  `json:"errcode"`
	ErrMsg     string `json:"errmsg"`
}

// GetUserProfile fetches nickname/headimgurl (best-effort in callers).
func (s *WeChatService) GetUserProfile(ctx context.Context, accessToken, openid string) (*WeChatProfile, error) {
	q := url.Values{"access_token": {accessToken}, "openid": {openid}, "lang": {"zh_CN"}}
	resp, err := httpGetJSON(ctx, "https://api.weixin.qq.com/sns/userinfo?"+q.Encode(), 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("获取微信用户信息失败")
	}
	p := &WeChatProfile{}
	if err := json.Unmarshal(resp, p); err != nil {
		return nil, fmt.Errorf("获取微信用户信息失败")
	}
	if p.ErrCode != 0 {
		return nil, fmt.Errorf("微信接口返回错误（errcode=%d）", p.ErrCode)
	}
	return p, nil
}

// httpGetJSON is a small shared GET→[]byte helper with a timeout.
func httpGetJSON(ctx context.Context, endpoint string, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("http status=%d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 1<<20))
}
