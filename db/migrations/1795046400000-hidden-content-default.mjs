// Hide new questions by default without changing saved choices
export function up(pgm) {
  pgm.sql(
    'ALTER TABLE questions ALTER COLUMN hide_until_open SET DEFAULT true',
  );
}

// Keep saved choices when restoring the old default
export function down(pgm) {
  pgm.sql(
    'ALTER TABLE questions ALTER COLUMN hide_until_open SET DEFAULT false',
  );
}
