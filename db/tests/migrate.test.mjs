import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {cp, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import pg from 'pg';
import {runMigrations} from '../migrate.mjs';

assert.equal(process.env.MIGRATION_TESTS, '1', 'Run tests/test-migrations.sh');
const source = join(import.meta.dirname, '../migrations');
const script = join(import.meta.dirname, '../migrate.mjs');
const execFileAsync = promisify(execFile);
const total = (await readdir(source)).filter((file) =>
  file.endsWith('.mjs'),
).length;

// Give each check its own real database
async function withDatabase(check) {
  const name = `vote_machine_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({connectionString: process.env.DATABASE_URL});
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const client = new pg.Client({connectionString: databaseUrl});
    await client.connect();
    try {
      await check({client, databaseUrl});
    } finally {
      await client.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

// Copy migrations so tests never edit the real files
async function withMigrations(check, copyBase = true) {
  const dir = await mkdtemp(join(tmpdir(), 'vote-machine-migrations-'));
  try {
    if (copyBase) await cp(source, dir, {recursive: true});
    await check(dir);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

// Add a test migration with fixed SQL
async function addMigration(dir, name, sql) {
  await writeFile(
    join(dir, `${name}.mjs`),
    `export function up(pgm) { pgm.sql(${JSON.stringify(sql)}); }\nexport const down = false;\n`,
  );
}

// Read the number of recorded migrations
async function migrationCount(client) {
  return Number(
    (await client.query('SELECT count(*) FROM schema_migrations')).rows[0]
      .count,
  );
}

test('bad configuration and unknown commands fail without leaking secrets', async () => {
  await assert.rejects(
    runMigrations({databaseUrl: ''}),
    /DATABASE_URL is required/,
  );
  await assert.rejects(
    runMigrations({databaseUrl: 'private-secret'}),
    /DATABASE_URL must use PostgreSQL/,
  );
  await assert.rejects(
    runMigrations({databaseUrl: 'https://user:private-secret@localhost/db'}),
    /DATABASE_URL must use PostgreSQL/,
  );
  for (const args of [[], ['unknown']]) {
    await assert.rejects(
      execFileAsync(process.execPath, [script, ...args], {
        env: {...process.env, DATABASE_URL: 'private-secret'},
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.doesNotMatch(error.stdout + error.stderr, /private-secret/);
        assert.match(
          error.stderr,
          args.length
            ? /Use no arguments or down/
            : /DATABASE_URL must use PostgreSQL/,
        );
        return true;
      },
    );
  }
});

test('empty database, repeat run and upgrade keep existing room data', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await withMigrations(async (dir) => {
      assert.equal((await runMigrations({databaseUrl, dir})).length, total);
      const {room} = await adminRoom(client, 'kept');
      await addMigration(
        dir,
        '1792886400010-upgrade',
        'ALTER TABLE rooms ADD COLUMN checked boolean NOT NULL DEFAULT true;',
      );
      assert.equal((await runMigrations({databaseUrl, dir})).length, 1);
      assert.equal((await runMigrations({databaseUrl, dir})).length, 0);
      assert.deepEqual(
        (await client.query('SELECT * FROM rooms WHERE id = $1', [room.id]))
          .rows[0],
        {...room, checked: true},
      );
    });
  });
});

test('real database constraints reject bad keys and missing rooms', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const {room} = await adminRoom(client);
    const other = await adminRoom(client);
    await assert.rejects(
      client.query(
        'INSERT INTO room_admin_sessions (room_id, secret_hash) VALUES ($1, $2)',
        [randomUUID(), randomBytes(32)],
      ),
      {code: '23503'},
    );
    await assert.rejects(
      client.query('UPDATE rooms SET admin_secret_hash = $1 WHERE id = $2', [
        randomBytes(31),
        room.id,
      ]),
      {code: '23514'},
    );
    await assert.rejects(
      client.query('UPDATE rooms SET admin_secret_hash = $1 WHERE id = $2', [
        room.admin_secret_hash,
        other.room.id,
      ]),
      {code: '23505'},
    );
    await assert.rejects(
      client.query('UPDATE rooms SET admin_secret_hash = NULL WHERE id = $1', [
        room.id,
      ]),
      {code: '23502'},
    );
    await assert.rejects(
      client.query("UPDATE rooms SET created_at = 'infinity' WHERE id = $1", [
        room.id,
      ]),
      {code: '23514'},
    );
    await assert.rejects(
      client.query('UPDATE rooms SET name = NULL WHERE id = $1', [room.id]),
      {code: '23502'},
    );
    await assert.rejects(client.query('INSERT INTO rooms DEFAULT VALUES'), {
      code: '23502',
    });
    await assert.rejects(
      client.query('DELETE FROM rooms WHERE id = $1', [room.id]),
      {code: '23001'},
    );
  });
});

test('concurrent duplicate hashes are rejected by PostgreSQL', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const second = new pg.Client({connectionString: databaseUrl});
    await second.connect();
    try {
      const key = randomBytes(32);
      const sql =
        "INSERT INTO rooms (name, admin_secret_hash, admin_secret_cipher) VALUES ('race', $1, decode(repeat('00', 92), 'hex'))";
      const results = await Promise.allSettled([
        client.query(sql, [key]),
        second.query(sql, [key]),
      ]);
      assert.equal(
        results.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      assert.equal(
        results.find((result) => result.status === 'rejected').reason.code,
        '23505',
      );
      assert.equal(
        (await client.query('SELECT count(*) FROM rooms')).rows[0].count,
        '1',
      );
    } finally {
      await second.end();
    }
  });
});

test('failed upgrades roll back the whole batch and can be retried', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await withMigrations(async (dir) => {
      await runMigrations({databaseUrl, dir});
      await adminRoom(client, 'kept');
      await addMigration(
        dir,
        '1792886400010-probe',
        'CREATE TABLE migration_probe (id integer); INSERT INTO migration_probe VALUES (1);',
      );
      await addMigration(
        dir,
        '1792886400011-failure',
        "UPDATE rooms SET name = 'lost'; SELECT 1 / 0;",
      );
      await assert.rejects(runMigrations({databaseUrl, dir}));
      assert.equal(
        (
          await client.query(
            "SELECT to_regclass('public.migration_probe') AS name",
          )
        ).rows[0].name,
        null,
      );
      assert.equal(
        (await client.query('SELECT name FROM rooms')).rows[0].name,
        'kept',
      );
      assert.equal(await migrationCount(client), total);
      // Only failed migrations may be fixed in place
      await addMigration(
        dir,
        '1792886400011-failure',
        'ALTER TABLE migration_probe ADD COLUMN checked boolean NOT NULL DEFAULT true;',
      );
      // A new container must load the fixed file again
      const retry = await execFileAsync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          'const {runMigrations} = await import(process.argv[1]); console.log((await runMigrations({dir: process.argv[2]})).length);',
          new URL('../migrate.mjs', import.meta.url).href,
          dir,
        ],
        {env: {...process.env, DATABASE_URL: databaseUrl}},
      );
      assert.equal(retry.stdout.trim(), '2');
      assert.equal(await migrationCount(client), total + 2);
      assert.equal(
        (await client.query('SELECT checked FROM migration_probe')).rows[0]
          .checked,
        true,
      );
    });
  });
});

test('failed first migration leaves no application tables', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await withMigrations(async (dir) => {
      await addMigration(
        dir,
        '1792800000000-failure',
        'CREATE TABLE migration_probe (id integer); SELECT 1 / 0;',
      );
      await assert.rejects(runMigrations({databaseUrl, dir}));
      assert.equal(
        (
          await client.query(
            "SELECT to_regclass('public.migration_probe') AS name",
          )
        ).rows[0].name,
        null,
      );
      assert.equal(await migrationCount(client), 0);
    }, false);
  });
});

test('out-of-order migrations are refused before changes', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await withMigrations(async (dir) => {
      await runMigrations({databaseUrl, dir});
      await addMigration(
        dir,
        '1792799999999-old',
        'CREATE TABLE out_of_order (id integer);',
      );
      await assert.rejects(
        runMigrations({databaseUrl, dir}),
        /preceding already run/,
      );
      assert.equal(await migrationCount(client), total);
      assert.equal(
        (
          await client.query(
            "SELECT to_regclass('public.out_of_order') AS name",
          )
        ).rows[0].name,
        null,
      );
    });
  });
});

test('two runners wait for one lock and apply each file once', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await withMigrations(async (dir) => {
      await addMigration(
        dir,
        '1792800000000-lock',
        'CREATE TABLE migration_probe (id integer); SELECT pg_sleep(1); INSERT INTO migration_probe VALUES (1);',
      );
      const first = runMigrations({databaseUrl, dir});
      first.catch(() => {});
      let sleeping = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await client.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'vote_machine_migrate' AND wait_event = 'PgSleep'",
        );
        if (result.rowCount) {
          sleeping = true;
          break;
        }
        await delay(20);
      }
      assert.ok(sleeping, 'First runner did not reach its migration');
      const second = runMigrations({databaseUrl, dir});
      const [a, b] = await Promise.all([first, second]);
      assert.deepEqual([a.length, b.length], [1, 0]);
      assert.equal(await migrationCount(client), 1);
      assert.equal(
        (await client.query('SELECT count(*) FROM migration_probe')).rows[0]
          .count,
        '1',
      );
    }, false);
  });
});

test('dates keep their instant across time zones and migration sessions use UTC', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const room = (
      await client.query(
        "INSERT INTO rooms (created_at, admin_secret_hash, admin_secret_cipher) VALUES ('2026-10-24T12:00:00+10:00', $1, decode(repeat('00', 92), 'hex')) RETURNING id, created_at",
        [randomBytes(32)],
      )
    ).rows[0];
    assert.equal(room.created_at.toISOString(), '2026-10-24T02:00:00.000Z');
    await client.query("SET TIME ZONE 'America/New_York'");
    assert.equal(
      (
        await client.query('SELECT created_at FROM rooms WHERE id = $1', [
          room.id,
        ])
      ).rows[0].created_at.toISOString(),
      '2026-10-24T02:00:00.000Z',
    );
    const database = new URL(databaseUrl).pathname.slice(1);
    await client.query(
      `ALTER DATABASE "${database}" SET timezone TO 'America/New_York'`,
    );
    await withMigrations(async (dir) => {
      await addMigration(
        dir,
        '1792886400010-time-zone',
        "CREATE TABLE migration_zone AS SELECT current_setting('TimeZone') AS zone;",
      );
      await runMigrations({databaseUrl, dir});
      assert.equal(
        (await client.query('SELECT zone FROM migration_zone')).rows[0].zone,
        'UTC',
      );
    });
  });
});

test('each project migration has explicit up and down steps', async () => {
  for (const file of await readdir(source)) {
    if (!file.endsWith('.mjs')) continue;
    const migration = await import(
      new URL(`../migrations/${file}`, import.meta.url)
    );
    assert.equal(typeof migration.up, 'function', `${file} needs up`);
    assert.equal(typeof migration.down, 'function', `${file} needs down`);
  }
});

test('manual rollback removes the schema and up can apply it again', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    await adminRoom(client, 'kept');
    const result = await execFileAsync(process.execPath, [script, 'down'], {
      env: {...process.env, DATABASE_URL: databaseUrl},
    });
    assert.equal(result.stdout.trim(), 'Reverted 1 migrations');
    assert.equal(await migrationCount(client), 0);
    assert.equal(
      (await client.query("SELECT to_regclass('public.rooms') AS name")).rows[0]
        .name,
      null,
    );
    assert.equal(
      (await runMigrations({databaseUrl, direction: 'down'})).length,
      0,
    );
    assert.equal((await runMigrations({databaseUrl})).length, total);
    assert.equal(
      (await client.query('SELECT count(*) FROM rooms')).rows[0].count,
      '0',
    );
  });
});

test('a blocked rollback keeps tables, data and history unchanged', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const {room, session} = await adminRoom(client, 'kept');
    // An outside table should block the parent table drop
    await client.query(
      'CREATE TABLE outside_reference (room_id uuid REFERENCES rooms(id))',
    );
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: total}),
      {code: '2BP01'},
    );
    assert.equal(await migrationCount(client), total);
    assert.deepEqual(
      (await client.query('SELECT * FROM rooms WHERE id = $1', [room.id]))
        .rows[0],
      room,
    );
    assert.equal(
      (
        await client.query('SELECT * FROM vm_admin_room($1, $2)', [
          room.id,
          hash(session),
        ])
      ).rowCount,
      1,
    );
    await client.query('DROP TABLE outside_reference');
    assert.equal(
      (await runMigrations({databaseUrl, direction: 'down', count: total}))
        .length,
      total,
    );
    assert.equal(await migrationCount(client), 0);
  });
});

// Match the API hashes without storing raw keys in PostgreSQL
function hash(secret) {
  return createHash('sha256').update(secret).digest();
}

// Create a room and one independent admin session
async function adminRoom(client, name = '') {
  const key = randomBytes(32).toString('hex');
  const session = randomBytes(32).toString('hex');
  const room = (
    await client.query('SELECT * FROM vm_create_room($1, $2, $3)', [
      name,
      hash(key),
      Buffer.alloc(92),
    ])
  ).rows[0];
  await client.query('SELECT * FROM vm_open_admin_session($1, $2, $3)', [
    room.id,
    hash(key),
    hash(session),
  ]);
  return {room, key, session};
}

test('room creation is atomic and database constraints cover direct SQL', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const {room, key} = await adminRoom(client);
    assert.equal(room.name, 'Новая комната');
    assert.equal(room.revision, '0');
    const before = (await client.query('SELECT count(*) FROM rooms')).rows[0]
      .count;
    await assert.rejects(
      client.query('SELECT * FROM vm_create_room($1, $2, $3)', [
        'failed',
        hash(key),
        Buffer.alloc(92),
      ]),
      {code: '23505'},
    );
    assert.equal(
      (await client.query('SELECT count(*) FROM rooms')).rows[0].count,
      before,
    );
    for (const name of ['', ' '.repeat(10), 'a'.repeat(201)]) {
      await assert.rejects(
        client.query('UPDATE rooms SET name = $1 WHERE id = $2', [
          name,
          room.id,
        ]),
        {code: '23514'},
      );
    }
    await assert.rejects(
      client.query('SELECT * FROM vm_create_room($1, $2, $3)', [
        'bad',
        Buffer.alloc(31),
        Buffer.alloc(92),
      ]),
      {code: '23514'},
    );
    assert.equal(
      (await client.query('SELECT count(*) FROM rooms')).rows[0].count,
      before,
    );
  });
});

test('admin sessions are independent, room scoped and have no time limit', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const {room, key, session} = await adminRoom(client, 'one');
    const other = await adminRoom(client, 'two');
    const secondSession = randomBytes(32).toString('hex');
    assert.equal(
      (
        await client.query('SELECT * FROM vm_open_admin_session($1, $2, $3)', [
          room.id,
          hash(key),
          hash(secondSession),
        ])
      ).rowCount,
      1,
    );
    for (const token of [session, secondSession]) {
      assert.equal(
        (
          await client.query('SELECT * FROM vm_admin_room($1, $2)', [
            room.id,
            hash(token),
          ])
        ).rowCount,
        1,
      );
    }
    assert.equal(
      (
        await client.query('SELECT * FROM vm_admin_room($1, $2)', [
          other.room.id,
          hash(session),
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await client.query('SELECT * FROM vm_admin_room($1, $2)', [
          room.id,
          hash(key),
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await client.query('SELECT * FROM vm_open_admin_session($1, $2, $3)', [
          other.room.id,
          hash(key),
          randomBytes(32),
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await client.query('SELECT * FROM vm_rename_room($1, $2, $3)', [
          other.room.id,
          hash(session),
          'hacked',
        ])
      ).rowCount,
      0,
    );
    await client.query(
      "UPDATE room_admin_sessions SET created_at = now() - interval '100 years' WHERE secret_hash = $1",
      [hash(session)],
    );
    assert.equal(
      (
        await client.query('SELECT * FROM vm_admin_room($1, $2)', [
          room.id,
          hash(session),
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await client.query('SELECT * FROM vm_rename_room($1, $2, $3)', [
          room.id,
          hash(session),
          'old session',
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await client.query('SELECT * FROM vm_admin_room($1, $2)', [
          room.id,
          hash(secondSession),
        ])
      ).rowCount,
      1,
    );
  });
});

test('concurrent renames keep a complete revision sequence', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const {room, session} = await adminRoom(client);
    const second = new pg.Client({connectionString: databaseUrl});
    await second.connect();
    try {
      const query = 'SELECT * FROM vm_rename_room($1, $2, $3)';
      const results = await Promise.all([
        client.query(query, [room.id, hash(session), 'A']),
        second.query(query, [room.id, hash(session), 'B']),
      ]);
      assert.deepEqual(
        results.map((result) => result.rows[0].revision).sort(),
        ['1', '2'],
      );
      assert.equal(
        (
          await client.query('SELECT revision FROM rooms WHERE id = $1', [
            room.id,
          ])
        ).rows[0].revision,
        '2',
      );
    } finally {
      await second.end();
    }
  });
});

test('room triggers notify after commit and never publish secrets or rolled back changes', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const listener = new pg.Client({connectionString: databaseUrl});
    await listener.connect();
    const notifications = [];
    listener.on('notification', (event) =>
      notifications.push(JSON.parse(event.payload)),
    );
    try {
      await listener.query('LISTEN room_changes');
      await client.query('BEGIN');
      const {room} = await adminRoom(client);
      await delay(30);
      assert.equal(notifications.length, 0);
      await client.query('COMMIT');
      for (
        let attempt = 0;
        notifications.length === 0 && attempt < 50;
        attempt++
      )
        await delay(10);
      assert.deepEqual(notifications, [{roomId: room.id, revision: '0'}]);
      await client.query('BEGIN');
      await client.query(
        "UPDATE rooms SET name = 'rolled back' WHERE id = $1",
        [room.id],
      );
      await client.query('ROLLBACK');
      await delay(30);
      assert.equal(notifications.length, 1);
      assert.equal(
        (
          await client.query('SELECT revision FROM rooms WHERE id = $1', [
            room.id,
          ])
        ).rows[0].revision,
        '0',
      );
    } finally {
      await listener.end();
    }
  });
});
