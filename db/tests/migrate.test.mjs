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
        '1793145600010-upgrade',
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
        '1793145600010-probe',
        'CREATE TABLE migration_probe (id integer); INSERT INTO migration_probe VALUES (1);',
      );
      await addMigration(
        dir,
        '1793145600011-failure',
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
        '1793145600011-failure',
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
        '1793145600010-time-zone',
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

test('latest rollback keeps rooms and full rollback removes the schema', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const {room, session} = await adminRoom(client, 'kept');
    const result = await execFileAsync(process.execPath, [script, 'down'], {
      env: {...process.env, DATABASE_URL: databaseUrl},
    });
    assert.equal(result.stdout.trim(), 'Reverted 1 migrations');
    assert.equal(await migrationCount(client), total - 1);
    assert.equal(
      (await client.query("SELECT to_regclass('public.assets') AS name"))
        .rows[0].name,
      null,
    );
    assert.equal(
      (
        await client.query('SELECT * FROM vm_admin_room($1,$2)', [
          room.id,
          hash(session),
        ])
      ).rowCount,
      1,
    );
    assert.equal((await runMigrations({databaseUrl})).length, 1);
    assert.equal(
      (await runMigrations({databaseUrl, direction: 'down', count: total}))
        .length,
      total,
    );
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

// Make unique keys while leaving cipher checks to API tests
function linkItem(name = 'Respondent', mode = 'personal') {
  const key = randomBytes(32).toString('hex');
  return {
    key,
    name,
    mode,
    hash: hash(key).toString('hex'),
    cipher: Buffer.alloc(92).toString('hex'),
  };
}
// Add a whole batch through the database access function
async function addLinks(client, admin, items) {
  return (
    await client.query('SELECT * FROM vm_add_voting_links($1,$2,$3)', [
      admin.room.id,
      hash(admin.session),
      JSON.stringify(items),
    ])
  ).rows;
}
// Change a link through the same locked path used by the API
async function editLink(client, admin, link, action, key = linkItem()) {
  return (
    await client.query(
      'SELECT * FROM vm_edit_voting_link($1,$2,$3,$4,$5,$6,$7)',
      [
        admin.room.id,
        hash(admin.session),
        link.id,
        action,
        key.name,
        Buffer.from(key.hash, 'hex'),
        Buffer.from(key.cipher, 'hex'),
      ],
    )
  ).rows;
}
// Use real stored sessions when checking access
async function openLink(
  client,
  link,
  key,
  session = randomBytes(32).toString('hex'),
) {
  const result = await client.query(
    'SELECT * FROM vm_open_voting_session($1,$2,$3)',
    [link.id, hash(key), hash(session)],
  );
  return {session, count: result.rowCount};
}
// Check the session against the current link generation
async function linkAccess(client, link, session) {
  return (
    await client.query('SELECT * FROM vm_voting_access($1,$2)', [
      link.id,
      hash(session),
    ])
  ).rowCount;
}

test('link batches are atomic and database access stays inside the room', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const other = await adminRoom(client);
    const first = linkItem();
    for (const bad of [
      {...linkItem(), name: 'x'.repeat(201)},
      {...linkItem(), mode: 'bad'},
      {...linkItem(), hash: '01'},
      {...linkItem(), cipher: ''},
    ]) {
      await assert.rejects(addLinks(client, admin, [first, bad]));
      assert.equal(
        (await client.query('SELECT count(*) FROM voting_links')).rows[0].count,
        '0',
      );
    }
    await assert.rejects(addLinks(client, admin, []), {code: '23514'});
    await assert.rejects(
      addLinks(
        client,
        admin,
        Array.from({length: 101}, () => linkItem()),
      ),
      {code: '23514'},
    );
    assert.equal(
      (await addLinks(client, {...admin, session: other.session}, [first]))
        .length,
      0,
    );
    const [link] = await addLinks(client, admin, [first]);
    assert.equal((await editLink(client, other, link, 'revoke')).length, 0);
    assert.equal(
      (
        await client.query('SELECT * FROM vm_voting_link_secret($1,$2,$3)', [
          other.room.id,
          hash(other.session),
          link.id,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await client.query('SELECT * FROM vm_list_voting_links($1,$2,0,51)', [
          admin.room.id,
          hash(other.session),
        ])
      ).rowCount,
      0,
    );
    for (const sql of [
      "mode = 'reusable'",
      `room_id = '${other.room.id}'`,
      'id = gen_random_uuid()',
      'ordinal = ordinal + 1000',
    ]) {
      await assert.rejects(
        client.query(`UPDATE voting_links SET ${sql} WHERE id=$1`, [link.id]),
      );
    }
  });
});

test('link pages have stable cursors and total links have no batch limit', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    await addLinks(
      client,
      admin,
      Array.from({length: 100}, () => linkItem()),
    );
    await addLinks(client, admin, [linkItem('More', 'reusable')]);
    const ids = new Set();
    let after = '0';
    while (true) {
      const rows = (
        await client.query('SELECT * FROM vm_list_voting_links($1,$2,$3,51)', [
          admin.room.id,
          hash(admin.session),
          after,
        ])
      ).rows;
      const page = rows.slice(0, 50);
      for (const row of page) {
        assert(!ids.has(row.id));
        ids.add(row.id);
      }
      if (rows.length <= 50) break;
      after = page.at(-1).ordinal;
    }
    assert.equal(ids.size, 101);
    for (const [cursor, limit] of [
      [-1, 51],
      [0, 52],
      [null, 50],
      [0, null],
    ]) {
      await assert.rejects(
        client.query('SELECT * FROM vm_list_voting_links($1,$2,$3,$4)', [
          admin.room.id,
          hash(admin.session),
          cursor,
          limit,
        ]),
        {code: '23514'},
      );
    }
  });
});

