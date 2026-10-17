// Create the base room data
export function up(pgm) {
  pgm.sql(`
    CREATE TABLE rooms (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT rooms_created_at_finite CHECK (isfinite(created_at))
    );
  `);
}

// Remove the table created by this migration
export function down(pgm) {
  pgm.sql('DROP TABLE rooms;');
}
