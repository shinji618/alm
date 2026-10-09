-- WBS 2.8 보안 시험(로컬 PostgreSQL 16, 슈퍼유저로 실행): psql -d <db> -f test_security.sql
\set ON_ERROR_STOP 0
DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tester') THEN CREATE ROLE tester LOGIN IN ROLE alm_app; END IF; END$$;
INSERT INTO tenant(id, code, name, idp_type, idp_provider_name) VALUES
 ('00000000-0000-0000-0000-00000000000a','ACME','Acme','SAML','T-ACME'),
 ('00000000-0000-0000-0000-00000000000b','BETA','Beta','OIDC','T-BETA');
\echo '--- 0. bad provider name (underscore) rejected'
INSERT INTO tenant(id, code, name, idp_provider_name) VALUES (gen_random_uuid(),'X','x','T_X');
INSERT INTO tenant_domain(id, tenant_id, domain) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-00000000000a','acme.com');
\echo '--- 0b. duplicate domain rejected'
INSERT INTO tenant_domain(id, tenant_id, domain) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-00000000000b','acme.com');
SET SESSION AUTHORIZATION tester;
\echo '--- 1. pre-auth lookups'
SELECT auth_idp_by_domain('ACME.com') AS idp;
SELECT * FROM auth_tenant_by_username('T-ACME_9f1c-oid');
SELECT count(*) AS other_tenants_visible FROM tenant;
\echo '--- 2. write without actor_type -> rejected'
BEGIN; SET LOCAL app.tenant_id='00000000-0000-0000-0000-00000000000a';
INSERT INTO company(id, tenant_id, company_code, name) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-00000000000a','9000','x');
ROLLBACK;
\echo '--- 3. bad correlation id does not break write; tenant row visible only own'
BEGIN; SET LOCAL app.tenant_id='00000000-0000-0000-0000-00000000000a'; SET LOCAL app.actor_type='USER';
SET LOCAL app.user_id='11111111-1111-1111-1111-111111111111'; SET LOCAL app.correlation_id='not-a-uuid'; SET LOCAL app.client_ip='1.2.3.4, 5.6.7.8';
INSERT INTO company(id, tenant_id, company_code, name) VALUES ('33333333-3333-3333-3333-333333333333','00000000-0000-0000-0000-00000000000a','1000','Acme US');
SELECT action, table_name, correlation_id, ip_address, db_user, tx_id > 0 AS has_tx FROM audit_log WHERE table_name='company';
SELECT code FROM tenant;
\echo '--- 4. user_role duplicate with NULL scope rejected'
INSERT INTO app_user(id, tenant_id, email, display_name) VALUES ('55555555-5555-5555-5555-555555555555','00000000-0000-0000-0000-00000000000a','a@acme.com','A');
INSERT INTO user_role(id, tenant_id, user_id, role) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-00000000000a','55555555-5555-5555-5555-555555555555','ASSET_MANAGER');
SAVEPOINT s; INSERT INTO user_role(id, tenant_id, user_id, role) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-00000000000a','55555555-5555-5555-5555-555555555555','ASSET_MANAGER'); ROLLBACK TO s;
\echo '--- 5. append-only log table'
SAVEPOINT s; UPDATE asset_event SET reason = reason; ROLLBACK TO s;
SAVEPOINT s; DELETE FROM count_scan; ROLLBACK TO s;
SAVEPOINT s; DELETE FROM sap_if_run; ROLLBACK TO s;
SAVEPOINT s; DELETE FROM security_event; ROLLBACK TO s;
SAVEPOINT s; DELETE FROM audit_log; ROLLBACK TO s;
COMMIT;
RESET SESSION AUTHORIZATION;
\echo '--- 6. owner cannot disable / drop audit trigger'
ALTER TABLE company DISABLE TRIGGER tr_company_audit;
DROP TRIGGER tr_company_audit ON company;
SELECT tgenabled FROM pg_trigger WHERE tgname='tr_company_audit';
\echo '--- 7. SAP client lookup'
INSERT INTO sap_connection(id, tenant_id, system_id, company_id, oauth_client_id) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-00000000000a','PRD-100','33333333-3333-3333-3333-333333333333','abc123');
UPDATE tenant SET is_active=false WHERE code='ACME';
SET SESSION AUTHORIZATION tester;
SELECT count(*) AS inactive_tenant_client FROM auth_sap_client('abc123');
RESET SESSION AUTHORIZATION;
SELECT tableowner FROM pg_tables WHERE tablename='audit_log';