test('renames keep access and revoke or rotation preserve stable used rights', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const key = linkItem();
    const [link] = await addLinks(client, admin, [key]);
    const opened = await openLink(client, link, key.key);
    assert.equal(opened.count, 1);
    assert.equal(await linkAccess(client, link, admin.session), 0);
    assert.equal(
      (
        await client.query('SELECT * FROM vm_admin_room($1,$2)', [
          admin.room.id,
          hash(opened.session),
        ])
      ).rowCount,
      0,
    );
    // A real child row models a right keyed by stable link identity
    await client.query(
      'CREATE TABLE used_right_probe (link_id uuid PRIMARY KEY REFERENCES voting_links(id))',
    );
    await client.query('INSERT INTO used_right_probe VALUES ($1)', [link.id]);
    const [renamed] = await editLink(
      client,
      admin,
      link,
      'rename',
      linkItem('New name'),
    );
    assert.equal(renamed.generation, link.generation);
    assert.equal(await linkAccess(client, link, opened.session), 1);
    await editLink(client, admin, link, 'revoke');
    assert.equal(await linkAccess(client, link, opened.session), 0);
    assert.equal((await openLink(client, link, key.key)).count, 0);
    assert.equal(
      (
        await client.query('SELECT * FROM vm_voting_link_secret($1,$2,$3)', [
          admin.room.id,
          hash(admin.session),
          link.id,
        ])
      ).rowCount,
      0,
    );
    const replacement = linkItem();
    const [rotated] = await editLink(
      client,
      admin,
      link,
      'rotate',
      replacement,
    );
    assert.equal(rotated.id, link.id);
    assert.equal(rotated.name, 'New name');
    assert.equal(rotated.mode, 'personal');
    assert.equal(rotated.revoked_at, null);
    assert.equal((await openLink(client, link, key.key)).count, 0);
    assert.equal(await linkAccess(client, link, opened.session), 0);
    const current = await openLink(client, link, replacement.key);
    assert.equal(current.count, 1);
    await assert.rejects(
      client.query('INSERT INTO used_right_probe VALUES ($1)', [rotated.id]),
      {code: '23505'},
    );
    await editLink(client, admin, link, 'rotate', linkItem());
    assert.equal(await linkAccess(client, link, current.session), 0);
    assert.equal(
      (await client.query('SELECT count(*) FROM used_right_probe')).rows[0]
        .count,
      '1',
    );
  });
});

test('opening a session cannot race past revoke or key replacement', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const second = new pg.Client({connectionString: databaseUrl});
    await second.connect();
    try {
      for (const action of ['revoke', 'rotate']) {
        for (let index = 0; index < 5; index++) {
          const key = linkItem();
          const [link] = await addLinks(client, admin, [key]);
          const [opened] = await Promise.all([
            openLink(second, link, key.key),
            editLink(client, admin, link, action),
          ]);
          assert.equal(await linkAccess(client, link, opened.session), 0);
          assert.equal((await openLink(client, link, key.key)).count, 0);
        }
      }
    } finally {
      await second.end();
    }
  });
});

