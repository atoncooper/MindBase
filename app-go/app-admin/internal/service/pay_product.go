// Pay product service: the authoritative SKU catalog write path (admin console).
//
// Ownership split (documented in docs/app-admin.md / docs/app-pay.md):
//   - schema + one-shot seed: app-pay (Flyway V1 table, V11 INSERT IGNORE seed);
//   - console CRUD: THIS service (create / update / disable / delete);
//   - catalog reads for checkout: app-pay ProductService (5s active-SKU cache),
//     so a console edit becomes visible within that TTL — no app-pay endpoint.
//
// Safety rules enforced here (the router only parses HTTP):
//   - code is an uppercase slug (A-Z 0-9 _), <= 50 chars, unique, IMMUTABLE
//     after creation (pay_order keeps sku_code as a historical snapshot);
//   - title non-empty <= 100 runes; durationDays 1..3650; priceCents > 0;
//     tier in VIP|SVIP|PROMAX (app-pay's canonical set); status ACTIVE|DISABLED;
//     sort >= 0;
//   - the catalog can never drop to zero ACTIVE SKUs (order creation needs one);
//   - DELETE hard-deletes only unreferenced rows, otherwise it marks the row
//     DISABLED so pay_order history stays resolvable.
//
// Audit: every write appends an admin_audit row (action=pay_product_*,
// targetType=pay_product, targetID=code, detail carries the before/after
// summary) and one JSONL fund-adjacent line (PRODUCT_CREATED/UPDATED/DISABLED/
// DELETED). admin_audit lives in the MAIN DB while pay_product lives in
// app_pay, so the cross-connection ledger write is best effort with a loud log
// (same posture as the membership grant).
package service

import (
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"app-admin/internal/dto"
	"app-admin/internal/model"
	"app-admin/internal/repo"
)

const (
	productStatusActive   = "ACTIVE"
	productStatusDisabled = "DISABLED"

	productCodeMaxLen      = 50
	productTitleMaxRunes   = 100
	productDurationMinDays = 1
	productDurationMaxDays = 3650
	productSortMax         = 1_000_000
)

// productCodePattern is the uppercase slug contract (matches the seeded codes
// such as VIP_MONTHLY); lowercase codes are rejected rather than upper-cased so
// the admin sees exactly what was typed.
var productCodePattern = regexp.MustCompile(`^[A-Z0-9][A-Z0-9_]{0,49}$`)

// PayProductError is a business-rule failure carrying the HTTP status the
// router must answer (400 validation, 404 unknown row, 409 conflict/in-use).
type PayProductError struct {
	Status int
	Msg    string
}

func (e *PayProductError) Error() string { return e.Msg }

func productBadRequest(msg string) *PayProductError {
	return &PayProductError{Status: 400, Msg: msg}
}

func productNotFound(msg string) *PayProductError {
	return &PayProductError{Status: 404, Msg: msg}
}

func productConflict(msg string) *PayProductError {
	return &PayProductError{Status: 409, Msg: msg}
}

// PayProductService performs the console SKU catalog writes. Stateless except
// for the optional JSONL sink.
type PayProductService struct {
	audit *PayAudit
}

// NewPayProductService wires the fund-audit JSONL sink (nil = tests / disabled
// pay module; admin_audit is still written).
func NewPayProductService(audit *PayAudit) *PayProductService {
	return &PayProductService{audit: audit}
}

// Create inserts a new SKU (409 when the code is taken).
func (s *PayProductService) Create(operator string, req dto.PayProductWriteRequest) (*dto.PayProductItem, error) {
	norm, err := normalizeProductWrite(req, "")
	if err != nil {
		return nil, err
	}
	existing, err := repo.GetProductByCode(norm.Code)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, productConflict("商品编码已存在：" + norm.Code)
	}
	now := time.Now()
	p := &model.PayProduct{
		Code:         norm.Code,
		Title:        norm.Title,
		DurationDays: norm.DurationDays,
		PriceCents:   norm.PriceCents,
		Tier:         norm.Tier,
		Status:       norm.Status,
		Sort:         norm.Sort,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := repo.CreateProduct(p); err != nil {
		if repo.IsDuplicateKey(err) {
			return nil, productConflict("商品编码已存在：" + norm.Code)
		}
		return nil, err
	}
	s.recordAudit(operator, "pay_product_create", nil, p)
	s.logEvent("PRODUCT_CREATED", operator, p, "price_cents", p.PriceCents, "tier", p.Tier)
	item := payProductItem(p)
	return &item, nil
}

