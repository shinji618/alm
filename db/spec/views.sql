-- Views ------------------------------------------------------------------

-- 최신 SAP 금액(상각영역 01): 자산별 마지막 회계연도·기간 1행
CREATE VIEW v_asset_value_latest WITH (security_invoker = true) AS
SELECT DISTINCT ON (v.asset_id)
       v.tenant_id, v.asset_id, v.fiscal_year, v.period,
       v.acquisition_value, v.accum_depreciation, v.net_book_value,
       v.useful_life_years, v.useful_life_periods
  FROM asset_value v
 WHERE v.dep_area = '01'
 ORDER BY v.asset_id, v.fiscal_year DESC, v.period DESC;

-- 라이프사이클 단계: 상태 + 내용연수 경과로 계산(저장하지 않음)
CREATE VIEW v_asset_stage WITH (security_invoker = true) AS
SELECT a.tenant_id, a.id AS asset_id, a.status,
       coalesce(a.sap_cap_date, a.purchase_date)
         + make_interval(years => coalesce(vl.useful_life_years, c.useful_life_years, ac.default_useful_life_years, 0)) AS useful_life_end,
       CASE
         WHEN a.status = 'ON_ORDER' AND a.po_item_id IS NULL THEN 'PLAN'
         WHEN a.status = 'ON_ORDER' THEN 'PROCURE'
         WHEN a.status = 'IN_STOCK' THEN 'DEPLOY'
         WHEN a.status = 'IN_REPAIR' THEN 'MAINTAIN'
         WHEN a.status IN ('RETIRED', 'DISPOSED') THEN 'RETIRE'
         WHEN a.status = 'IN_USE'
              AND coalesce(vl.useful_life_years, c.useful_life_years, ac.default_useful_life_years) IS NOT NULL
              AND coalesce(a.sap_cap_date, a.purchase_date)
                  + make_interval(years => coalesce(vl.useful_life_years, c.useful_life_years, ac.default_useful_life_years)) < current_date
           THEN 'MAINTAIN'
         ELSE 'OPERATE'
       END AS stage
  FROM asset a
  JOIN category c ON c.id = a.category_id
  LEFT JOIN asset_class ac ON ac.id = a.asset_class_id
  LEFT JOIN v_asset_value_latest vl ON vl.asset_id = a.id;

-- 라이선스 준수: 사용 > 보유 = UNDER, 사용 < 보유 × 기준(기본 0.8) = OVER
CREATE VIEW v_license_compliance WITH (security_invoker = true) AS
WITH used AS (
  SELECT l.id AS license_id,
         CASE WHEN l.license_model = 'PER_USER'
              THEN (SELECT count(*) FROM license_assignment la WHERE la.license_id = l.id AND la.released_at IS NULL)
              ELSE (SELECT count(DISTINCT si.asset_id) FROM software_install si
                     WHERE si.product_id = l.product_id AND si.tenant_id = l.tenant_id AND NOT si.is_removed)
         END AS used_quantity
    FROM license l
)
SELECT l.tenant_id, l.id AS license_id, l.product_id, l.license_model, l.owned_quantity, u.used_quantity,
       l.unit_cost,
       greatest(l.owned_quantity - u.used_quantity, 0) * coalesce(l.unit_cost, 0) AS unused_amount,
       greatest(u.used_quantity - l.owned_quantity, 0) * coalesce(l.unit_cost, 0) AS shortfall_amount,
       CASE WHEN u.used_quantity > l.owned_quantity THEN 'UNDER'
            WHEN u.used_quantity < l.owned_quantity * coalesce(
                   (SELECT (s.value #>> '{}')::numeric FROM setting s
                     WHERE s.tenant_id = l.tenant_id AND s.key = 'license.over_threshold'), 0.8) THEN 'OVER'
            ELSE 'COMPLIANT' END AS compliance
  FROM license l JOIN used u ON u.license_id = l.id;