test('link signals are committed without names or keys and rollback sends none', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const listener = new pg.Client({connectionString: databaseUrl});
    await listener.connect();
    const signals = [];
    listener.on('notification', (event) =>
      signals.push(JSON.parse(event.payload)),
    );
    try {
      await listener.query('LISTEN voting_link_changes');
      await client.query('BEGIN');
      const [link] = await addLinks(client, admin, [linkItem('Private label')]);
      await delay(20);
      assert.equal(signals.length, 0);
      await client.query('COMMIT');
      for (let index = 0; index < 50 && !signals.length; index++)
        await delay(10);
      assert.deepEqual(signals, [
        {roomId: admin.room.id, linkId: link.id, revision: '0'},
      ]);
      await client.query('BEGIN');
      await editLink(client, admin, link, 'revoke');
      await client.query('ROLLBACK');
      await delay(40);
      assert.equal(signals.length, 1);
    } finally {
      await listener.end();
    }
  });
});

test('a blocked link rollback preserves link access and migration history', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const key = linkItem();
    const [link] = await addLinks(client, admin, [key]);
    const opened = await openLink(client, link, key.key);
    await client.query(
      'CREATE TABLE outside_link_reference (link_id uuid REFERENCES voting_links(id))',
    );
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: total - 1}),
      {
        code: '2BP01',
      },
    );
    assert.equal(await migrationCount(client), total);
    assert.equal(await linkAccess(client, link, opened.session), 1);
    await client.query('DROP TABLE outside_link_reference');
    await runMigrations({databaseUrl, direction: 'down', count: total - 1});
    assert.equal(
      (
        await client.query('SELECT * FROM vm_admin_room($1,$2)', [
          admin.room.id,
          hash(admin.session),
        ])
      ).rowCount,
      1,
    );
    await runMigrations({databaseUrl});
    assert.equal(
      (await client.query('SELECT count(*) FROM voting_links')).rows[0].count,
      '0',
    );
  });
});

// Build a complete draft with valid defaults
function questionDocument(extra = {}) {
  return {
    content: '',
    choiceMode: 'single',
    minChoices: 1,
    maxChoices: 1,
    shareResults: false,
    publication: 'after_close',
    hideResultsUntilEnd: false,
    allowAnswerChange: false,
    anonymous: false,
    choices: [],
    ...extra,
  };
}
// Use the public database entry point with a real admin session
async function questionCall(client, admin, action, data = {}, id = null) {
  return (
    await client.query('SELECT vm_question_request($1,$2,$3,$4,$5) AS reply', [
      admin.room.id,
      hash(admin.session),
      id,
      action,
      JSON.stringify(data),
    ])
  ).rows[0].reply;
}

test('drafts keep source text, stable option IDs, settings and display order', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const empty = await questionCall(
      client,
      admin,
      'create',
      questionDocument(),
    );
    assert.equal(empty.status, 201);
    assert.deepEqual(empty.question.choices, []);
    const created = await questionCall(
      client,
      admin,
      'create',
      questionDocument({
        content: 'Choose',
        choices: [{content: 'A'}, {content: 'B'}, {content: 'C'}],
        choiceMode: 'multiple',
        maxChoices: 3,
        minChoices: 2,
        shareResults: true,
        publication: 'after_answer',
        hideResultsUntilEnd: true,
        allowAnswerChange: true,
        anonymous: true,
      }),
    );
    assert.equal(created.status, 201);
    const q = created.question;
    assert.equal(q.state, 'draft');
    assert.equal(q.editLocked, null);
    assert.equal(q.choices.length, 3);
    assert(q.choices.every((choice) => choice.id));
    const edited = await questionCall(
      client,
      admin,
      'save',
      {
        ...q,
        content: 'Changed',
        choices: [q.choices[2], q.choices[0], {content: 'New'}],
      },
      q.id,
    );
    assert.equal(edited.status, 200);
    assert.equal(edited.question.choices[0].id, q.choices[2].id);
    assert.equal(edited.question.choices[1].id, q.choices[0].id);
    assert.equal(edited.question.choices[2].content, 'New');
    assert.equal(edited.question.createdAt, q.createdAt);
    assert.equal(edited.question.ordinal, q.ordinal);
    assert(BigInt(edited.question.revision) > BigInt(q.revision));
    assert.equal(
      (
        await client.query(
          'SELECT count(*) FROM question_options WHERE id=$1',
          [q.choices[1].id],
        )
      ).rows[0].count,
      '0',
    );
    assert.deepEqual(
      (await questionCall(client, admin, 'get', {}, q.id)).question,
      edited.question,
    );
  });
});

