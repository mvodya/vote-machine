// Keep only hashes of admin keys
export function up(pgm) {
  pgm.sql(`
    CREATE TABLE room_admin_credentials (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
      secret_hash bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT admin_secret_hash_unique UNIQUE (secret_hash),
      CONSTRAINT admin_secret_hash_size CHECK (octet_length(secret_hash) = 32),
      CONSTRAINT admin_created_at_finite CHECK (isfinite(created_at))
    );
    CREATE INDEX admin_credentials_room_id ON room_admin_credentials(room_id);
  `);
}

// Remove the table created by this migration
export function down(pgm) {
  pgm.sql('DROP TABLE room_admin_credentials;');
}
