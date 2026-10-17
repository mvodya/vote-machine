import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
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
    assert.equal((await runMigrations({databaseUrl, count: 1})).length, 1);
    const room = (
      await client.query("INSERT INTO rooms (name) VALUES ('kept') RETURNING *")
    ).rows[0];
    assert.equal((await runMigrations({databaseUrl})).length, 1);
    assert.equal((await runMigrations({databaseUrl})).length, 0);
    assert.equal(await migrationCount(client), 2);
    assert.deepEqual(
      (await client.query('SELECT * FROM rooms WHERE id = $1', [room.id]))
        .rows[0],
      room,
    );
    assert.equal(
      (await client.query('SELECT count(*) FROM room_admin_credentials'))
        .rows[0].count,
      '0',
    );
  });
});

test('real database constraints reject bad keys and missing rooms', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const room = (
      await client.query('INSERT INTO rooms DEFAULT VALUES RETURNING id')
    ).rows[0].id;
    const otherRoom = (
      await client.query('INSERT INTO rooms DEFAULT VALUES RETURNING id')
    ).rows[0].id;
    const hash = randomBytes(32);
    await client.query(
      'INSERT INTO room_admin_credentials (room_id, secret_hash) VALUES ($1, $2)',
      [room, hash],
    );
    await assert.rejects(
      client.query(
        'INSERT INTO room_admin_credentials (room_id, secret_hash) VALUES ($1, $2)',
        [randomUUID(), randomBytes(32)],
      ),
      {code: '23503'},
    );
    await assert.rejects(
      client.query(
        'INSERT INTO room_admin_credentials (room_id, secret_hash) VALUES ($1, $2)',
        [room, randomBytes(31)],
      ),
      {code: '23514'},
    );
    await assert.rejects(
      client.query(
        'INSERT INTO room_admin_credentials (room_id, secret_hash) VALUES ($1, $2)',
        [otherRoom, hash],
      ),
      {code: '23505'},
    );
    await assert.rejects(
      client.query(
        'INSERT INTO room_admin_credentials (room_id, secret_hash) VALUES ($1, NULL)',
        [room],
      ),
      {code: '23502'},
    );
    await assert.rejects(
      client.query("INSERT INTO rooms (created_at) VALUES ('infinity')"),
      {code: '23514'},
    );
    await assert.rejects(
      client.query('INSERT INTO rooms (name) VALUES (NULL)'),
      {code: '23502'},
    );
    await assert.rejects(
      client.query('DELETE FROM rooms WHERE id = $1', [room]),
      {code: '23001'},
    );
  });
});

test('concurrent duplicate hashes are rejected by PostgreSQL', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const room = (
      await client.query('INSERT INTO rooms DEFAULT VALUES RETURNING id')
    ).rows[0].id;
    const second = new pg.Client({connectionString: databaseUrl});
    await second.connect();
    try {
      const hash = randomBytes(32);
      const sql =
        'INSERT INTO room_admin_credentials (room_id, secret_hash) VALUES ($1, $2)';
      const results = await Promise.allSettled([
        client.query(sql, [room, hash]),
        second.query(sql, [room, hash]),
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
        (await client.query('SELECT count(*) FROM room_admin_credentials'))
          .rows[0].count,
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
      await client.query("INSERT INTO rooms (name) VALUES ('kept')");
      await addMigration(
        dir,
        '1792800000002-probe',
        'CREATE TABLE migration_probe (id integer); INSERT INTO migration_probe VALUES (1);',
      );
      await addMigration(
        dir,
        '1792800000003-failure',
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
      assert.equal(await migrationCount(client), 2);
      // Only failed migrations may be fixed in place
      await addMigration(
        dir,
        '1792800000003-failure',
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
      assert.equal(await migrationCount(client), 4);
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
      assert.equal(await migrationCount(client), 2);
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
        "INSERT INTO rooms (created_at) VALUES ('2026-10-24T12:00:00+10:00') RETURNING id, created_at",
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
        '1792800000002-time-zone',
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

test('manual rollback removes one migration and up can apply it again', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const room = (
      await client.query("INSERT INTO rooms (name) VALUES ('kept') RETURNING *")
    ).rows[0];
    await client.query(
      'INSERT INTO room_admin_credentials (room_id, secret_hash) VALUES ($1, $2)',
      [room.id, randomBytes(32)],
    );
    const result = await execFileAsync(process.execPath, [script, 'down'], {
      env: {...process.env, DATABASE_URL: databaseUrl},
    });
    assert.equal(result.stdout.trim(), 'Reverted 1 migrations');
    assert.equal(await migrationCount(client), 1);
    assert.equal(
      (
        await client.query(
          "SELECT to_regclass('public.room_admin_credentials') AS name",
        )
      ).rows[0].name,
      null,
    );
    assert.deepEqual(
      (await client.query('SELECT * FROM rooms WHERE id = $1', [room.id]))
        .rows[0],
      room,
    );
    assert.equal((await runMigrations({databaseUrl})).length, 1);
    assert.equal(
      (await client.query('SELECT count(*) FROM room_admin_credentials'))
        .rows[0].count,
      '0',
    );
    // A full rollback must remove child tables before their parents
    assert.equal(
      (await runMigrations({databaseUrl, direction: 'down', count: 2})).length,
      2,
    );
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
    assert.equal((await runMigrations({databaseUrl})).length, 2);
    assert.equal(await migrationCount(client), 2);
  });
});

test('a blocked rollback keeps tables, data and history unchanged', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const room = (
      await client.query(
        "INSERT INTO rooms (name) VALUES ('kept') RETURNING id",
      )
    ).rows[0].id;
    const hash = randomBytes(32);
    await client.query(
      'INSERT INTO room_admin_credentials (room_id, secret_hash) VALUES ($1, $2)',
      [room, hash],
    );
    // An outside table should block the parent table drop
    await client.query(
      'CREATE TABLE outside_reference (room_id uuid REFERENCES rooms(id))',
    );
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: 2}),
      {code: '2BP01'},
    );
    assert.equal(await migrationCount(client), 2);
    assert.equal(
      (await client.query('SELECT name FROM rooms WHERE id = $1', [room]))
        .rows[0].name,
      'kept',
    );
    assert.deepEqual(
      (
        await client.query(
          'SELECT secret_hash FROM room_admin_credentials WHERE room_id = $1',
          [room],
        )
      ).rows[0].secret_hash,
      hash,
    );
    await client.query('DROP TABLE outside_reference');
    assert.equal(
      (await runMigrations({databaseUrl, direction: 'down', count: 2})).length,
      2,
    );
    assert.equal(await migrationCount(client), 0);
  });
});