test('invalid drafts and foreign options never leave partial changes', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const other = await adminRoom(client);
    const created = await questionCall(
      client,
      admin,
      'create',
      questionDocument({
        content: 'Kept',
        choices: [{content: 'A'}, {content: 'B'}],
      }),
    );
    const q = created.question;
    const foreign = (
      await questionCall(
        client,
        other,
        'create',
        questionDocument({choices: [{content: 'Foreign'}]}),
      )
    ).question;
    for (const extra of [
      {content: 'x'.repeat(20001)},
      {choices: [{content: 'x'.repeat(5001)}]},
      {choices: Array.from({length: 101}, () => ({content: ''}))},
      {minChoices: 0},
      {maxChoices: 3},
      {choiceMode: 'bad'},
      {minChoices: 1.5},
      {shareResults: 'yes'},
      {choices: [q.choices[0], q.choices[0]]},
      {choices: [foreign.choices[0]]},
      {choices: [{id: randomUUID(), content: 'Unknown'}]},
      {choices: [{id: null, content: ''}]},
    ]) {
      const reply = await questionCall(
        client,
        admin,
        'save',
        {...q, ...extra},
        q.id,
      );
      assert.equal(reply.status, 400);
      assert.deepEqual(
        (await questionCall(client, admin, 'get', {}, q.id)).question,
        q,
      );
    }
    assert.equal(
      (
        await questionCall(
          client,
          {...admin, session: other.session},
          'get',
          {},
          q.id,
        )
      ).status,
      401,
    );
    for (const action of ['get', 'save', 'delete'])
      assert.equal(
        (await questionCall(client, other, action, q, q.id)).status,
        404,
      );
    assert.equal(
      (await questionCall(client, admin, 'get', {}, foreign.id)).status,
      404,
    );
    assert.equal(
      (
        await questionCall(
          client,
          admin,
          'save',
          {...q, revision: '9223372036854775808'},
          q.id,
        )
      ).status,
      400,
    );
  });
});

test('concurrent draft saves and save versus delete reject old revisions', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const second = new pg.Client({connectionString: databaseUrl});
    await second.connect();
    try {
      let q = (
        await questionCall(
          client,
          admin,
          'create',
          questionDocument({content: 'Start'}),
        )
      ).question;
      const saves = await Promise.all([
        questionCall(client, admin, 'save', {...q, content: 'One'}, q.id),
        questionCall(second, admin, 'save', {...q, content: 'Two'}, q.id),
      ]);
      assert.deepEqual(saves.map((reply) => reply.status).sort(), [200, 409]);
      q = (await questionCall(client, admin, 'get', {}, q.id)).question;
      const race = await Promise.all([
        questionCall(client, admin, 'save', {...q, content: 'Last'}, q.id),
        questionCall(second, admin, 'delete', {revision: q.revision}, q.id),
      ]);
      assert.equal(race.filter((reply) => reply.status === 200).length, 1);
      assert(
        race.some((reply) => reply.status === 409 || reply.status === 404),
      );
    } finally {
      await second.end();
    }
  });
});

test('room edit policy is captured on first opening and cannot be withdrawn', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    let policy = (await questionCall(client, admin, 'policy')).policy;
    assert.equal(policy.lockAfterOpen, true);
    let q = (
      await questionCall(
        client,
        admin,
        'create',
        questionDocument({choices: [{content: 'A'}, {content: 'B'}]}),
      )
    ).question;
    // Seed the future lifecycle through SQL without adding an opening API
    await client.query(
      "UPDATE questions SET state='open', edit_locked=false WHERE id=$1",
      [q.id],
    );
    q = (await questionCall(client, admin, 'get', {}, q.id)).question;
    assert.equal(q.editLocked, true);
    assert.equal(
      (
        await questionCall(
          client,
          admin,
          'save',
          {...q, content: 'Changed'},
          q.id,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await questionCall(
          client,
          admin,
          'delete',
          {revision: q.revision},
          q.id,
        )
      ).status,
      409,
    );
    await assert.rejects(
      client.query('UPDATE questions SET edit_locked=false WHERE id=$1', [
        q.id,
      ]),
      {code: '23514'},
    );
    await assert.rejects(
      client.query(
        "UPDATE question_options SET content='Changed' WHERE question_id=$1",
        [q.id],
      ),
      {code: '23514'},
    );
    assert.equal(
      (
        await questionCall(client, admin, 'setPolicy', {
          ...policy,
          lockAfterOpen: false,
        })
      ).status,
      200,
    );
    assert.equal(
      (await questionCall(client, admin, 'get', {}, q.id)).question.editLocked,
      true,
    );
    assert.equal(
      (
        await questionCall(client, admin, 'setPolicy', {
          ...policy,
          lockAfterOpen: false,
        })
      ).status,
      409,
    );
    let editable = (
      await questionCall(
        client,
        admin,
        'create',
        questionDocument({content: 'Editable'}),
      )
    ).question;
    await client.query("UPDATE questions SET state='open' WHERE id=$1", [
      editable.id,
    ]);
    editable = (await questionCall(client, admin, 'get', {}, editable.id))
      .question;
    assert.equal(editable.editLocked, false);
    assert.equal(
      (
        await questionCall(
          client,
          admin,
          'save',
          {...editable, content: 'Updated'},
          editable.id,
        )
      ).status,
      200,
    );
    editable = (await questionCall(client, admin, 'get', {}, editable.id))
      .question;
    assert.equal(
      (
        await questionCall(
          client,
          admin,
          'save',
          {...editable, anonymous: true},
          editable.id,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await questionCall(
          client,
          admin,
          'delete',
          {revision: editable.revision},
          editable.id,
        )
      ).status,
      409,
    );
    policy = (await questionCall(client, admin, 'policy')).policy;
    await questionCall(client, admin, 'setPolicy', {
      ...policy,
      lockAfterOpen: true,
    });
    assert.equal(
      (await questionCall(client, admin, 'get', {}, editable.id)).question
        .editLocked,
      false,
    );
    await client.query("UPDATE questions SET state='closed' WHERE id=$1", [
      editable.id,
    ]);
    await assert.rejects(
      client.query(
        "UPDATE questions SET state='draft',first_opened_at=NULL,edit_locked=NULL WHERE id=$1",
        [editable.id],
      ),
      {code: '23514'},
    );
  });
});

