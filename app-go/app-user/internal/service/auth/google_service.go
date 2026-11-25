package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"app-user/internal/config"
	"app-user/internal/utils"

	"github.com/redis/go-redis/v9"
)

// GoogleService — Google OAuth 2.0 / OpenID Connect authorization-code flow.
// State is one-time and Redis-backed (fail-closed).
type GoogleService struct {
	cfg *config.AuthConfig
	rdb redis.UniversalClient
}

const (
	GoogleStateLogin = "login"
	GoogleStateBind  = "bind"
	googleStateTTL   = 600 * time.Second
	googleStateNS    = "mind-base:auth:google:state:"
)

func NewGoogleService(cfg *config.AuthConfig, rdb redis.UniversalClient) *GoogleService {
	return &GoogleService{cfg: cfg, rdb: rdb}
}

func (s *GoogleService) Enabled() bool {
	return s != nil && s.cfg.Google.Enabled &&
		s.cfg.Google.ClientID != "" &&
		s.cfg.Google.ClientSecret != "" &&
		s.cfg.Google.RedirectURI != ""
}

func (s *GoogleService) IssueState(ctx context.Context, purpose string) (string, error) {
	state, err := utils.RandomToken(24)
	if err != nil {
		return "", err
	}
	return state, s.rdb.Set(ctx, googleStateNS+state, purpose, googleStateTTL).Err()
}

func (s *GoogleService) ConsumeState(ctx context.Context, state, purpose string) bool {
	if state == "" {
		return false
	}
	key := googleStateNS + state
	stored, err := s.rdb.Get(ctx, key).Result()
	if err != nil || stored != purpose {
		return false
	}
	n, err := s.rdb.Del(ctx, key).Result()
	return err == nil && n > 0
}

func (s *GoogleService) AuthorizeURL(ctx context.Context, purpose string) (string, string, error) {
	if !s.Enabled() {
		return "", "", fmt.Errorf("Google 登录未启用")
	}
	state, err := s.IssueState(ctx, purpose)
	if err != nil {
		return "", "", fmt.Errorf("Google 登录状态创建失败")
	}
	q := url.Values{
		"client_id":              {s.cfg.Google.ClientID},
		"redirect_uri":           {s.cfg.Google.RedirectURI},
		"response_type":          {"code"},
		"scope":                  {"openid email profile"},
		"state":                  {state},
		"access_type":            {"offline"},
		"include_granted_scopes": {"true"},
		"prompt":                 {"select_account"},
	}
	return "https://accounts.google.com/o/oauth2/v2/auth?" + q.Encode(), state, nil
}

type GoogleToken struct {
	AccessToken  string `json:"access_token"`
	ExpiresIn    int64  `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	TokenType    string `json:"token_type"`
	Scope        string `json:"scope"`
	Error        string `json:"error"`
	ErrorDesc    string `json:"error_description"`
}

func (s *GoogleService) ExchangeCode(ctx context.Context, code string) (*GoogleToken, error) {
	if !s.Enabled() {
		return nil, fmt.Errorf("Google 登录未启用")
	}
	form := url.Values{
		"code":          {code},
		"client_id":     {s.cfg.Google.ClientID},
		"client_secret": {s.cfg.Google.ClientSecret},
		"redirect_uri":  {s.cfg.Google.RedirectURI},
		"grant_type":    {"authorization_code"},
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://oauth2.googleapis.com/token", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := sharedHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Google 登录服务暂不可用")
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("Google 登录响应读取失败")
	}
	var token GoogleToken
	if err := json.Unmarshal(body, &token); err != nil {
		return nil, fmt.Errorf("Google 登录响应解析失败")
	}
	if token.Error != "" || token.AccessToken == "" {
		return nil, fmt.Errorf("Google 登录失败，请重试")
	}
	return &token, nil
}

type GoogleProfile struct {
	Sub           string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
	Picture       string `json:"picture"`
}

func (s *GoogleService) GetUserInfo(ctx context.Context, accessToken string) (*GoogleProfile, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://openidconnect.googleapis.com/v1/userinfo", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := sharedHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("获取 Google 用户信息失败")
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("获取 Google 用户信息失败")
	}
	var profile GoogleProfile
	if err := json.Unmarshal(body, &profile); err != nil || profile.Sub == "" {
		return nil, fmt.Errorf("Google 用户信息不完整")
	}
	return &profile, nil
}
