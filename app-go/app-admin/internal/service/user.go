// User read-only service: assembles the admin-plane user list / detail DTOs
// (uid / email / phone / nickname / status / granted roles). NO file or
// storage information is ever attached - admin does not see user content.
//
// Wire DTOs live in internal/dto; this package only maps repo rows into them.
package service

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"app-admin/internal/dto"
	"app-admin/internal/repo"
)

// UserQueryMode — the three exact lookup modes exposed by GET /api/users.
type UserQueryMode string

const (
	UserQueryUID   UserQueryMode = "uid"
	UserQueryPhone UserQueryMode = "phone"
	UserQueryEmail UserQueryMode = "email"
)

var (
	// UID: positive integer, no leading zero. UIDs are bigint (≤19 digits).
	userUIDPattern = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)
	// Mainland China mobile: exactly 11 digits, 1[3-9] prefix (+86 number
	// without the country code).
	userPhonePattern = regexp.MustCompile(`^1[3-9][0-9]{9}$`)
	userEmailPattern = regexp.MustCompile(`^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$`)
)

// inferUserQueryMode applies the same precedence as the console:
// email (contains @) → 11-digit phone → positive integer uid.
func inferUserQueryMode(value string) UserQueryMode {
	if strings.Contains(value, "@") {
		return UserQueryEmail
	}
	if userPhonePattern.MatchString(value) {
		return UserQueryPhone
	}
	if userUIDPattern.MatchString(value) {
		return UserQueryUID
	}
	return ""
}

func userQueryModeLabel(mode UserQueryMode) string {
	switch mode {
	case UserQueryUID:
		return "UID"
	case UserQueryPhone:
		return "手机号"
	case UserQueryEmail:
		return "邮箱"
	default:
		return "未知"
	}
}

// normalizeUserQuery validates an explicit mode against the value AND infers
// the mode when the client omitted it. A mismatch is a 400: the console and
// the API must agree on what is being looked up (defense in depth).
func normalizeUserQuery(rawValue, rawMode string) (repo.UserQuery, UserQueryMode, error) {
	value := strings.TrimSpace(rawValue)
	mode := strings.ToLower(strings.TrimSpace(rawMode))
	if value == "" {
		if mode != "" {
			return repo.UserQuery{}, "", errors.New("查询内容 q 不能为空")
		}
		return repo.UserQuery{}, "", nil
	}
	switch UserQueryMode(mode) {
	case "", UserQueryUID, UserQueryPhone, UserQueryEmail:
	default:
		return repo.UserQuery{}, "", errors.New("查询方式无效，仅支持 uid / phone / email")
	}

	inferred := inferUserQueryMode(value)
	if mode == "" {
		if inferred == "" {
			return repo.UserQuery{}, "", errors.New("请输入 UID、11 位手机号或邮箱")
		}
		mode = string(inferred)
	}

	// Validate the chosen mode's exact format before the match check, so a
	// malformed phone/email gets a precise message instead of a generic one.
	switch UserQueryMode(mode) {
	case UserQueryUID:
		if !userUIDPattern.MatchString(value) {
			return repo.UserQuery{}, "", errors.New("UID 必须为正整数")
		}
		if _, err := strconv.ParseInt(value, 10, 64); err != nil {
			return repo.UserQuery{}, "", errors.New("UID 超出范围")
		}
	case UserQueryPhone:
		if !userPhonePattern.MatchString(value) {
			return repo.UserQuery{}, "", errors.New("手机号必须为 11 位中国大陆手机号（1[3-9] 开头）")
		}
	case UserQueryEmail:
		if !userEmailPattern.MatchString(value) {
			return repo.UserQuery{}, "", errors.New("邮箱格式不合法")
		}
	}
	if inferred != UserQueryMode(mode) {
		return repo.UserQuery{}, "", fmt.Errorf("查询方式与内容不匹配：输入被识别为%s", userQueryModeLabel(inferred))
	}
	return repo.UserQuery{Mode: mode, Value: value}, UserQueryMode(mode), nil
}

// UserService is stateless; wires repo reads into DTOs.
type UserService struct{}

func NewUserService() *UserService { return &UserService{} }

// List returns one user page. q is one exact UID / 11-digit phone / email;
// mode is optional (uid|phone|email) but validated against q when present.
func (s *UserService) List(q, mode string, page, pageSize int) (*dto.UserPage, error) {
	if err := validatePage(page, pageSize); err != nil {
		return nil, err
	}
	query, resolvedMode, err := normalizeUserQuery(q, mode)
	if err != nil {
		return nil, err
	}
	limit, offset := pageWindow(page, pageSize)
	accounts, total, err := repo.ListUsers(query, limit, offset)
	if err != nil {
		return nil, err
	}

	uids := make([]int64, 0, len(accounts))
	for _, a := range accounts {
		uids = append(uids, a.UID)
	}
	rolesByUid, err := repo.ActiveRolesByUids(uids)
	if err != nil {
		return nil, err
	}

	items := make([]dto.UserItem, 0, len(accounts))
	for _, a := range accounts {
		names := make([]string, 0, len(rolesByUid[a.UID]))
		for _, r := range rolesByUid[a.UID] {
			names = append(names, r.RoleName)
		}
		items = append(items, dto.UserItem{
			UID:       a.UID,
			Email:     safeStr(a.Email),
			Phone:     safeStr(a.Phone),
			Nickname:  safeStr(a.Nickname),
			Status:    safeStr(a.Status),
			Roles:     names,
			CreatedAt: rfc3339(a.CreatedAt),
		})
	}
	return &dto.UserPage{
		Items:     items,
		Total:     total,
		Page:      page,
		PageSize:  pageSize,
		QueryMode: string(resolvedMode),
	}, nil
}

// Detail resolves one user; (nil, nil) = uid unknown.
func (s *UserService) Detail(uid int64) (*dto.UserDetail, error) {
	if uid <= 0 {
		return nil, fmt.Errorf("uid must be a positive integer")
	}
	account, err := repo.GetUser(uid)
	if err != nil {
		return nil, err
	}
	if account == nil {
		return nil, nil
	}
	bindings, err := repo.GetUserRoleBindings(uid)
	if err != nil {
		return nil, err
	}
	detail := &dto.UserDetail{
		UID:       account.UID,
		Email:     safeStr(account.Email),
		Phone:     safeStr(account.Phone),
		Nickname:  safeStr(account.Nickname),
		Status:    safeStr(account.Status),
		CreatedAt: rfc3339(account.CreatedAt),
		Roles:     make([]dto.RoleDetail, 0, len(bindings)),
	}
	for _, b := range bindings {
		detail.Roles = append(detail.Roles, dto.RoleDetail{
			RoleID:   b.RoleID,
			Name:     b.RoleName,
			Granted:  rfc3339(b.GrantedAt),
			Expires:  rfc3339(b.ExpiresAt),
			IsActive: isActive(b.IsActive, b.ExpiresAt),
		})
	}
	return detail, nil
}