test('database constraints protect option ownership, positions and selection limits', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const other = await adminRoom(client);
    const q = (
      await questionCall(
        client,
        admin,
        'create',
        questionDocument({
          choices: [{content: 'A'}, {content: 'B'}],
          choiceMode: 'multiple',
          maxChoices: 2,
        }),
      )
    ).question;
    for (const sql of [
      'UPDATE questions SET min_choices=0 WHERE id=$1',
      "UPDATE questions SET content=repeat('a',20001) WHERE id=$1",
      'UPDATE questions SET ordinal=ordinal+1 WHERE id=$1',
      'UPDATE question_options SET position=99 WHERE question_id=$1',
      'DELETE FROM question_options WHERE question_id=$1',
    ])
      await assert.rejects(client.query(sql, [q.id]));
    await assert.rejects(
      client.query(
        'UPDATE question_options SET room_id=$1 WHERE question_id=$2',
        [other.room.id, q.id],
      ),
    );
    await assert.rejects(
      client.query(
        'UPDATE question_options SET id=gen_random_uuid() WHERE question_id=$1',
        [q.id],
      ),
    );
    assert.equal(
      (await questionCall(client, admin, 'get', {}, q.id)).question.choices
        .length,
      2,
    );
  });
});

test('question pages sort by time and stable key even after a boundary is deleted', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    await client.query(
      "INSERT INTO questions(room_id,content,created_at) SELECT $1,'Question ' || n,'2026-10-25T00:00:00.123456Z'::timestamptz FROM generate_series(1,55) n",
      [admin.room.id],
    );
    const first = await questionCall(client, admin, 'list', {after: '0'});
    assert.equal(first.status, 200);
    assert.equal(first.questions.length, 50);
    assert(first.nextCursor.endsWith(`~${first.questions.at(-1).ordinal}`));
    assert(
      first.questions.every((q) => !('content' in q) && !('choices' in q)),
    );
    const boundary = first.questions.at(-1);
    assert.equal(
      (
        await questionCall(
          client,
          admin,
          'delete',
          {revision: boundary.revision},
          boundary.id,
        )
      ).status,
      200,
    );
    const second = await questionCall(client, admin, 'list', {
      after: first.nextCursor,
    });
    assert.equal(second.questions.length, 5);
    assert.equal(second.nextCursor, null);
    assert(
      !second.questions.some((q) =>
        first.questions.some((old) => old.id === q.id),
      ),
    );
    for (const after of [
      'bad',
      '2026-99-99T00:00:00.000000Z~1',
      '2026-10-25T00:00:00.000000Z~9223372036854775808',
    ])
      assert.equal(
        (await questionCall(client, admin, 'list', {after})).status,
        400,
      );
  });
});

