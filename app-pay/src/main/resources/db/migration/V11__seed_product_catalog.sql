-- V11: seed the authoritative SKU catalog.
--
-- pay_product is the authoritative catalog. app-pay no longer hardcodes SKUs at
-- startup (ProductService used to insert its DEFAULT_SKUS list on every boot);
-- the seed now happens exactly once as part of the migration chain, and console
-- CRUD in app-admin owns every later change.
--
-- INSERT IGNORE (deliberately NOT ON DUPLICATE KEY UPDATE):
--   * re-runs / fresh installs are safe (idempotent);
--   * an existing row edited by an operator is never overwritten by a deploy.
-- V10 already inserted the three PROMAX rows on existing databases and those
-- rows are identical, so they are skipped here as well.
INSERT IGNORE INTO pay_product (code, title, duration_days, price_cents, sort, tier, status, created_at, updated_at)
VALUES
  ('VIP_MONTHLY',     'Membership · Monthly',             30,   4800, 10, 'VIP',    'ACTIVE', NOW(6), NOW(6)),
  ('VIP_QUARTERLY',   'Membership · Quarterly',           90,  12000, 20, 'VIP',    'ACTIVE', NOW(6), NOW(6)),
  ('VIP_YEARLY',      'Membership · Yearly',             365,  42000, 30, 'VIP',    'ACTIVE', NOW(6), NOW(6)),
  ('SVIP_MONTHLY',    'Super Membership · Monthly',       30,  14800, 40, 'SVIP',   'ACTIVE', NOW(6), NOW(6)),
  ('SVIP_QUARTERLY',  'Super Membership · Quarterly',     90,  37000, 50, 'SVIP',   'ACTIVE', NOW(6), NOW(6)),
  ('SVIP_YEARLY',     'Super Membership · Yearly',       365, 129800, 60, 'SVIP',   'ACTIVE', NOW(6), NOW(6)),
  ('PROMAX_MONTHLY',  'ProMax Membership · Monthly',      30,  24800, 70, 'PROMAX', 'ACTIVE', NOW(6), NOW(6)),
  ('PROMAX_QUARTERLY','ProMax Membership · Quarterly',    90,  62000, 80, 'PROMAX', 'ACTIVE', NOW(6), NOW(6)),
  ('PROMAX_YEARLY',   'ProMax Membership · Yearly',      365, 217800, 90, 'PROMAX', 'ACTIVE', NOW(6), NOW(6));