// Update rewrites one SKU (code is immutable; disabling the last ACTIVE SKU is
// refused with 409).
func (s *PayProductService) Update(operator string, id int64, req dto.PayProductWriteRequest) (*dto.PayProductItem, error) {
	existing, err := repo.GetProductByID(id)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, productNotFound("商品不存在")
	}
	if strings.TrimSpace(req.Code) != existing.Code {
		return nil, productBadRequest("商品编码创建后不可修改（如需新编码请新建商品）")
	}
	norm, err := normalizeProductWrite(req, existing.Status)
	if err != nil {
		return nil, err
	}
	if existing.Status == productStatusActive && norm.Status == productStatusDisabled {
		if err := ensureNotLastActive(); err != nil {
			return nil, err
		}
	}
	before := *existing
	existing.Title = norm.Title
	existing.DurationDays = norm.DurationDays
	existing.PriceCents = norm.PriceCents
	existing.Tier = norm.Tier
	existing.Status = norm.Status
	existing.Sort = norm.Sort
	existing.UpdatedAt = time.Now()
	if err := repo.UpdateProduct(existing); err != nil {
		return nil, err
	}
	s.recordAudit(operator, "pay_product_update", &before, existing)
	s.logEvent("PRODUCT_UPDATED", operator, existing, "price_cents", existing.PriceCents, "tier", existing.Tier)
	item := payProductItem(existing)
	return &item, nil
}

// Delete hard-deletes an unreferenced SKU. When pay_order references the code
// (or the row is the last ACTIVE SKU), the row is kept as history and marked
// DISABLED instead; Result reports which branch ran.
func (s *PayProductService) Delete(operator string, id int64) (*dto.PayProductDeleteResult, error) {
	existing, err := repo.GetProductByID(id)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, productNotFound("商品不存在")
	}
	orders, err := repo.CountOrdersBySkuCode(existing.Code)
	if err != nil {
		return nil, err
	}

	if orders > 0 {
		// Referenced SKU: never destroy the row pay_order history points at.
		if existing.Status == productStatusActive {
			if err := ensureNotLastActive(); err != nil {
				return nil, err
			}
			before := *existing
			existing.Status = productStatusDisabled
			existing.UpdatedAt = time.Now()
			if err := repo.UpdateProduct(existing); err != nil {
				return nil, err
			}
			s.recordAudit(operator, "pay_product_disable", &before, existing)
			s.logEvent("PRODUCT_DISABLED", operator, existing,
				"reason", fmt.Sprintf("referenced_by_orders=%d", orders))
		}
		item := payProductItem(existing)
		return &dto.PayProductDeleteResult{Result: "disabled", Product: &item}, nil
	}

	if existing.Status == productStatusActive {
		if err := ensureNotLastActive(); err != nil {
			return nil, err
		}
	}
	before := *existing
	if _, err := repo.DeleteProduct(id); err != nil {
		return nil, err
	}
	s.recordAudit(operator, "pay_product_delete", &before, nil)
	s.logEvent("PRODUCT_DELETED", operator, &before)
	return &dto.PayProductDeleteResult{Result: "deleted"}, nil
}

// ensureNotLastActive keeps at least one purchasable SKU in the catalog.
func ensureNotLastActive() error {
	n, err := repo.CountProductsByStatus(productStatusActive)
	if err != nil {
		return err
	}
	if n <= 1 {
		return productConflict("不能移除最后一个在售商品，请先新增其他在售商品")
	}
	return nil
}