test('question and option changes signal only after commit without source text', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const listener = new pg.Client({connectionString: databaseUrl});
    await listener.connect();
    const signals = [];
    listener.on('notification', (event) =>
      signals.push(JSON.parse(event.payload)),
    );
    try {
      await listener.query('LISTEN question_changes');
      await client.query('BEGIN');
      const q = (
        await questionCall(
          client,
          admin,
          'create',
          questionDocument({
            content: 'Private text',
            choices: [{content: 'Private option'}],
          }),
        )
      ).question;
      await delay(20);
      assert.equal(signals.length, 0);
      await client.query('COMMIT');
      for (let i = 0; i < 50 && !signals.length; i++) await delay(10);
      assert(signals.length > 0);
      assert(
        signals.every(
          (s) => s.roomId === admin.room.id && s.questionId === q.id,
        ),
      );
      assert(!JSON.stringify(signals).includes('Private'));
      assert.equal(signals.at(-1).revision, q.revision);
      const amount = signals.length;
      await client.query('BEGIN');
      await questionCall(
        client,
        admin,
        'save',
        {...q, content: 'Rolled back'},
        q.id,
      );
      await client.query('ROLLBACK');
      await delay(30);
      assert.equal(signals.length, amount);
      await questionCall(client, admin, 'delete', {revision: q.revision}, q.id);
      for (let i = 0; i < 50 && signals.length === amount; i++) await delay(10);
      assert.equal(signals.at(-1).deleted, true);
    } finally {
      await listener.end();
    }
  });
});

test('question rollback is atomic and preserves room and respondent access', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const key = linkItem();
    const [link] = await addLinks(client, admin, [key]);
    const session = await openLink(client, link, key.key);
    const q = (await questionCall(client, admin, 'create', questionDocument()))
      .question;
    await client.query(
      'CREATE TABLE outside_question_reference (question_id uuid REFERENCES questions(id))',
    );
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: total - 2}),
      {
        code: '2BP01',
      },
    );
    assert.equal(await migrationCount(client), total);
    assert.equal(
      (await questionCall(client, admin, 'get', {}, q.id)).status,
      200,
    );
    await client.query('DROP TABLE outside_question_reference');
    await runMigrations({databaseUrl, direction: 'down', count: total - 2});
    assert.equal(await linkAccess(client, link, session.session), 1);
    assert.equal(
      (
        await client.query('SELECT * FROM vm_admin_room($1,$2)', [
          admin.room.id,
          hash(admin.session),
        ])
      ).rowCount,
      1,
    );
    await runMigrations({databaseUrl});
    assert.deepEqual(
      (await questionCall(client, admin, 'list', {after: '0'})).questions,
      [],
    );
    assert.equal(await linkAccess(client, link, session.session), 1);
  });
});

// Use the same database media entry point as the server
async function assetCall(client, admin, action, data = {}, id = null) {
  return (
    await client.query('SELECT vm_asset_request($1,$2,$3,$4,$5) AS reply', [
      admin.room.id,
      hash(admin.session),
      id,
      action,
      JSON.stringify(data),
    ])
  ).rows[0].reply;
}
// A ready row models metadata already checked by the trusted media server
async function readyAsset(client, admin, mime = 'image/webp') {
  const asset = (await assetCall(client, admin, 'reserve', {bytes: 100})).asset;
  const finished = await assetCall(
    client,
    admin,
    'finish',
    {mime, width: 2, height: 2, bytes: 100, sha256: 'a'.repeat(64)},
    asset.id,
  );
  assert.equal(finished.status, 200);
  return finished.asset;
}
// Claim shared deletion jobs without holding locks during storage work
async function cleanupCall(client, action, data = {}) {
  return (
    await client.query('SELECT vm_asset_cleanup($1,$2) AS reply', [
      action,
      JSON.stringify(data),
    ])
  ).rows[0].reply;
}

test('media metadata, room access and dimensions are checked in PostgreSQL', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const other = await adminRoom(client);
    for (const bytes of [0, 10485761, '100'])
      assert.equal(
        (await assetCall(client, admin, 'reserve', {bytes})).status,
        400,
      );
    const asset = (await assetCall(client, admin, 'reserve', {bytes: 100}))
      .asset;
    assert.equal(
      (await assetCall(client, admin, 'get', {}, asset.id)).status,
      404,
    );
    for (const metadata of [
      {mime: 'image/svg+xml', width: 2, height: 2, bytes: 100},
      {mime: 'image/webp', width: 10000, height: 10000, bytes: 100},
      {mime: 'image/webp', width: 2, height: 2, bytes: 0},
    ])
      assert.equal(
        (
          await assetCall(
            client,
            admin,
            'finish',
            {...metadata, sha256: 'a'.repeat(64)},
            asset.id,
          )
        ).status,
        400,
      );
    assert.equal(
      (
        await assetCall(
          client,
          admin,
          'finish',
          {
            mime: 'image/webp',
            width: 2,
            height: 2,
            bytes: 100,
            sha256: 'a'.repeat(64),
          },
          asset.id,
        )
      ).status,
      200,
    );
    assert.equal(
      (await assetCall(client, other, 'get', {}, asset.id)).status,
      404,
    );
    assert.equal(
      (
        await assetCall(
          client,
          {...admin, session: other.session},
          'get',
          {},
          asset.id,
        )
      ).status,
      401,
    );
    assert.equal(
      (await assetCall(client, admin, 'keepalive', {ids: [asset.id]})).status,
      200,
    );
    assert.equal(
      (await assetCall(client, other, 'keepalive', {ids: [asset.id]})).status,
      404,
    );
    await assert.rejects(
      client.query("UPDATE assets SET mime='image/png' WHERE id=$1", [
        asset.id,
      ]),
      {code: '23514'},
    );
  });
});

