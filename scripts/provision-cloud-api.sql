-- Operator-only provisioning, after approval for a dedicated cloud deployment.
-- Run as postgres through the management migration tool. Never as the API role.
-- Generates the credential inside Postgres; no plaintext in SQL/history/output.
-- Retrieve only the named secret through the administrator Vault UI and place it
-- in the approved host's secret environment. Do not grant the API access to Vault.
DO $provision$
DECLARE
  role_info record;
  secret_count integer;
  credential text;
BEGIN
  IF coalesce(current_setting('pgaudit.log', true), 'none') <> 'none' OR
     current_setting('pg_stat_statements.track', true) = 'all' OR
     current_setting('auto_explain.log_nested_statements', true) = 'on' THEN
    RAISE EXCEPTION 'Nested SQL logging requires operator review';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sigongnote-api-provision', 0));
  SELECT * INTO STRICT role_info FROM pg_roles WHERE rolname = 'sigongnote_api';
  IF role_info.rolsuper OR role_info.rolbypassrls OR role_info.rolcreaterole OR
     role_info.rolcreatedb OR role_info.rolreplication OR
     EXISTS (SELECT 1 FROM pg_auth_members WHERE member = role_info.oid) OR
     has_schema_privilege('sigongnote_api', 'vault', 'USAGE') OR
     has_table_privilege('sigongnote_api', 'vault.decrypted_secrets', 'SELECT') THEN
    RAISE EXCEPTION 'API role privileges require operator review';
  END IF;
  SELECT count(*) INTO secret_count FROM vault.secrets
    WHERE name = 'sigongnote_api_runtime_password';
  IF secret_count = 0 AND NOT role_info.rolcanlogin THEN
    credential := encode(extensions.gen_random_bytes(48), 'hex');
    BEGIN
      PERFORM vault.create_secret(credential, 'sigongnote_api_runtime_password',
        'Dedicated Sigongnote API runtime login; operator access only');
      EXECUTE format('ALTER ROLE sigongnote_api LOGIN PASSWORD %L CONNECTION LIMIT 10', credential);
    EXCEPTION WHEN OTHERS THEN
      credential := NULL;
      -- Re-raise a fixed error; never expose dynamic SQL through error context.
      RAISE EXCEPTION 'API credential provisioning failed';
    END;
    credential := NULL;
    ALTER ROLE sigongnote_api SET statement_timeout = '15s';
  ELSIF secret_count = 1 AND role_info.rolcanlogin AND role_info.rolconnlimit = 10 AND
        'statement_timeout=15s' = ANY(coalesce(role_info.rolconfig, ARRAY[]::text[])) THEN
    -- Re-running does not rotate the existing host credential.
    NULL;
  ELSE
    RAISE EXCEPTION 'API credential state mismatch; no credential was changed';
  END IF;
END
$provision$;
