-- V10: three-tier membership pricing (VIP 48 / SVIP 148 / ProMax 248).
-- Existing orders keep their paid snapshots; only active SKU catalog prices change.
-- Annual/quarterly prices keep the historical ~28% / ~16.7% discounts.

UPDATE pay_product SET price_cents = 4800,  sort = 10, tier = 'VIP',    status = 'ACTIVE', updated_at = NOW(6) WHERE code = 'VIP_MONTHLY';
UPDATE pay_product SET price_cents = 12000, sort = 20, tier = 'VIP',    status = 'ACTIVE', updated_at = NOW(6) WHERE code = 'VIP_QUARTERLY';
UPDATE pay_product SET price_cents = 42000, sort = 30, tier = 'VIP',    status = 'ACTIVE', updated_at = NOW(6) WHERE code = 'VIP_YEARLY';

UPDATE pay_product SET price_cents = 14800, sort = 40, tier = 'SVIP',   status = 'ACTIVE', updated_at = NOW(6) WHERE code = 'SVIP_MONTHLY';
UPDATE pay_product SET price_cents = 37000, sort = 50, tier = 'SVIP',   status = 'ACTIVE', updated_at = NOW(6) WHERE code = 'SVIP_QUARTERLY';
UPDATE pay_product SET price_cents = 129800, sort = 60, tier = 'SVIP',  status = 'ACTIVE', updated_at = NOW(6) WHERE code = 'SVIP_YEARLY';

INSERT INTO pay_product (code, title, duration_days, price_cents, sort, tier, status, created_at, updated_at)
VALUES
  ('PROMAX_MONTHLY',   'ProMax Membership · Monthly',   30,  24800, 70, 'PROMAX', 'ACTIVE', NOW(6), NOW(6)),
  ('PROMAX_QUARTERLY', 'ProMax Membership · Quarterly', 90,  62000, 80, 'PROMAX', 'ACTIVE', NOW(6), NOW(6)),
  ('PROMAX_YEARLY',    'ProMax Membership · Yearly',    365, 217800, 90, 'PROMAX', 'ACTIVE', NOW(6), NOW(6))
ON DUPLICATE KEY UPDATE
  title = VALUES(title),
  duration_days = VALUES(duration_days),
  price_cents = VALUES(price_cents),
  sort = VALUES(sort),
  tier = VALUES(tier),
  status = VALUES(status),
  updated_at = NOW(6);