test('media references stay within the room and keep their full option ownership', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const other = await adminRoom(client);
    const asset = await readyAsset(client, admin);
    const foreign = await readyAsset(client, other);
    const doc = questionDocument({
      content: `![Photo](asset:${asset.id})`,
      choices: [{content: `![Option](asset:${asset.id})`}],
      assetRefs: [
        {position: -1, assetId: asset.id},
        {position: 0, assetId: asset.id},
      ],
    });
    const reply = await questionCall(client, admin, 'create', doc);
    assert.equal(reply.status, 201);
    const q = reply.question;
    assert.equal(
      (
        await client.query(
          'SELECT count(*) FROM question_asset_refs WHERE question_id=$1',
          [q.id],
        )
      ).rows[0].count,
      '2',
    );
    assert.equal(
      (
        await client.query('SELECT unused_since FROM assets WHERE id=$1', [
          asset.id,
        ])
      ).rows[0].unused_since,
      null,
    );
    assert.equal(
      (
        await questionCall(
          client,
          admin,
          'save',
          {...q, assetRefs: [{position: -1, assetId: foreign.id}]},
          q.id,
        )
      ).status,
      409,
    );
    assert.deepEqual(
      (await questionCall(client, admin, 'get', {}, q.id)).question,
      q,
    );
    await assert.rejects(
      client.query(
        'INSERT INTO question_asset_refs(question_id,room_id,asset_id) VALUES($1,$2,$3)',
        [q.id, admin.room.id, foreign.id],
      ),
    );
    await assert.rejects(
      client.query(
        'UPDATE question_asset_refs SET asset_id=$1 WHERE question_id=$2',
        [foreign.id, q.id],
      ),
      {code: '23514'},
    );
    const after = await questionCall(
      client,
      admin,
      'save',
      {...q, content: 'Text', choices: [], assetRefs: []},
      q.id,
    );
    assert.equal(after.status, 200);
    assert.equal(
      (
        await client.query(
          'SELECT count(*) FROM question_asset_refs WHERE question_id=$1',
          [q.id],
        )
      ).rows[0].count,
      '0',
    );
    assert(
      (
        await client.query('SELECT unused_since FROM assets WHERE id=$1', [
          asset.id,
        ])
      ).rows[0].unused_since instanceof Date,
    );
  });
});

test('participant media access follows published content and current link sessions', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const other = await adminRoom(client);
    const asset = await readyAsset(client, admin, 'video/mp4');
    const unused = await readyAsset(client, admin);
    const foreign = await readyAsset(client, other);
    const q = (
      await questionCall(
        client,
        admin,
        'create',
        questionDocument({
          content: `![Video](asset:${asset.id})`,
          assetRefs: [{position: -1, assetId: asset.id}],
        }),
      )
    ).question;
    const key = linkItem();
    const [link] = await addLinks(client, admin, [key]);
    const opened = await openLink(client, link, key.key);
    // Query with real stored sessions, including their revocation generation
    async function access(id, session = opened.session) {
      return (
        await client.query('SELECT vm_participant_asset($1,$2,$3) AS reply', [
          link.id,
          hash(session),
          id,
        ])
      ).rows[0].reply;
    }
    assert.equal((await access(asset.id)).status, 404);
    await client.query("UPDATE questions SET state='open' WHERE id=$1", [q.id]);
    assert.equal((await access(asset.id)).status, 200);
    assert.equal((await access(unused.id)).status, 404);
    assert.equal((await access(foreign.id)).status, 404);
    await assert.rejects(
      client.query('DELETE FROM question_asset_refs WHERE question_id=$1', [
        q.id,
      ]),
      {code: '23514'},
    );
    assert.equal((await access(asset.id, admin.session)).status, 401);
    await editLink(client, admin, link, 'revoke');
    assert.equal((await access(asset.id)).status, 401);
  });
});