// normalizeProductWrite trims + validates the wire request and returns a clean
// copy. currentStatus is the row's existing status on update (empty status in
// the body keeps it); on create an empty status defaults to ACTIVE.
func normalizeProductWrite(req dto.PayProductWriteRequest, currentStatus string) (dto.PayProductWriteRequest, error) {
	out := req
	out.Code = strings.TrimSpace(req.Code)
	out.Title = strings.TrimSpace(req.Title)
	out.Tier = strings.ToUpper(strings.TrimSpace(req.Tier))
	out.Status = strings.ToUpper(strings.TrimSpace(req.Status))

	if out.Code == "" {
		return out, productBadRequest("商品编码不能为空")
	}
	if len(out.Code) > productCodeMaxLen || !productCodePattern.MatchString(out.Code) {
		return out, productBadRequest("商品编码只能包含大写字母/数字/下划线，且不超过 50 字符")
	}
	if out.Title == "" {
		return out, productBadRequest("商品名称不能为空")
	}
	if utf8.RuneCountInString(out.Title) > productTitleMaxRunes {
		return out, productBadRequest("商品名称不能超过 100 字")
	}
	if out.DurationDays < productDurationMinDays || out.DurationDays > productDurationMaxDays {
		return out, productBadRequest("有效天数必须在 1..3650 之间")
	}
	if out.PriceCents <= 0 {
		return out, productBadRequest("商品价格必须大于 0（单位：分）")
	}
	switch out.Tier {
	case "VIP", "SVIP", "PROMAX":
	default:
		return out, productBadRequest("档位必须是 VIP、SVIP 或 PROMAX")
	}
	if out.Status == "" {
		if currentStatus != "" {
			out.Status = currentStatus
		} else {
			out.Status = productStatusActive
		}
	}
	if out.Status != productStatusActive && out.Status != productStatusDisabled {
		return out, productBadRequest("状态必须是 ACTIVE 或 DISABLED")
	}
	if out.Sort < 0 {
		return out, productBadRequest("排序值不能为负数")
	}
	if out.Sort > productSortMax {
		return out, productBadRequest("排序值不能超过 1000000")
	}
	return out, nil
}

// payProductItem maps a row onto the wire DTO (catalog reads share it).
func payProductItem(p *model.PayProduct) dto.PayProductItem {
	return dto.PayProductItem{
		ID:           p.ID,
		Code:         p.Code,
		Title:        p.Title,
		DurationDays: p.DurationDays,
		PriceCents:   p.PriceCents,
		Tier:         p.Tier,
		Status:       p.Status,
		Sort:         p.Sort,
		CreatedAt:    rfc3339Time(p.CreatedAt),
		UpdatedAt:    rfc3339Time(p.UpdatedAt),
	}
}

// recordAudit appends the console ledger row (before/after summary). The
// pay_product write is already committed and lives in the other database, so a
// ledger failure is logged loudly instead of failing the request.
func (s *PayProductService) recordAudit(operator, action string, before, after *model.PayProduct) {
	if operator == "" {
		operator = "system"
	}
	code := ""
	if after != nil {
		code = after.Code
	} else if before != nil {
		code = before.Code
	}
	detail := "before=" + productSnapshot(before) + " after=" + productSnapshot(after)
	if err := repo.RecordAudit(operator, action, "pay_product", code, detail); err != nil {
		slog.Error("[PAY_PRODUCT] admin_audit write failed after catalog write",
			"operator", operator, "action", action, "code", code, "err", err)
	}
}

// logEvent appends one JSONL fund-adjacent line when the sink is wired.
func (s *PayProductService) logEvent(event, operator string, p *model.PayProduct, kv ...any) {
	if s.audit == nil {
		return
	}
	fields := []any{
		"operator", operator,
		"code", p.Code,
		"title", p.Title,
		"duration_days", p.DurationDays,
		"price_cents", p.PriceCents,
		"tier", p.Tier,
		"status", p.Status,
		"sort", p.Sort,
	}
	fields = append(fields, kv...)
	fields = append(fields, "source", "app-admin")
	s.audit.Log(event, fields...)
}

// productSnapshot renders one row for the audit detail ("-" = no row, e.g. a
// create's before or a delete's after).
func productSnapshot(p *model.PayProduct) string {
	if p == nil {
		return "-"
	}
	return fmt.Sprintf("{code=%s,title=%s,durationDays=%d,priceCents=%d,tier=%s,status=%s,sort=%d}",
		p.Code, p.Title, p.DurationDays, p.PriceCents, p.Tier, p.Status, p.Sort)
}
