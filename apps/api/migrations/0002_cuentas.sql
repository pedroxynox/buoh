-- F2.3 · Las cuentas de la API (ADR-0019 §1, §3 y §7), en el esquema buoh_api: las cuentas, los
-- enlaces de alta y de restablecimiento, los secretos TOTP que da cada enlace, las credenciales,
-- las credenciales deshabilitadas y los pasos TOTP ya usados. Como audit_events, cada tabla es
-- append-only: el rol buoh_api solo inserta y lee, y los triggers rechazan UPDATE, DELETE y
-- TRUNCATE, también al dueño. Lo que cambia es una fila nueva, y vale la última por write_order: el
-- último enlace de cada cuenta anula los anteriores, vale el último secreto de cada enlace y la
-- última credencial de cada cuenta. Las horas son el texto UTC de los contratos, con milisegundos.

-- Una cuenta de buoh, sin correo, nombre, teléfono ni dirección IP. `cuenta alta` la crea sin
-- credencial, junto con su primer enlace; queda dada de alta con su primera credencial.
CREATE TABLE accounts (
  account_id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_-]{3,32}$'),
  created_at_utc text NOT NULL
    CHECK (created_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
);

-- Un enlace de la orden cuenta. Solo se guarda el HMAC-SHA-256 de su token con BUOH_API_TOKEN_KEY,
-- que no está en la base: quien inserte una fila no fabrica un enlace válido. Vale 15 minutos y
-- una sola vez, y solo el último de su cuenta.
CREATE TABLE account_links (
  link_id uuid PRIMARY KEY,
  write_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  account_id uuid NOT NULL REFERENCES accounts (account_id),
  purpose text NOT NULL CHECK (purpose IN ('enrollment', 'reset')),
  token_hmac bytea NOT NULL UNIQUE CHECK (octet_length(token_hmac) = 32),
  created_at_utc text NOT NULL
    CHECK (created_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  expires_at_utc text NOT NULL
    CHECK (expires_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  CHECK (expires_at_utc > created_at_utc),
  UNIQUE (link_id, account_id)
);

CREATE INDEX account_links_by_account ON account_links (account_id, write_order);

-- Un secreto TOTP que dio un enlace, con el identificador de la credencial que será si el enlace
-- se usa con él. Va cifrado con AES-256-GCM y BUOH_API_TOTP_KEY, con la cuenta y la credencial
-- como datos asociados: la versión del formato (1), el nonce, el secreto y la etiqueta, 49 bytes.
CREATE TABLE link_totp_secrets (
  credential_id uuid PRIMARY KEY,
  write_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  link_id uuid NOT NULL REFERENCES account_links (link_id),
  totp_secret_sealed bytea NOT NULL
    CHECK (octet_length(totp_secret_sealed) = 49 AND get_byte(totp_secret_sealed, 0) = 1),
  created_at_utc text NOT NULL
    CHECK (created_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  UNIQUE (credential_id, link_id)
);

CREATE INDEX link_totp_secrets_by_link ON link_totp_secrets (link_id, write_order);

-- Una credencial: la contraseña con Argon2id, en el formato PHC, y el secreto TOTP del enlace que la
-- creó. Un enlace crea como mucho una (link_id es único), de su propia cuenta y con uno de sus
-- secretos, y vale la última de la cuenta.
CREATE TABLE credentials (
  credential_id uuid PRIMARY KEY,
  write_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  account_id uuid NOT NULL,
  link_id uuid NOT NULL UNIQUE,
  password_hash text NOT NULL
    CHECK (
      password_hash ~ '^\$argon2id\$v=19\$m=[1-9][0-9]*,t=[1-9][0-9]*,p=[1-9][0-9]*\$[A-Za-z0-9+/]{22,}\$[A-Za-z0-9+/]{43,}$'
    ),
  created_at_utc text NOT NULL
    CHECK (created_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  FOREIGN KEY (link_id, account_id) REFERENCES account_links (link_id, account_id),
  FOREIGN KEY (credential_id, link_id) REFERENCES link_totp_secrets (credential_id, link_id)
);

CREATE INDEX credentials_by_account ON credentials (account_id, write_order);

-- Una credencial deshabilitada: reemplazada por un restablecimiento o, desde el PR 4b, por sus 100
-- fallos seguidos. Una sola vez cada una.
CREATE TABLE credential_disablements (
  credential_id uuid PRIMARY KEY REFERENCES credentials (credential_id),
  reason text NOT NULL CHECK (reason IN ('replaced', 'failure_limit')),
  disabled_at_utc text NOT NULL
    CHECK (disabled_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
);

-- Los pasos TOTP aceptados de cada credencial: cada paso vale una sola vez, y nunca uno anterior al
-- último aceptado (ADR-0019 §1). La clave primaria lo garantiza también con dos peticiones a la vez.
CREATE TABLE totp_steps_used (
  credential_id uuid NOT NULL REFERENCES credentials (credential_id),
  totp_step bigint NOT NULL CHECK (totp_step >= 0),
  used_at_utc text NOT NULL
    CHECK (used_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  PRIMARY KEY (credential_id, totp_step)
);

CREATE TRIGGER accounts_append_only
  BEFORE UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER accounts_no_truncate
  BEFORE TRUNCATE ON accounts
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER account_links_append_only
  BEFORE UPDATE OR DELETE ON account_links
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER account_links_no_truncate
  BEFORE TRUNCATE ON account_links
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER link_totp_secrets_append_only
  BEFORE UPDATE OR DELETE ON link_totp_secrets
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER link_totp_secrets_no_truncate
  BEFORE TRUNCATE ON link_totp_secrets
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER credentials_append_only
  BEFORE UPDATE OR DELETE ON credentials
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER credentials_no_truncate
  BEFORE TRUNCATE ON credentials
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER credential_disablements_append_only
  BEFORE UPDATE OR DELETE ON credential_disablements
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER credential_disablements_no_truncate
  BEFORE TRUNCATE ON credential_disablements
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER totp_steps_used_append_only
  BEFORE UPDATE OR DELETE ON totp_steps_used
  FOR EACH ROW EXECUTE FUNCTION buoh_reject_mutation();
CREATE TRIGGER totp_steps_used_no_truncate
  BEFORE TRUNCATE ON totp_steps_used
  FOR EACH STATEMENT EXECUTE FUNCTION buoh_reject_mutation();