test('cleanup keeps references and grace periods, retries expired leases and rejects stale acknowledgements', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const used = await readyAsset(client, admin);
    const old = await readyAsset(client, admin);
    const fresh = await readyAsset(client, admin);
    const heartbeat = await readyAsset(client, admin);
    await questionCall(
      client,
      admin,
      'create',
      questionDocument({
        content: `![Photo](asset:${used.id})`,
        assetRefs: [{position: -1, assetId: used.id}],
      }),
    );
    await client.query(
      "UPDATE assets SET unused_since=statement_timestamp()-interval '25 hours' WHERE id=ANY($1::uuid[])",
      [[used.id, old.id, heartbeat.id]],
    );
    await assetCall(client, admin, 'keepalive', {ids: [heartbeat.id]});
    const jobs = (await cleanupCall(client, 'claim')).jobs;
    assert.deepEqual(
      jobs.map((job) => job.id),
      [old.id],
    );
    assert.equal(
      (await assetCall(client, admin, 'get', {}, old.id)).status,
      404,
    );
    assert.equal((await cleanupCall(client, 'claim')).jobs.length, 0);
    await client.query(
      "UPDATE assets SET cleanup_until=statement_timestamp()-interval '1 second' WHERE id=$1",
      [old.id],
    );
    const retried = (await cleanupCall(client, 'claim')).jobs[0];
    assert.notEqual(retried.token, jobs[0].token);
    await cleanupCall(client, 'ack', jobs[0]);
    assert.equal(
      (await client.query('SELECT count(*) FROM assets WHERE id=$1', [old.id]))
        .rows[0].count,
      '1',
    );
    await cleanupCall(client, 'ack', retried);
    assert.equal(
      (await client.query('SELECT count(*) FROM assets WHERE id=$1', [old.id]))
        .rows[0].count,
      '0',
    );
    for (const id of [used.id, fresh.id, heartbeat.id])
      assert.equal((await assetCall(client, admin, 'get', {}, id)).status, 200);
  });
});

test('concurrent attachment and cleanup cannot delete referenced media', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const second = new pg.Client({connectionString: databaseUrl});
    await second.connect();
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        const asset = await readyAsset(client, admin);
        await client.query(
          "UPDATE assets SET unused_since=statement_timestamp()-interval '25 hours' WHERE id=$1",
          [asset.id],
        );
        const [saved, claimed] = await Promise.all([
          questionCall(
            client,
            admin,
            'create',
            questionDocument({
              content: `![Photo](asset:${asset.id})`,
              assetRefs: [{position: -1, assetId: asset.id}],
            }),
          ),
          cleanupCall(second, 'claim'),
        ]);
        const row = (
          await client.query(
            'SELECT state,(SELECT count(*) FROM question_asset_refs WHERE asset_id=assets.id) AS refs FROM assets WHERE id=$1',
            [asset.id],
          )
        ).rows[0];
        assert(!(row.state === 'deleting' && row.refs !== '0'));
        if (saved.status === 201) {
          assert.equal(row.state, 'ready');
          assert.equal(row.refs, '1');
          assert(!claimed.jobs.some((job) => job.id === asset.id));
        } else {
          assert.equal(saved.status, 409);
          assert.equal(row.state, 'deleting');
        }
      }
    } finally {
      await second.end();
    }
  });
});

test('asset rollback restores the previous question entry point and failed rollback is atomic', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const asset = await readyAsset(client, admin);
    const q = (
      await questionCall(
        client,
        admin,
        'create',
        questionDocument({
          content: `![Photo](asset:${asset.id})`,
          assetRefs: [{position: -1, assetId: asset.id}],
        }),
      )
    ).question;
    await client.query(
      'CREATE TABLE outside_asset_reference(id uuid REFERENCES assets(id))',
    );
    await assert.rejects(runMigrations({databaseUrl, direction: 'down'}), {
      code: '2BP01',
    });
    assert.equal(await migrationCount(client), total);
    assert.equal(
      (await assetCall(client, admin, 'get', {}, asset.id)).status,
      200,
    );
    assert.equal(
      (await questionCall(client, admin, 'get', {}, q.id)).status,
      200,
    );
    await client.query('DROP TABLE outside_asset_reference');
    await runMigrations({databaseUrl, direction: 'down'});
    assert.equal(
      (
        await client.query(
          "SELECT to_regprocedure('vm_question_request_v6(uuid,bytea,uuid,text,jsonb)') AS name",
        )
      ).rows[0].name,
      null,
    );
    const current = (await questionCall(client, admin, 'get', {}, q.id))
      .question;
    assert.equal(
      (
        await questionCall(
          client,
          admin,
          'save',
          {...current, content: 'Kept text'},
          q.id,
        )
      ).status,
      200,
    );
    await runMigrations({databaseUrl});
    assert.equal(
      (await client.query('SELECT count(*) FROM assets')).rows[0].count,
      '0',
    );
    assert.equal(
      (await questionCall(client, admin, 'get', {}, q.id)).question.content,
      'Kept text',
    );
  });
});
