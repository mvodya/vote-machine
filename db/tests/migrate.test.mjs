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

// Keep synthetic upgrades after every real migration
const fixtureStamp = Math.max(
  ...(await readdir(source))
    .filter((file) => file.endsWith('.mjs'))
    .map((file) => Number(file.split('-')[0])),
);

// Keep a migration's rollback checks stable when later migrations are added
async function rollbackFrom(databaseUrl, first) {
  const count = (await readdir(source)).filter(
    (name) => name.endsWith('.mjs') && name >= first,
  ).length;
  return runMigrations({databaseUrl, direction: 'down', count});
}

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
        `${fixtureStamp + 10}-upgrade`,
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
        `${fixtureStamp + 10}-probe`,
        'CREATE TABLE migration_probe (id integer); INSERT INTO migration_probe VALUES (1);',
      );
      await addMigration(
        dir,
        `${fixtureStamp + 11}-failure`,
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
        `${fixtureStamp + 11}-failure`,
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
        `${fixtureStamp + 10}-time-zone`,
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
      (
        await client.query(
          "SELECT to_regprocedure('vm_voting_entry(uuid,bytea)') IS NULL AS name",
        )
      ).rows[0].name,
      false,
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
    hideUntilOpen: false,
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
    await lockQuestionEdits(client, admin);
    let policy = (await questionCall(client, admin, 'policy')).policy;
    assert.equal(policy.lockAfterOpen, true);
    let q = (
      await questionCall(
        client,
        admin,
        'create',
        questionDocument({
          content: 'Choose',
          choices: [{content: 'A'}, {content: 'B'}],
        }),
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
      (await questionCall(client, admin, 'delete', {revision: '0'}, q.id))
        .status,
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
        questionDocument({
          content: 'Editable',
          choices: [{content: 'A'}, {content: 'B'}],
        }),
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
          {revision: '0'},
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
      'UPDATE questions SET min_choices=-1 WHERE id=$1',
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
    await lockQuestionEdits(client, admin);
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
          choices: [{content: 'A'}, {content: 'B'}],
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
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: total - 3}),
      {
        code: '2BP01',
      },
    );
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
    await runMigrations({databaseUrl, direction: 'down', count: total - 3});
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

// Use the real lifecycle entry point for versioned state changes
async function lifecycle(client, admin, question, action, extra = {}) {
  return (
    await client.query('SELECT vm_question_lifecycle($1,$2,$3,$4) AS reply', [
      admin.room.id,
      hash(admin.session),
      question.id,
      JSON.stringify({action, revision: question.revision, ...extra}),
    ])
  ).rows[0].reply;
}
// Build a draft that may be opened without extra edits
async function readyQuestion(client, admin, extra = {}) {
  return (
    await questionCall(
      client,
      admin,
      'create',
      questionDocument({
        content: 'Choose',
        choices: [{content: 'A'}, {content: 'B'}],
        ...extra,
      }),
    )
  ).question;
}

test('lifecycle rejects empty drafts, foreign rooms and stale versions', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const other = await adminRoom(client);
    const empty = (
      await questionCall(client, admin, 'create', questionDocument())
    ).question;
    assert.equal((await lifecycle(client, admin, empty, 'open')).status, 400);
    const q = await readyQuestion(client, admin);
    assert.equal((await lifecycle(client, other, q, 'open')).status, 404);
    const opened = await lifecycle(client, admin, q, 'open');
    assert.equal(opened.status, 200);
    assert.equal(opened.question.editLocked, false);
    assert.equal((await lifecycle(client, admin, q, 'close')).status, 409);
    assert.equal(
      (await lifecycle(client, admin, opened.question, 'close')).question
        .closedReason,
      'manual',
    );
  });
});

test('deadline closes effective reads before the worker and reopening needs a new deadline', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const q = await readyQuestion(client, admin);
    const opened = await lifecycle(client, admin, q, 'open', {
      closesAt: new Date(Date.now() + 120).toISOString(),
    });
    assert.equal(opened.status, 200);
    await client.query('SELECT pg_sleep(0.15)');
    assert.equal(
      (await client.query('SELECT state FROM questions WHERE id=$1', [q.id]))
        .rows[0].state,
      'open',
    );
    assert.equal(
      (await questionCall(client, admin, 'get', {}, q.id)).question.state,
      'closed',
    );
    assert.equal(
      (await questionCall(client, admin, 'list', {after: '0'})).questions[0]
        .state,
      'closed',
    );
    assert.equal(
      (await client.query('SELECT vm_close_due() AS count')).rows[0].count,
      1,
    );
    const closed = (await questionCall(client, admin, 'get', {}, q.id))
      .question;
    assert.equal(closed.closedReason, 'deadline');
    assert.equal((await lifecycle(client, admin, closed, 'open')).status, 409);
    assert.equal(
      (await lifecycle(client, admin, closed, 'open', {closesAt: null}))
        .question.state,
      'open',
    );
  });
});

test('deadline edits and publication work with locked content and reject timezone-free dates', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    let q = (
      await lifecycle(client, admin, await readyQuestion(client, admin), 'open')
    ).question;
    assert.equal(
      (
        await lifecycle(client, admin, q, 'settings', {
          closesAt: '2027-01-01T10:00',
          shareResults: true,
          publication: 'after_close',
        })
      ).status,
      400,
    );
    q = (
      await lifecycle(client, admin, q, 'settings', {
        closesAt: '2027-01-01T10:00:00+10:00',
        shareResults: true,
        publication: 'after_answer',
      })
    ).question;
    assert.equal(
      new Date(q.closesAt).toISOString(),
      '2027-01-01T00:00:00.000Z',
    );
    assert.equal(q.shareResults, true);
    q = (
      await lifecycle(client, admin, q, 'settings', {
        closesAt: '2020-01-01T00:00:00Z',
        shareResults: false,
        publication: 'after_close',
      })
    ).question;
    assert.equal(q.state, 'closed');
    assert.equal(q.closedReason, 'deadline');
  });
});

test('two deadline workers close each overdue question only once', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    await lifecycle(client, admin, await readyQuestion(client, admin), 'open', {
      closesAt: new Date(Date.now() + 120).toISOString(),
    });
    await client.query('SELECT pg_sleep(0.15)');
    const second = new pg.Client({connectionString: databaseUrl});
    await second.connect();
    try {
      const results = await Promise.all([
        client.query('SELECT vm_close_due() AS count'),
        second.query('SELECT vm_close_due() AS count'),
      ]);
      assert.equal(
        results.reduce((sum, result) => sum + result.rows[0].count, 0),
        1,
      );
    } finally {
      await second.end();
    }
  });
});

test('lifecycle rollback fails atomically and reapplies with existing questions', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const q = await readyQuestion(client, admin);
    await client.query(
      'CREATE VIEW outside_deadline AS SELECT closes_at FROM questions',
    );
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: total - 4}),
      {
        code: '2BP01',
      },
    );
    assert.equal(await migrationCount(client), total);
    assert.equal(
      (await questionCall(client, admin, 'get', {}, q.id)).question.id,
      q.id,
    );
    await client.query('DROP VIEW outside_deadline');
    await runMigrations({databaseUrl, direction: 'down', count: total - 4});
    await runMigrations({databaseUrl});
    const current = (await questionCall(client, admin, 'get', {}, q.id))
      .question;
    assert.equal((await lifecycle(client, admin, current, 'open')).status, 200);
  });
});

// Opt into the locked policy for checks that need a fixed question
async function lockQuestionEdits(client, admin) {
  const policy = (await questionCall(client, admin, 'policy')).policy;
  assert.equal(
    (
      await questionCall(client, admin, 'setPolicy', {
        ...policy,
        lockAfterOpen: true,
      })
    ).status,
    200,
  );
}

// Give each vote check real personal access and an open question
async function personalFixture(client, extra = {}, editable) {
  const admin = await adminRoom(client);
  if (editable === false) await lockQuestionEdits(client, admin);
  const question = (
    await lifecycle(
      client,
      admin,
      await readyQuestion(client, admin, extra),
      'open',
    )
  ).question;
  const key = linkItem();
  const [link] = await addLinks(client, admin, [key]);
  const {session} = await openLink(client, link, key.key);
  return {admin, question, link, session};
}
// Preserve the request body when checking a retry
function ballotInput(question, extra = {}) {
  return {
    requestId: randomUUID(),
    questionRevision: question.revision,
    ballotRevision: '0',
    choices: [question.choices[0].id],
    ...extra,
  };
}
// Submit through the same atomic entry point used by the API
async function cast(client, fixture, body) {
  return (
    await client.query('SELECT vm_cast_personal($1,$2,$3,$4) AS reply', [
      fixture.link.id,
      hash(fixture.session),
      fixture.question.id,
      JSON.stringify(body),
    ])
  ).rows[0].reply;
}

test('personal votes are idempotent after close and reject a changed retry payload', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const body = ballotInput(f.question);
    const first = await cast(client, f, body);
    assert.equal(first.status, 200);
    assert.deepEqual(await cast(client, f, body), first);
    assert.equal(
      (await cast(client, f, {...body, choices: [f.question.choices[1].id]}))
        .error,
      'idempotency',
    );
    assert.equal(
      (await cast(client, f, ballotInput(f.question))).error,
      'used',
    );
    await lifecycle(client, f.admin, f.question, 'close');
    assert.deepEqual(await cast(client, f, body), first);
    assert.equal(
      (await cast(client, f, ballotInput(f.question))).error,
      'closed',
    );
    assert.equal(
      (await client.query('SELECT count(*) FROM ballots')).rows[0].count,
      '1',
    );
  });
});

test('personal vote races consume one right and optimistic answer edits keep one ballot', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const second = new pg.Client({connectionString: databaseUrl});
    await second.connect();
    try {
      const race = await Promise.all([
        cast(client, f, ballotInput(f.question)),
        cast(second, f, ballotInput(f.question)),
      ]);
      assert.deepEqual(race.map((reply) => reply.status).sort(), [200, 409]);
      const g = await personalFixture(client, {allowAnswerChange: true});
      const first = await cast(client, g, ballotInput(g.question));
      const edits = await Promise.all([
        cast(
          client,
          g,
          ballotInput(g.question, {
            ballotRevision: first.answer.revision,
            choices: [g.question.choices[1].id],
          }),
        ),
        cast(
          second,
          g,
          ballotInput(g.question, {ballotRevision: first.answer.revision}),
        ),
      ]);
      assert.deepEqual(edits.map((reply) => reply.status).sort(), [200, 409]);
      assert.equal(
        (
          await client.query(
            'SELECT count(*) FROM ballots WHERE question_id=$1',
            [g.question.id],
          )
        ).rows[0].count,
        '1',
      );
    } finally {
      await second.end();
    }
  });
});

test('votes reject wrong-room choices, duplicate choices, stale questions and revoked sessions', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const g = await personalFixture(client);
    assert.equal(
      (
        await cast(
          client,
          f,
          ballotInput(f.question, {choices: [g.question.choices[0].id]}),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await cast(
          client,
          f,
          ballotInput(f.question, {
            choices: [f.question.choices[0].id, f.question.choices[0].id],
          }),
        )
      ).status,
      400,
    );
    assert.equal(
      (await cast(client, f, ballotInput(f.question, {questionRevision: '0'})))
        .error,
      'changed',
    );
    assert.equal(
      (
        await cast(
          client,
          {...f, question: g.question},
          ballotInput(g.question),
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await cast(
          client,
          {...f, session: f.admin.session},
          ballotInput(f.question),
        )
      ).status,
      401,
    );
    await editLink(client, f.admin, f.link, 'revoke');
    assert.equal((await cast(client, f, ballotInput(f.question))).status, 401);
    assert.equal(
      (await client.query('SELECT count(*) FROM ballots')).rows[0].count,
      '0',
    );
  });
});

test('link rotation and reopening preserve a consumed personal right', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    assert.equal((await cast(client, f, ballotInput(f.question))).status, 200);
    const key = linkItem();
    await editLink(client, f.admin, f.link, 'rotate', key);
    assert.equal((await cast(client, f, ballotInput(f.question))).status, 401);
    f.session = (await openLink(client, f.link, key.key)).session;
    let q = (await lifecycle(client, f.admin, f.question, 'close')).question;
    q = (await lifecycle(client, f.admin, q, 'open')).question;
    f.question = q;
    assert.equal((await cast(client, f, ballotInput(q))).error, 'used');
    assert.equal(
      (await client.query('SELECT count(*) FROM ballots')).rows[0].count,
      '1',
    );
  });
});

test('a vote waiting for a lock cannot pass an elapsed database deadline', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    f.question = (
      await lifecycle(client, f.admin, f.question, 'settings', {
        closesAt: new Date(Date.now() + 160).toISOString(),
        shareResults: false,
        publication: 'after_close',
      })
    ).question;
    const second = new pg.Client({connectionString: databaseUrl});
    await second.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM rooms WHERE id=$1 FOR UPDATE', [
        f.admin.room.id,
      ]);
      const pending = cast(second, f, ballotInput(f.question));
      await client.query('SELECT pg_sleep(0.2)');
      await client.query('COMMIT');
      assert.equal((await pending).error, 'closed');
      assert.equal(
        (await client.query('SELECT count(*) FROM ballots')).rows[0].count,
        '0',
      );
    } finally {
      await client.query('ROLLBACK');
      await second.end();
    }
  });
});

test('close versus vote is atomic and later votes are rejected', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const second = new pg.Client({connectionString: databaseUrl});
    await second.connect();
    try {
      const results = await Promise.all([
        cast(client, f, ballotInput(f.question)),
        lifecycle(second, f.admin, f.question, 'close'),
      ]);
      assert.equal(results[1].status, 200);
      assert([200, 409].includes(results[0].status));
      assert.equal(
        (await cast(client, f, ballotInput(f.question))).error,
        'closed',
      );
      assert(
        Number(
          (await client.query('SELECT count(*) FROM ballots')).rows[0].count,
        ) <= 1,
      );
    } finally {
      await second.end();
    }
  });
});

test('database constraints protect selections and used options while editable text keeps votes', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(
      client,
      {choiceMode: 'multiple', maxChoices: 2, allowAnswerChange: true},
      true,
    );
    const result = await cast(
      client,
      f,
      ballotInput(f.question, {
        choices: f.question.choices.map((choice) => choice.id),
      }),
    );
    assert.equal(result.status, 200);
    await assert.rejects(
      client.query('DELETE FROM question_options WHERE id=$1', [
        f.question.choices[0].id,
      ]),
      {code: '23001'},
    );
    await client.query('BEGIN');
    await client.query('DELETE FROM ballot_choices WHERE ballot_id=$1', [
      result.answer.id,
    ]);
    await assert.rejects(client.query('COMMIT'), {code: '23514'});
    await client.query('ROLLBACK');
    assert.equal(
      (
        await questionCall(
          client,
          f.admin,
          'save',
          {...f.question, choices: [f.question.choices[1]], maxChoices: 1},
          f.question.id,
        )
      ).error,
      'used_options',
    );
    assert.equal(
      (
        await questionCall(
          client,
          f.admin,
          'save',
          {...f.question, maxChoices: 1},
          f.question.id,
        )
      ).error,
      'ballots',
    );
    assert.equal(
      (
        await questionCall(
          client,
          f.admin,
          'save',
          {
            ...f.question,
            content: 'Updated',
            choices: [...f.question.choices].reverse(),
          },
          f.question.id,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await client.query(
          'SELECT count(*) FROM ballot_choices WHERE ballot_id=$1',
          [result.answer.id],
        )
      ).rows[0].count,
      '2',
    );
  });
});

test('ballot rollback is atomic and reapply preserves rooms, questions and access', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const {answer} = await cast(client, f, ballotInput(f.question));
    await client.query(
      'CREATE TABLE outside_ballot_reference(id uuid REFERENCES ballots(id))',
    );
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: total - 5}),
      {
        code: '2BP01',
      },
    );
    assert.equal(await migrationCount(client), total);
    assert.equal(
      (await client.query('SELECT id FROM ballots')).rows[0].id,
      answer.id,
    );
    await client.query('DROP TABLE outside_ballot_reference');
    await runMigrations({databaseUrl, direction: 'down', count: total - 5});
    await runMigrations({databaseUrl});
    f.question = (
      await questionCall(client, f.admin, 'get', {}, f.question.id)
    ).question;
    assert.equal((await cast(client, f, ballotInput(f.question))).status, 200);
  });
});

// Read a personal snapshot through the real access function
async function journey(client, fixture, data = {}) {
  return (
    await client.query('SELECT vm_participant_journey($1,$2,$3) AS reply', [
      fixture.link.id,
      hash(fixture.session),
      JSON.stringify({after: '0', ...data}),
    ])
  ).rows[0].reply;
}
// Add a later question in the same room
async function laterQuestion(client, fixture, extra = {}) {
  return (
    await lifecycle(
      client,
      fixture.admin,
      await readyQuestion(client, fixture.admin, extra),
      'open',
    )
  ).question;
}

test('required questions block both navigation and direct later votes', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const later = await laterQuestion(client, f, {content: 'Later'});
    const first = await journey(client, f);
    assert.equal(first.current.id, f.question.id);
    assert.equal(first.current.allowSkip, false);
    assert.equal(first.questions[1].canChoose, false);
    assert.equal(
      (await journey(client, f, {selected: later.id})).current.id,
      f.question.id,
    );
    assert.equal(
      (await journey(client, f, {skip: f.question.id})).error,
      'skip',
    );
    assert.equal(
      (await cast(client, {...f, question: later}, ballotInput(later))).error,
      'sequence',
    );
    assert.equal((await cast(client, f, ballotInput(f.question))).status, 200);
    assert.equal((await journey(client, f)).current.id, later.id);
  });
});

test('skip is an explicit question setting, does not vote and may be changed in lifecycle settings', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {allowSkip: true});
    const later = await laterQuestion(client, f);
    assert.equal(f.question.allowSkip, true);
    assert.equal(
      (await journey(client, f, {skip: f.question.id})).current.id,
      later.id,
    );
    assert.equal(
      (await journey(client, f, {selected: later.id})).current.id,
      later.id,
    );
    assert.equal(
      (await client.query('SELECT count(*) FROM ballots')).rows[0].count,
      '0',
    );
    f.question = (
      await lifecycle(client, f.admin, f.question, 'settings', {
        allowSkip: false,
        shareResults: false,
        publication: 'after_close',
      })
    ).question;
    assert.equal(f.question.allowSkip, false);
    assert.equal(
      (await journey(client, f, {selected: later.id})).current.id,
      f.question.id,
    );
    assert.equal(
      (
        await lifecycle(client, f.admin, f.question, 'settings', {
          allowSkip: 'yes',
          shareResults: false,
          publication: 'after_close',
        })
      ).status,
      400,
    );
  });
});

test('own history keeps closed content and answers without other respondents or draft content', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {
      anonymous: true,
      allowAnswerChange: true,
    });
    const saved = await cast(client, f, ballotInput(f.question));
    const later = await laterQuestion(client, f, {content: 'Later'});
    await questionCall(
      client,
      f.admin,
      'create',
      questionDocument({content: 'Private draft'}),
    );
    f.question = (
      await lifecycle(client, f.admin, f.question, 'close')
    ).question;
    const snapshot = await journey(client, f);
    assert.equal(snapshot.current.id, later.id);
    assert.equal(snapshot.progress.pending, 1);
    const history = await journey(client, f, {selected: f.question.id});
    assert.equal(history.current.state, 'closed');
    assert.equal(history.current.anonymous, true);
    assert.deepEqual(history.answer, saved.answer);
    assert(!JSON.stringify(history).includes('Private draft'));
    assert(!('linkId' in history.answer));
    assert(!('name' in history.answer));
  });
});

test('the same old session sees new questions after waiting and cannot access a foreign question', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const other = await personalFixture(client);
    await cast(client, f, ballotInput(f.question));
    assert.equal((await journey(client, f)).current, null);
    await client.query(
      "UPDATE voting_sessions SET created_at=clock_timestamp()-interval '100 years' WHERE secret_hash=$1",
      [hash(f.session)],
    );
    const next = await laterQuestion(client, f, {content: 'Next day'});
    assert.equal((await journey(client, f)).current.id, next.id);
    const snapshot = await journey(client, f, {selected: other.question.id});
    assert.equal(snapshot.current.id, next.id);
    assert(snapshot.questions.every((item) => item.roomId === f.admin.room.id));
    await editLink(client, f.admin, f.link, 'revoke');
    assert.equal((await journey(client, f)).status, 401);
  });
});

test('participant pages use stable metadata cursors while the active question stays independent', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {allowSkip: true});
    for (let i = 0; i < 50; i++)
      await laterQuestion(client, f, {
        content: `Question ${i}`,
        allowSkip: true,
      });
    const first = await journey(client, f);
    assert.equal(first.questions.length, 50);
    assert(first.nextCursor);
    const second = await journey(client, f, {after: first.nextCursor});
    assert.equal(second.questions.length, 1);
    assert.equal(second.current.id, f.question.id);
    assert.equal(second.nextCursor, null);
  });
});

test('closed media stays available only through the owners own answer history', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {}, true);
    const asset = await readyAsset(client, f.admin);
    f.question = (
      await questionCall(
        client,
        f.admin,
        'save',
        {
          ...f.question,
          content: `![Photo](asset:${asset.id})`,
          assetRefs: [{position: -1, assetId: asset.id}],
        },
        f.question.id,
      )
    ).question;
    const key = linkItem();
    const [other] = await addLinks(client, f.admin, [key]);
    const otherSession = (await openLink(client, other, key.key)).session;
    await cast(client, f, ballotInput(f.question));
    await lifecycle(client, f.admin, f.question, 'close');
    assert.equal(
      (
        await client.query('SELECT vm_participant_asset($1,$2,$3) AS reply', [
          f.link.id,
          hash(f.session),
          asset.id,
        ])
      ).rows[0].reply.status,
      200,
    );
    assert.equal(
      (
        await client.query('SELECT vm_participant_asset($1,$2,$3) AS reply', [
          other.id,
          hash(otherSession),
          asset.id,
        ])
      ).rows[0].reply.status,
      404,
    );
  });
});

test('journey rollback is atomic and restores earlier voting functions before reapply', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    await client.query(
      'CREATE VIEW outside_skip AS SELECT allow_skip FROM questions',
    );
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: total - 6}),
      {
        code: '2BP01',
      },
    );
    assert.equal(await migrationCount(client), total);
    assert.equal((await journey(client, f)).current.id, f.question.id);
    await client.query('DROP VIEW outside_skip');
    await runMigrations({databaseUrl, direction: 'down', count: total - 6});
    assert.equal((await cast(client, f, ballotInput(f.question))).status, 200);
    await runMigrations({databaseUrl});
    assert.equal((await journey(client, f)).current, null);
  });
});

// Save the workspace document through the same atomic entry point
async function workspaceSave(client, admin, question, extra = {}) {
  return questionCall(
    client,
    admin,
    question ? 'save' : 'create',
    {
      ...(question ??
        questionDocument({
          content: 'Choose',
          choices: [{content: 'A'}, {content: 'B'}],
        })),
      state: question?.state ?? 'draft',
      deadlineMode: question?.deadlineMode ?? 'none',
      ...extra,
    },
    question?.id ?? null,
  );
}
// Change a room zone with real admin access
async function roomZone(client, admin, data) {
  return (
    await client.query('SELECT vm_room_time_zone($1,$2,$3) AS reply', [
      admin.room.id,
      hash(admin.session),
      JSON.stringify(data),
    ])
  ).rows[0].reply;
}

test('room time zones initialize once and stay shared across participant snapshots', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    let reply = await roomZone(client, f.admin, {
      timeZone: 'Asia/Vladivostok',
      initialize: true,
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.room.timeZone, 'Asia/Vladivostok');
    const other = await roomZone(client, f.admin, {
      timeZone: 'Europe/Berlin',
      initialize: true,
    });
    assert.equal(other.room.timeZone, 'Asia/Vladivostok');
    assert.equal(
      (
        await roomZone(client, f.admin, {
          timeZone: 'bad/zone',
          revision: reply.room.revision,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await roomZone(client, f.admin, {
          timeZone: 'Europe/Berlin',
          revision: '0',
        })
      ).status,
      409,
    );
    reply = await roomZone(client, f.admin, {
      timeZone: 'Europe/Berlin',
      revision: reply.room.revision,
    });
    assert.equal((await journey(client, f)).timeZone, 'Europe/Berlin');
    assert.equal(
      (
        await roomZone(
          client,
          {...f.admin, session: f.session},
          {timeZone: 'UTC', initialize: true},
        )
      ).status,
      401,
    );
    await assert.rejects(
      client.query("UPDATE rooms SET time_zone='bad/zone' WHERE id=$1", [
        f.admin.room.id,
      ]),
      {code: '23514'},
    );
  });
});

test('two first admin entries cannot choose different room zones', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const second = new pg.Client({connectionString: databaseUrl});
    await second.connect();
    try {
      const replies = await Promise.all([
        roomZone(client, admin, {timeZone: 'Asia/Tokyo', initialize: true}),
        roomZone(second, admin, {
          timeZone: 'America/New_York',
          initialize: true,
        }),
      ]);
      assert(replies.every((reply) => reply.status === 200));
      assert.equal(replies[0].room.timeZone, replies[1].room.timeZone);
    } finally {
      await second.end();
    }
  });
});

test('workspace saves content, settings and opening atomically and rejects partial invalid opens', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    await lockQuestionEdits(client, admin);
    const invalid = await workspaceSave(client, admin, null, {
      content: 'Partial',
      choices: [{content: 'A'}, {content: ''}],
      state: 'open',
      shareResults: true,
    });
    assert.equal(invalid.status, 400);
    assert.equal(
      (await client.query('SELECT count(*) FROM questions')).rows[0].count,
      '0',
    );
    let q = (await workspaceSave(client, admin, null)).question;
    const failed = await workspaceSave(client, admin, q, {
      content: 'Partial',
      choices: [q.choices[0], {...q.choices[1], content: ''}],
      state: 'open',
      shareResults: true,
    });
    assert.equal(failed.status, 400);
    assert.deepEqual(
      (await questionCall(client, admin, 'get', {}, q.id)).question,
      q,
    );
    q = (
      await workspaceSave(client, admin, q, {
        content: 'Opened',
        state: 'open',
        shareResults: true,
        allowSkip: true,
      })
    ).question;
    assert.equal(q.state, 'open');
    assert.equal(q.editLocked, true);
    assert.equal(q.shareResults, true);
    assert.equal(q.allowSkip, true);
    const updated = await workspaceSave(client, admin, q, {
      publication: 'after_answer',
      allowSkip: false,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.question.publication, 'after_answer');
    assert.equal(
      (
        await workspaceSave(client, admin, updated.question, {
          content: 'Forbidden',
        })
      ).status,
      409,
    );
  });
});

test('relative deadlines start at each opening and remain inactive in a draft', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    let q = (
      await workspaceSave(client, admin, null, {
        deadlineMode: 'duration',
        closeAfterSeconds: 60,
      })
    ).question;
    assert.equal(q.closesAt, null);
    assert.equal(q.closeAfterSeconds, 60);
    q = (await lifecycle(client, admin, q, 'open')).question;
    assert.equal(Date.parse(q.closesAt) - Date.parse(q.openedAt), 60000);
    const first = q.openedAt;
    q = (await lifecycle(client, admin, q, 'close')).question;
    await client.query('SELECT pg_sleep(0.03)');
    q = (await lifecycle(client, admin, q, 'open')).question;
    assert(Date.parse(q.openedAt) > Date.parse(first));
    assert.equal(Date.parse(q.closesAt) - Date.parse(q.openedAt), 60000);
  });
});

test('returning to draft hides answers with erased answers and preserved opening promises', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {}, false);
    await cast(client, f, ballotInput(f.question));
    f.question = (
      await client.query('SELECT vm_reset_question($1,$2,$3,$4) AS reply', [
        f.admin.room.id,
        hash(f.admin.session),
        f.question.id,
        JSON.stringify({revision: f.question.revision}),
      ])
    ).rows[0].reply.question;
    assert.equal(f.question.state, 'draft');
    assert.equal(f.question.editLocked, true);
    assert.equal((await journey(client, f)).questions.length, 0);
    assert.equal(
      (
        await client.query('SELECT vm_personal_answer($1,$2,$3) AS reply', [
          f.link.id,
          hash(f.session),
          f.question.id,
        ])
      ).rows[0].reply.status,
      404,
    );
    f.question = (
      await workspaceSave(client, f.admin, f.question, {state: 'open'})
    ).question;
    assert.equal((await cast(client, f, ballotInput(f.question))).status, 200);
    assert.equal(
      (await client.query('SELECT count(*) FROM ballots')).rows[0].count,
      '1',
    );
  });
});

test('any question can be deleted with its ballots, retry records and media references', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {}, true);
    const asset = await readyAsset(client, f.admin);
    f.question = (
      await workspaceSave(client, f.admin, f.question, {
        content: `![Photo](asset:${asset.id})`,
        assetRefs: [{position: -1, assetId: asset.id}],
      })
    ).question;
    await cast(client, f, ballotInput(f.question));
    const result = await questionCall(
      client,
      f.admin,
      'delete',
      {revision: f.question.revision},
      f.question.id,
    );
    assert.equal(result.status, 200);
    for (const table of [
      'questions',
      'question_options',
      'ballots',
      'ballot_choices',
      'vote_requests',
      'question_asset_refs',
    ])
      assert.equal(
        (await client.query(`SELECT count(*) FROM ${table}`)).rows[0].count,
        '0',
      );
    assert(
      (
        await client.query('SELECT unused_since FROM assets WHERE id=$1', [
          asset.id,
        ])
      ).rows[0].unused_since instanceof Date,
    );
    assert.equal(
      (await questionCall(client, f.admin, 'get', {}, f.question.id)).status,
      404,
    );
    assert.equal((await cast(client, f, ballotInput(f.question))).status, 404);
    assert.equal((await journey(client, f)).questions.length, 0);
    for (const state of ['draft', 'closed']) {
      const q = (await workspaceSave(client, f.admin, null, {state})).question;
      assert.equal(
        (
          await questionCall(
            client,
            f.admin,
            'delete',
            {revision: q.revision},
            q.id,
          )
        ).status,
        200,
      );
    }
  });
});

test('delete and vote races leave no orphan ballot or acknowledged retry record', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const second = new pg.Client({connectionString: databaseUrl});
    await second.connect();
    try {
      const results = await Promise.all([
        cast(client, f, ballotInput(f.question)),
        questionCall(
          second,
          f.admin,
          'delete',
          {revision: f.question.revision},
          f.question.id,
        ),
      ]);
      assert.equal(results[1].status, 200);
      assert([200, 404].includes(results[0].status));
      assert.equal(
        (await client.query('SELECT count(*) FROM ballots')).rows[0].count,
        '0',
      );
      assert.equal(
        (await client.query('SELECT count(*) FROM vote_requests')).rows[0]
          .count,
        '0',
      );
    } finally {
      await second.end();
    }
  });
});

test('workspace rollback and a blocked deletion both preserve data atomically', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const result = await cast(client, f, ballotInput(f.question));
    await client.query(
      'CREATE TABLE outside_ballot(id uuid REFERENCES ballots(id))',
    );
    await client.query('INSERT INTO outside_ballot VALUES($1)', [
      result.answer.id,
    ]);
    await assert.rejects(
      questionCall(
        client,
        f.admin,
        'delete',
        {revision: f.question.revision},
        f.question.id,
      ),
    );
    assert.equal(
      (await client.query('SELECT deleting FROM questions')).rows[0].deleting,
      false,
    );
    assert.equal(
      (await client.query('SELECT count(*) FROM ballot_choices')).rows[0].count,
      '1',
    );
    await client.query('DROP TABLE outside_ballot');
    await client.query(
      'CREATE VIEW outside_zone AS SELECT time_zone FROM rooms',
    );
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: total - 7}),
      {
        code: '2BP01',
      },
    );
    assert.equal(await migrationCount(client), total);
    assert.equal(
      (await questionCall(client, f.admin, 'get', {}, f.question.id)).question
        .state,
      'open',
    );
    await client.query('DROP VIEW outside_zone');
    await runMigrations({databaseUrl, direction: 'down', count: total - 7});
    await runMigrations({databaseUrl});
    assert.equal(
      (await client.query('SELECT count(*) FROM ballots')).rows[0].count,
      '1',
    );
    assert.equal((await journey(client, f)).answer, null);
  });
});

// Give each repeat check an independent browser session and automatic first run
async function reusableFixture(client, extra = {}) {
  const admin = await adminRoom(client);
  const question = (
    await lifecycle(
      client,
      admin,
      await readyQuestion(client, admin, extra),
      'open',
    )
  ).question;
  const key = linkItem('Shared', 'reusable');
  const [link] = await addLinks(client, admin, [key]);
  const {session} = await openLink(client, link, key.key);
  const f = {admin, question, link, session, key};
  const snapshot = await journey(client, f);
  return {...f, run: snapshot.run};
}
// Keep a repeated run request stable across retries
async function startRun(client, f, id = randomUUID()) {
  return (
    await client.query('SELECT vm_begin_run($1,$2,$3) AS reply', [
      f.link.id,
      hash(f.session),
      id,
    ])
  ).rows[0].reply;
}
// Use real role checks for all new ballot sources
async function generalCast(client, f, data, manual = false) {
  return (
    await client.query('SELECT vm_cast_ballot($1,$2,$3,$4,$5,$6) AS reply', [
      manual ? f.admin.room.id : null,
      manual ? null : f.link.id,
      hash(manual ? f.admin.session : f.session),
      manual,
      f.question.id,
      JSON.stringify(data),
    ])
  ).rows[0].reply;
}

test('reusable links start independently without a button and repeats require the room setting', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await reusableFixture(client);
    assert(f.run.id);
    assert.equal((await journey(client, f)).run.id, f.run.id);
    assert.equal((await startRun(client, f)).error, 'repeat');
    const second = {
      ...f,
      session: (await openLink(client, f.link, f.key.key)).session,
    };
    assert.notEqual((await journey(client, second)).run.id, f.run.id);
    assert.equal((await journey(client, second, {run: f.run.id})).status, 404);
    await client.query(
      'UPDATE rooms SET allow_reusable_repeat=true WHERE id=$1',
      [f.admin.room.id],
    );
    const id = randomUUID();
    assert.equal((await startRun(client, f, id)).run.id, id);
    assert.equal((await startRun(client, f, id)).run.id, id);
  });
});

test('reusable run ballots are unique, retry safe and can add a later explicit vote', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await reusableFixture(client);
    const input = ballotInput(f.question, {runId: f.run.id});
    const first = await generalCast(client, f, input);
    assert.equal(first.status, 200);
    assert.deepEqual(await generalCast(client, f, input), first);
    assert.equal(
      (
        await generalCast(client, f, {
          ...input,
          choices: [f.question.choices[1].id],
        })
      ).error,
      'idempotency',
    );
    assert.equal(
      (await generalCast(client, f, ballotInput(f.question, {runId: f.run.id})))
        .error,
      'used',
    );
    await client.query(
      'UPDATE rooms SET allow_reusable_repeat=true WHERE id=$1',
      [f.admin.room.id],
    );
    const next = (await startRun(client, f)).run;
    assert.equal(
      (await generalCast(client, f, ballotInput(f.question, {runId: next.id})))
        .status,
      200,
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*) FROM ballots WHERE source='reusable'",
        )
      ).rows[0].count,
      '2',
    );
  });
});

test('manual ballots add new votes and a manual personal entry consumes the same personal right', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const input = ballotInput(f.question);
    const first = await generalCast(client, f, input, true);
    assert.equal(first.status, 200);
    assert.deepEqual(await generalCast(client, f, input, true), first);
    assert.equal(
      (await generalCast(client, f, ballotInput(f.question), true)).status,
      200,
    );
    assert.equal(
      (
        await generalCast(
          client,
          f,
          ballotInput(f.question, {linkId: f.link.id}),
          true,
        )
      ).status,
      200,
    );
    assert.equal(
      (await cast(client, f, ballotInput(f.question))).error,
      'used',
    );
    const counts = (
      await client.query(
        'SELECT source,count(*)::integer AS count FROM ballots GROUP BY source ORDER BY source',
      )
    ).rows;
    assert.deepEqual(counts, [
      {source: 'admin_manual', count: 2},
      {source: 'admin_personal', count: 1},
    ]);
    const context = (
      await client.query('SELECT vm_manual_context($1,$2,$3,$4) AS reply', [
        f.admin.room.id,
        hash(f.admin.session),
        f.question.id,
        f.link.id,
      ])
    ).rows[0].reply;
    assert.equal(context.answered, true);
    assert(!('answer' in context));
    assert(!('choices' in context));
  });
});

test('manual personal entry racing the respondent creates exactly one ballot', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const other = new pg.Client({connectionString: databaseUrl});
    await other.connect();
    try {
      const replies = await Promise.all([
        cast(client, f, ballotInput(f.question)),
        generalCast(
          other,
          f,
          ballotInput(f.question, {linkId: f.link.id}),
          true,
        ),
      ]);
      assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409]);
      assert.equal(
        (await client.query('SELECT count(*) FROM ballots')).rows[0].count,
        '1',
      );
    } finally {
      await other.end();
    }
  });
});

test('all new sources reject closed questions, foreign runs and participant access to admin operations', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await reusableFixture(client);
    const other = await reusableFixture(client);
    assert.equal(
      (
        await generalCast(
          client,
          f,
          ballotInput(f.question, {runId: other.run.id}),
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await generalCast(
          client,
          {...f, admin: {...f.admin, session: f.session}},
          ballotInput(f.question),
          true,
        )
      ).status,
      401,
    );
    f.question = (
      await lifecycle(client, f.admin, f.question, 'close')
    ).question;
    assert.equal(
      (await generalCast(client, f, ballotInput(f.question, {runId: f.run.id})))
        .error,
      'closed',
    );
    assert.equal(
      (await generalCast(client, f, ballotInput(f.question), true)).error,
      'closed',
    );
  });
});

test('explicit reset erases answers and idempotent receipts while keeping first-opening promises', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {}, false);
    await cast(client, f, ballotInput(f.question));
    const result = (
      await client.query('SELECT vm_reset_question($1,$2,$3,$4) AS reply', [
        f.admin.room.id,
        hash(f.admin.session),
        f.question.id,
        JSON.stringify({revision: f.question.revision}),
      ])
    ).rows[0].reply;
    assert.equal(result.question.state, 'draft');
    assert.equal(result.question.editLocked, true);
    assert.equal(
      (await client.query('SELECT count(*) FROM ballots')).rows[0].count,
      '0',
    );
    assert.equal(
      (await client.query('SELECT count(*) FROM vote_requests')).rows[0].count,
      '0',
    );
    assert.equal((await journey(client, f)).questions.length, 0);
  });
});

test('session exchange reuses a valid browser session without accepting a wrong link key', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await reusableFixture(client);
    const opened = await client.query(
      'SELECT * FROM vm_exchange_voting_session($1,$2,$3,$4)',
      [
        f.link.id,
        hash(f.key.key),
        hash(randomBytes(32).toString('hex')),
        hash(f.session),
      ],
    );
    assert.equal(opened.rows[0].reused, true);
    assert.equal(
      (
        await client.query(
          'SELECT * FROM vm_exchange_voting_session($1,$2,$3,$4)',
          [
            f.link.id,
            hash('wrong'),
            hash(randomBytes(32).toString('hex')),
            hash(f.session),
          ],
        )
      ).rowCount,
      0,
    );
  });
});

test('rollback refuses new ballot sources and restores old schema after their explicit removal', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await reusableFixture(client);
    await generalCast(client, f, ballotInput(f.question, {runId: f.run.id}));
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: total - 9}),
    );
    assert.equal(await migrationCount(client), total);
    assert.equal(
      (
        await questionCall(
          client,
          f.admin,
          'delete',
          {revision: f.question.revision},
          f.question.id,
        )
      ).status,
      200,
    );
    await runMigrations({databaseUrl, direction: 'down', count: total - 9});
    await runMigrations({databaseUrl});
    assert.equal(
      (await client.query('SELECT count(*) FROM ballots')).rows[0].count,
      '0',
    );
  });
});

// Read results through the same role gate used by JSON and CSV
async function results(
  client,
  f,
  admin = false,
  question = f.question.id,
  data = {},
) {
  return (
    await client.query('SELECT vm_results($1,$2,$3,$4,$5) AS reply', [
      admin ? f.admin.room.id : f.link.id,
      hash(admin ? f.admin.session : f.session),
      admin,
      question,
      JSON.stringify(data),
    ])
  ).rows[0].reply;
}

test('result publication gates answered, non-voter and admin views without hidden fields', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {
      shareResults: true,
      publication: 'after_answer',
    });
    assert.deepEqual((await results(client, f)).result, {
      id: f.question.id,
      available: false,
    });
    assert.equal((await results(client, f, true)).result.total, 0);
    await cast(client, f, ballotInput(f.question));
    const participant = (await results(client, f)).result;
    assert.equal(participant.total, 1);
    assert(!('people' in participant));
    assert(!('sources' in participant));
    const key = linkItem();
    const [link] = await addLinks(client, f.admin, [key]);
    const {session} = await openLink(client, link, key.key);
    const nonVoter = {...f, link, session};
    assert.equal((await results(client, nonVoter)).result.available, false);
    f.question = (
      await lifecycle(client, f.admin, f.question, 'close')
    ).question;
    assert.equal((await results(client, nonVoter)).result.total, 1);
    f.question = (
      await lifecycle(client, f.admin, f.question, 'settings', {
        shareResults: false,
        publication: 'after_close',
      })
    ).question;
    assert.equal((await results(client, nonVoter)).status, 404);
    assert.equal((await results(client, f, true)).result.total, 1);
  });
});

test('multiple choice percentages use ballots and anonymous admin results contain only aggregates', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {
      anonymous: true,
      choiceMode: 'multiple',
      minChoices: 1,
      maxChoices: 2,
    });
    await cast(
      client,
      f,
      ballotInput(f.question, {
        choices: f.question.choices.map((choice) => choice.id),
      }),
    );
    const result = (await results(client, f, true)).result;
    assert.equal(result.total, 1);
    assert.deepEqual(
      result.options.map((option) => option.percent),
      [100, 100],
    );
    assert.equal(result.sources.personal, 1);
    assert(!('people' in result));
    assert(!('nextPeopleCursor' in result));
    assert(!JSON.stringify(result).includes(f.link.id));
    assert(!JSON.stringify(result).includes(f.session));
    assert(!JSON.stringify(result).includes('createdAt'));
  });
});

test('hidden results stay empty through open, close and reopen with every source', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {
      hideResultsUntilEnd: true,
      shareResults: true,
      publication: 'after_answer',
    });
    await cast(client, f, ballotInput(f.question));
    for (const admin of [true, false])
      assert.deepEqual((await results(client, f, admin)).result, {
        id: f.question.id,
        available: false,
      });
    f.question = (
      await lifecycle(client, f.admin, f.question, 'close')
    ).question;
    assert.equal((await results(client, f, true)).result.total, 1);
    f.question = (
      await lifecycle(client, f.admin, f.question, 'open')
    ).question;
    assert.equal((await results(client, f, true)).result.available, false);
  });
});

test('anonymous history and retries reveal a choice only to the current writing session', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {
      anonymous: true,
      allowAnswerChange: true,
    });
    const body = ballotInput(f.question);
    const first = await cast(client, f, body);
    const session = randomBytes(32).toString('hex');
    await client.query(
      'INSERT INTO voting_sessions(link_id,generation,secret_hash) SELECT id,generation,$2 FROM voting_links WHERE id=$1',
      [f.link.id, hash(session)],
    );
    const other = {...f, session};
    assert.equal(
      (await journey(client, f, {selected: f.question.id})).answer.id,
      first.answer.id,
    );
    const hidden = (await journey(client, other, {selected: f.question.id}))
      .answer;
    assert.deepEqual(hidden, {
      questionId: f.question.id,
      revision: first.answer.revision,
      choices: [],
      hidden: true,
    });
    assert.deepEqual((await cast(client, other, body)).answer, hidden);
    const changed = await cast(
      client,
      other,
      ballotInput(f.question, {
        ballotRevision: hidden.revision,
        choices: [f.question.choices[1].id],
      }),
    );
    assert.equal(changed.status, 200);
    assert.equal(
      (await journey(client, f, {selected: f.question.id})).answer.hidden,
      true,
    );
    assert.deepEqual(
      (await journey(client, other, {selected: f.question.id})).answer.choices,
      [f.question.choices[1].id],
    );
  });
});

test('reusable results require an answer in the selected session-owned run before closing', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await reusableFixture(client, {
      shareResults: true,
      publication: 'after_answer',
    });
    await generalCast(client, f, ballotInput(f.question, {runId: f.run.id}));
    assert.equal(
      (await results(client, f, false, f.question.id, {run: f.run.id})).result
        .total,
      1,
    );
    await client.query(
      'UPDATE rooms SET allow_reusable_repeat=true WHERE id=$1',
      [f.admin.room.id],
    );
    const next = await startRun(client, f);
    assert.equal(
      (await results(client, f, false, f.question.id, {run: next.run.id}))
        .result.available,
      false,
    );
    assert.equal(
      (await results(client, f, false, f.question.id, {run: randomUUID()}))
        .status,
      404,
    );
  });
});

test('results isolate rooms and individual pages and survive rollback and reapply', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const other = await personalFixture(client);
    await cast(client, f, ballotInput(f.question));
    assert.equal(
      (await results(client, other, true, f.question.id)).status,
      404,
    );
    const result = (await results(client, f, true)).result;
    assert.equal(result.people[0].linkId, f.link.id);
    assert.equal(result.people[0].name, f.link.name);
    await runMigrations({databaseUrl, direction: 'down', count: total - 10});
    assert.equal(
      (
        await client.query(
          'SELECT count(*) FROM ballots WHERE question_id=$1',
          [f.question.id],
        )
      ).rows[0].count,
      '1',
    );
    await runMigrations({databaseUrl});
    assert.equal((await results(client, f, true)).result.total, 1);
  });
});

// This opaque version covers only the caller's visible data
async function eventState(client, f, admin = false) {
  return (
    await client.query('SELECT vm_event_state($1,$2,$3) AS reply', [
      admin ? f.admin.room.id : f.link.id,
      hash(admin ? f.admin.session : f.session),
      admin,
    ])
  ).rows[0].reply;
}

test('live versions show answer progress without disclosing hidden choices', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {hideResultsUntilEnd: true});
    const before = await eventState(client, f, true);
    await cast(client, f, ballotInput(f.question));
    assert.notEqual(
      (await eventState(client, f, true)).version,
      before.version,
    );
    assert.match(before.version, /^[0-9a-f]{32}$/);
    f.question = (
      await lifecycle(client, f.admin, f.question, 'close')
    ).question;
    assert.notEqual(
      (await eventState(client, f, true)).version,
      before.version,
    );
    assert.equal(
      (await eventState(client, {...f, session: 'wrong'})).status,
      401,
    );
  });
});

test('live versions cover reusable session history and block revoked access', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await reusableFixture(client);
    const before = await eventState(client, f);
    await generalCast(client, f, ballotInput(f.question, {runId: f.run.id}));
    assert.notEqual((await eventState(client, f)).version, before.version);
    await client.query(
      'UPDATE voting_links SET revoked_at=clock_timestamp() WHERE id=$1',
      [f.link.id],
    );
    assert.deepEqual(await eventState(client, f), {status: 401});
  });
});

test('live signals are delivered only on commit and snapshots recover missed notifications', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const listener = new pg.Client({connectionString: databaseUrl});
    await listener.connect();
    const seen = [];
    listener.on('notification', (message) => seen.push(message.payload));
    try {
      await listener.query('LISTEN live_changes');
      const before = await eventState(client, f, true);
      await client.query('BEGIN');
      await client.query('UPDATE rooms SET name=$2 WHERE id=$1', [
        f.admin.room.id,
        'rolled back',
      ]);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(seen.length, 0);
      await client.query('ROLLBACK');
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(seen.length, 0);
      assert.equal((await eventState(client, f, true)).version, before.version);
      await client.query('UPDATE rooms SET name=$2 WHERE id=$1', [
        f.admin.room.id,
        'committed',
      ]);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.deepEqual(seen, [f.admin.room.id]);
      await listener.query('UNLISTEN *');
      const changed = await eventState(client, f, true);
      await cast(client, f, ballotInput(f.question));
      assert.notEqual(
        (await eventState(client, f, true)).version,
        changed.version,
      );
    } finally {
      await listener.end();
    }
  });
});

test('live rollback and reapply keep answers and restore signal triggers', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    await cast(client, f, ballotInput(f.question));
    await runMigrations({databaseUrl, direction: 'down', count: total - 11});
    assert.equal((await results(client, f, true)).result.total, 1);
    await runMigrations({databaseUrl});
    assert.equal((await eventState(client, f, true)).status, 200);
    assert.equal(
      (
        await client.query(
          "SELECT count(*) FROM pg_trigger WHERE tgname='live_signal'",
        )
      ).rows[0].count,
      '9',
    );
  });
});

test('anonymous retries preserve their original receipt after another allowed edit in the same session', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {
      anonymous: true,
      allowAnswerChange: true,
    });
    const body = ballotInput(f.question);
    const first = await cast(client, f, body);
    const changed = await cast(
      client,
      f,
      ballotInput(f.question, {
        ballotRevision: first.answer.revision,
        choices: [f.question.choices[1].id],
      }),
    );
    assert.equal(changed.status, 200);
    assert.deepEqual(await cast(client, f, body), first);
    assert.deepEqual(
      (await journey(client, f, {selected: f.question.id})).answer.choices,
      [f.question.choices[1].id],
    );
  });
});

// Save the same full document that the editor uses
async function reviewSave(client, f, extra = {}) {
  const current = (
    await client.query('SELECT vm_question_data($1) AS q', [f.question.id])
  ).rows[0].q;
  return questionCall(
    client,
    f.admin,
    'save',
    {
      ...current,
      state: current.state,
      deadlineMode: current.deadlineMode,
      ...extra,
    },
    current.id,
  );
}
// A view lease has a per-tab sequence so a late cleanup cannot erase a new view
async function presence(
  client,
  f,
  tab = randomUUID(),
  sequence = 1,
  question = f.question.id,
) {
  return (
    await client.query('SELECT vm_question_presence($1,$2,$3) AS reply', [
      f.link.id,
      hash(f.session),
      JSON.stringify({
        tabId: tab,
        sequence,
        questionId: question,
        ...(f.run ? {runId: f.run.id} : {}),
      }),
    ])
  ).rows[0].reply;
}

test('scheduled starts need an explicit open and capture promises only when due', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    await lockQuestionEdits(client, admin);
    const question = await readyQuestion(client, admin);
    const f = {admin, question};
    let reply = await reviewSave(client, f, {
      startMode: 'duration',
      startAfterSeconds: 1,
      deadlineMode: 'duration',
      closeAfterSeconds: 20,
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.question.state, 'draft');
    assert.equal(reply.question.scheduledAt, null);
    reply = await lifecycle(client, admin, reply.question, 'open');
    assert.equal(reply.question.state, 'scheduled');
    assert.equal(reply.question.editLocked, null);
    assert.equal(reply.question.openedAt, null);
    const key = linkItem();
    const [link] = await addLinks(client, admin, [key]);
    const {session} = await openLink(client, link, key.key);
    const voter = {...f, question: reply.question, link, session};
    assert.equal(
      (await cast(client, voter, ballotInput(voter.question))).status,
      409,
    );
    const snapshot = await journey(client, voter);
    assert.equal(snapshot.current, null);
    assert.equal(snapshot.upcoming.id, question.id);
    assert.equal(snapshot.questions[0].state, 'scheduled');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await client.query('SELECT vm_close_due()');
    const opened = (
      await client.query('SELECT vm_question_data($1) AS q', [question.id])
    ).rows[0].q;
    assert.equal(opened.state, 'open');
    assert.equal(opened.editLocked, true);
    assert.equal(opened.scheduledAt, null);
    assert.equal(
      Date.parse(opened.closesAt) - Date.parse(opened.openedAt),
      20000,
    );
  });
});

test('scheduled start validation is atomic and absolute closing must follow opening', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const question = await readyQuestion(client, admin);
    const f = {admin, question};
    const start = new Date(Date.now() + 60000).toISOString();
    assert.equal(
      (
        await reviewSave(client, f, {
          state: 'open',
          startMode: 'absolute',
          startsAt: start,
          deadlineMode: 'absolute',
          closesAt: new Date(Date.now() + 10000).toISOString(),
        })
      ).error,
      'deadline',
    );
    assert.equal(
      (
        await reviewSave(client, f, {
          state: 'open',
          startMode: 'absolute',
          startsAt: start,
          content: '',
          deadlineMode: 'none',
        })
      ).error,
      'ready',
    );
    assert.equal(
      (
        await client.query('SELECT content FROM questions WHERE id=$1', [
          question.id,
        ])
      ).rows[0].content,
      question.content,
    );
    const scheduled = await reviewSave(client, f, {
      state: 'open',
      startMode: 'absolute',
      startsAt: start,
      deadlineMode: 'none',
    });
    assert.equal(Date.parse(scheduled.question.scheduledAt), Date.parse(start));
  });
});

test('scheduled cancel, reopen and reset keep the agreed rights and clear armed work', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {}, false);
    await cast(client, f, ballotInput(f.question));
    f.question = (
      await lifecycle(client, f.admin, f.question, 'close')
    ).question;
    const scheduled = await reviewSave(client, f, {
      state: 'open',
      startMode: 'duration',
      startAfterSeconds: 60,
    });
    assert.equal(scheduled.question.state, 'scheduled');
    assert.equal(
      (await lifecycle(client, f.admin, f.question, 'cancel_start')).error,
      'conflict',
    );
    f.question = (
      await lifecycle(client, f.admin, scheduled.question, 'cancel_start')
    ).question;
    assert.equal(f.question.state, 'closed');
    assert.equal((await results(client, f, true)).result.total, 1);
    const waiting = await lifecycle(client, f.admin, f.question, 'open');
    const reset = (
      await client.query('SELECT vm_reset_question($1,$2,$3,$4) AS reply', [
        f.admin.room.id,
        hash(f.admin.session),
        f.question.id,
        JSON.stringify({revision: waiting.question.revision}),
      ])
    ).rows[0].reply;
    assert.equal(reset.question.state, 'draft');
    assert.equal(reset.question.scheduledAt, null);
    assert.equal(reset.question.editLocked, true);
    assert.equal(
      (await client.query('SELECT count(*) FROM ballots')).rows[0].count,
      '0',
    );
  });
});

test('two workers open a due question once and missed absolute windows never accept votes', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    f.question = (
      await lifecycle(client, f.admin, f.question, 'close')
    ).question;
    await reviewSave(client, f, {
      state: 'open',
      startMode: 'duration',
      startAfterSeconds: 1,
      deadlineMode: 'duration',
      closeAfterSeconds: 60,
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const other = new pg.Client({connectionString: databaseUrl});
    await other.connect();
    try {
      const runs = await Promise.all([
        client.query('SELECT vm_close_due() AS n'),
        other.query('SELECT vm_close_due() AS n'),
      ]);
      assert.equal(
        runs.reduce((n, r) => n + r.rows[0].n, 0),
        1,
      );
    } finally {
      await other.end();
    }
    const current = (
      await client.query('SELECT vm_question_data($1) AS q', [f.question.id])
    ).rows[0].q;
    assert.equal(current.state, 'open');
    f.question = (await lifecycle(client, f.admin, current, 'close')).question;
    const start = new Date(Date.now() + 1000).toISOString();
    const end = new Date(Date.now() + 1500).toISOString();
    const armed = await reviewSave(client, f, {
      state: 'open',
      startMode: 'absolute',
      startsAt: start,
      deadlineMode: 'absolute',
      closesAt: end,
    });
    assert.equal(armed.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await client.query('SELECT vm_close_due()');
    const missed = (
      await client.query('SELECT vm_question_data($1) AS q', [f.question.id])
    ).rows[0].q;
    assert.equal(missed.state, 'closed');
    assert.equal(missed.closedReason, 'deadline');
  });
});

test('presence counts visitors once across tabs and ignores stale updates', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const a = randomUUID(),
      b = randomUUID();
    assert.equal((await presence(client, f, a)).status, 200);
    await presence(client, f, b);
    assert.equal(
      (
        await client.query('SELECT vm_question_viewers($1) AS n', [
          f.question.id,
        ])
      ).rows[0].n,
      '1',
    );
    await presence(client, f, a, 3, null);
    await presence(client, f, a, 2);
    assert.equal(
      (
        await client.query(
          'SELECT question_id FROM question_views WHERE tab_id=$1',
          [a],
        )
      ).rows[0].question_id,
      null,
    );
    await presence(client, f, b, 2, null);
    assert.equal(
      (
        await client.query('SELECT vm_question_viewers($1) AS n', [
          f.question.id,
        ])
      ).rows[0].n,
      '0',
    );
  });
});

test('shared-link viewers are independent and expired views do not expire sessions', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await reusableFixture(client);
    await presence(client, f);
    const opened = await openLink(client, f.link, f.key.key);
    const other = {...f, session: opened.session};
    other.run = (await journey(client, other)).run;
    await presence(client, other);
    assert.equal(
      (
        await client.query('SELECT vm_question_viewers($1) AS n', [
          f.question.id,
        ])
      ).rows[0].n,
      '2',
    );
    await client.query(
      "UPDATE question_views SET seen_at=clock_timestamp()-interval '36 seconds'",
    );
    await client.query('SELECT vm_close_due()');
    assert.equal(
      (await client.query('SELECT count(*) FROM question_views')).rows[0].count,
      '0',
    );
    assert.equal((await journey(client, f)).status, 200);
  });
});

test('admin live counters do not disclose answer choices or participant identities', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {
      hideResultsUntilEnd: true,
      anonymous: true,
    });
    const before = await eventState(client, f, true);
    await presence(client, f);
    await cast(client, f, ballotInput(f.question));
    const page = await questionCall(client, f.admin, 'list', {after: '0'});
    assert.equal(page.questions[0].answerCount, 1);
    assert.equal(page.questions[0].viewerCount, 1);
    assert.notEqual(
      (await eventState(client, f, true)).version,
      before.version,
    );
    assert.equal((await results(client, f, true)).result.available, false);
    const snapshot = await journey(client, f, {selected: f.question.id});
    assert(!('viewerCount' in snapshot.current));
    assert(!('answerCount' in snapshot.questions[0]));
    const other = await personalFixture(client);
    assert.equal(
      (await presence(client, other, randomUUID(), 1, f.question.id)).status,
      404,
    );
    assert.equal((await presence(client, {...f, session: 'bad'})).status, 401);
  });
});

test('review rollback refuses armed starts, then preserves votes after cancellation and reapply', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    await cast(client, f, ballotInput(f.question));
    f.question = (
      await lifecycle(client, f.admin, f.question, 'close')
    ).question;
    const waiting = await reviewSave(client, f, {
      state: 'open',
      startMode: 'duration',
      startAfterSeconds: 60,
    });
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: total - 13}),
    );
    assert.equal(await migrationCount(client), total);
    await lifecycle(client, f.admin, waiting.question, 'cancel_start');
    await runMigrations({databaseUrl, direction: 'down', count: total - 13});
    await runMigrations({databaseUrl});
    assert.equal((await results(client, f, true)).result.total, 1);
  });
});

test('manual entry through a personal link has one personal counter and no separate public source', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    assert.equal(
      (
        await generalCast(
          client,
          f,
          ballotInput(f.question, {linkId: f.link.id}),
          true,
        )
      ).status,
      200,
    );
    const result = (await results(client, f, true)).result;
    assert.equal(result.sources.personal, 1);
    assert(!('admin_personal' in result.sources));
    assert.equal(result.people[0].source, 'personal');
  });
});

test('participant live versions do not reveal other hidden votes or view counters', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {hideResultsUntilEnd: true});
    const key = linkItem();
    const [link] = await addLinks(client, f.admin, [key]);
    const {session} = await openLink(client, link, key.key);
    const other = {...f, link, session};
    const before = await eventState(client, other);
    await presence(client, f);
    await cast(client, f, ballotInput(f.question));
    assert.deepEqual(await eventState(client, other), before);
  });
});

test('cancel racing a due start produces one complete state', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    f.question = (
      await lifecycle(client, f.admin, f.question, 'close')
    ).question;
    const armed = await reviewSave(client, f, {
      state: 'open',
      startMode: 'duration',
      startAfterSeconds: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const other = new pg.Client({connectionString: databaseUrl});
    await other.connect();
    try {
      const [cancel] = await Promise.all([
        lifecycle(client, f.admin, armed.question, 'cancel_start'),
        other.query('SELECT vm_close_due()'),
      ]);
      const current = (
        await client.query('SELECT vm_question_data($1) AS q', [f.question.id])
      ).rows[0].q;
      assert.equal(current.scheduledAt, null);
      assert.equal(current.state, cancel.status === 200 ? 'closed' : 'open');
      assert([200, 409].includes(cancel.status));
    } finally {
      await other.end();
    }
  });
});

// Configure a concrete electorate before opening the question
async function completionFixture(client, extra = {}) {
  const admin = await adminRoom(client);
  const question = await readyQuestion(client, admin, {
    hideResultsUntilEnd: true,
    ...extra,
  });
  const keys = [linkItem('First'), linkItem('Second')];
  const links = await addLinks(client, admin, keys);
  const sessions = await Promise.all(
    links.map((link, index) => openLink(client, link, keys[index].key)),
  );
  const saved = await reviewSave(
    client,
    {admin, question},
    {closeWhenAllAnswered: true, expectedLinkIds: links.map((link) => link.id)},
  );
  const opened = await lifecycle(client, admin, saved.question, 'open');
  assert.equal(opened.status, 200);
  return {
    admin,
    question: opened.question,
    link: links[0],
    session: sessions[0].session,
    links,
    sessions,
    keys,
  };
}

test('completion closes on the last expected personal answer and releases only saved results', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await completionFixture(client, {
      choiceMode: 'multiple',
      minChoices: 2,
      maxChoices: 2,
    });
    assert.equal(
      (
        await cast(
          client,
          f,
          ballotInput(f.question, {
            choices: f.question.choices.map((choice) => choice.id),
          }),
        )
      ).status,
      200,
    );
    assert.equal((await results(client, f, true)).result.available, false);
    const second = {...f, link: f.links[1], session: f.sessions[1].session};
    const body = ballotInput(f.question, {
      choices: f.question.choices.map((choice) => choice.id),
    });
    const reply = await cast(client, second, body);
    assert.equal(reply.status, 200);
    assert.deepEqual(await cast(client, second, body), reply);
    const stored = (
      await client.query('SELECT vm_question_data($1) AS q', [f.question.id])
    ).rows[0].q;
    assert.equal(stored.state, 'closed');
    assert.equal(stored.closedReason, 'all_voted');
    assert.equal((await results(client, f, true)).result.total, 2);
    assert(!('expectedLinkIds' in stored));
    assert(
      !JSON.stringify(
        await journey(client, second, {selected: f.question.id}),
      ).includes(f.links[0].id),
    );
  });
});

test('unrelated manual and reusable ballots never satisfy the expected personal set', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await completionFixture(client);
    assert.equal(
      (await generalCast(client, f, ballotInput(f.question), true)).status,
      200,
    );
    assert.equal(
      (
        await generalCast(
          client,
          f,
          ballotInput(f.question, {linkId: f.link.id}),
          true,
        )
      ).status,
      200,
    );
    const sharedKey = linkItem('Shared', 'reusable');
    const [sharedLink] = await addLinks(client, f.admin, [sharedKey]);
    const {session} = await openLink(client, sharedLink, sharedKey.key);
    const shared = {...f, link: sharedLink, session};
    const run = (await journey(client, shared)).run;
    assert.equal(
      (
        await generalCast(
          client,
          shared,
          ballotInput(f.question, {runId: run.id}),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await client.query('SELECT state FROM questions WHERE id=$1', [
          f.question.id,
        ])
      ).rows[0].state,
      'open',
    );
    const second = {...f, link: f.links[1], session: f.sessions[1].session};
    assert.equal(
      (await cast(client, second, ballotInput(f.question))).status,
      200,
    );
    assert.equal((await results(client, f, true)).result.total, 4);
  });
});

test('electorate validation rejects empty, foreign and reusable links atomically', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    f.question = (
      await lifecycle(client, f.admin, f.question, 'close')
    ).question;
    const other = await reusableFixture(client);
    for (const ids of [[], [other.link.id], [f.link.id, f.link.id]])
      assert.equal(
        (
          await reviewSave(client, f, {
            closeWhenAllAnswered: true,
            expectedLinkIds: ids,
            state: 'open',
          })
        ).status,
        400,
      );
    assert.equal(
      (
        await client.query('SELECT state FROM questions WHERE id=$1', [
          f.question.id,
        ])
      ).rows[0].state,
      'closed',
    );
  });
});

test('revocation and new links cannot silently shrink or enlarge a running electorate', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await completionFixture(client);
    await cast(client, f, ballotInput(f.question));
    await editLink(client, f.admin, f.links[1], 'revoke');
    await addLinks(client, f.admin, [linkItem('Later')]);
    assert.equal(
      (
        await client.query('SELECT state FROM questions WHERE id=$1', [
          f.question.id,
        ])
      ).rows[0].state,
      'open',
    );
    assert.equal(
      (await reviewSave(client, f, {expectedLinkIds: [f.link.id]})).error,
      'electorate_locked',
    );
    const closed = await lifecycle(client, f.admin, f.question, 'close');
    assert.equal(closed.question.closedReason, 'manual');
  });
});

test('reopening refuses an already completed set and allows an explicit disabled rule', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await completionFixture(client);
    await cast(client, f, ballotInput(f.question));
    await cast(
      client,
      {...f, link: f.links[1], session: f.sessions[1].session},
      ballotInput(f.question),
    );
    f.question = (
      await client.query('SELECT vm_question_data($1) AS q', [f.question.id])
    ).rows[0].q;
    assert.equal(
      (await lifecycle(client, f.admin, f.question, 'open')).error,
      'complete',
    );
    const reopened = await reviewSave(client, f, {
      closeWhenAllAnswered: false,
      state: 'open',
    });
    assert.equal(reopened.question.state, 'open');
    assert.equal((await results(client, f, true)).result.available, false);
  });
});

test('last personal answers racing on two database connections close once', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await completionFixture(client);
    const other = new pg.Client({connectionString: databaseUrl});
    await other.connect();
    try {
      const replies = await Promise.all([
        cast(client, f, ballotInput(f.question)),
        cast(
          other,
          {...f, link: f.links[1], session: f.sessions[1].session},
          ballotInput(f.question),
        ),
      ]);
      assert(replies.every((reply) => reply.status === 200));
      assert.equal((await results(client, f, true)).result.total, 2);
      assert.equal(
        (
          await client.query(
            'SELECT closed_reason FROM questions WHERE id=$1',
            [f.question.id],
          )
        ).rows[0].closed_reason,
        'all_voted',
      );
    } finally {
      await other.end();
    }
  });
});

test('hidden-result promises apply even when room editing is enabled', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {hideResultsUntilEnd: true}, true);
    assert.equal(
      (await reviewSave(client, f, {hideResultsUntilEnd: false})).error,
      'locked',
    );
    await assert.rejects(
      client.query(
        'UPDATE questions SET hide_results_until_end=false WHERE id=$1',
        [f.question.id],
      ),
    );
  });
});

test('completion rollback is atomic and preserves unrelated questions after explicit recovery', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await completionFixture(client);
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: total - 14}),
    );
    assert.equal(await migrationCount(client), total);
    const current = (
      await client.query('SELECT vm_question_data($1) AS q', [f.question.id])
    ).rows[0].q;
    assert.equal(
      (
        await questionCall(
          client,
          f.admin,
          'delete',
          {revision: current.revision},
          current.id,
        )
      ).status,
      200,
    );
    await runMigrations({databaseUrl, direction: 'down', count: total - 14});
    await runMigrations({databaseUrl});
  });
});

test('a new question can save its content and electorate and open in one operation', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const [link] = await addLinks(client, admin, [linkItem()]);
    const reply = await questionCall(client, admin, 'create', {
      ...questionDocument({
        content: 'New completion',
        choices: [{content: 'A'}, {content: 'B'}],
      }),
      state: 'open',
      deadlineMode: 'none',
      closeWhenAllAnswered: true,
      expectedLinkIds: [link.id],
    });
    assert.equal(reply.status, 201);
    assert.equal(reply.question.state, 'open');
    assert.equal(
      (await client.query('SELECT count(*) FROM question_expected_links'))
        .rows[0].count,
      '1',
    );
  });
});
test('hidden results can be configured for the next opening only after closing', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {hideResultsUntilEnd: true});
    f.question = (
      await lifecycle(client, f.admin, f.question, 'close')
    ).question;
    const saved = await reviewSave(client, f, {hideResultsUntilEnd: false});
    assert.equal(saved.status, 200);
    assert.equal(saved.question.hideResultsUntilEnd, false);
  });
});
test('direct snapshot edits cannot remove an expected participant during voting', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await completionFixture(client);
    await assert.rejects(
      client.query('DELETE FROM question_expected_links WHERE question_id=$1', [
        f.question.id,
      ]),
    );
    assert.equal(
      (
        await client.query(
          'SELECT count(*) FROM question_expected_links WHERE question_id=$1',
          [f.question.id],
        )
      ).rows[0].count,
      '2',
    );
  });
});

// Request only the respondents shown on the active admin page
async function online(client, f, ids = [f.link.id], session = f.admin.session) {
  return (
    await client.query('SELECT vm_admin_presence($1,$2,$3) AS reply', [
      f.admin.room.id,
      hash(session),
      JSON.stringify(ids),
    ])
  ).rows[0].reply;
}
test('admin online pages return view labels without sessions or answer data', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {anonymous: true});
    await presence(client, f);
    const reply = await online(client, f);
    assert.equal(reply.links[0].online, 1);
    assert.equal(reply.links[0].questions[0].id, f.question.id);
    assert(!JSON.stringify(reply).includes(f.session));
    assert(!JSON.stringify(reply).includes('choices'));
    assert.equal((await online(client, f, [f.link.id], f.session)).status, 401);
    const other = await personalFixture(client);
    assert.equal((await online(client, f, [other.link.id])).links.length, 0);
  });
});
test('online changes between respondents change the admin version even when viewer totals stay equal', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const tab = randomUUID();
    await presence(client, f, tab);
    const key = linkItem();
    const [link] = await addLinks(client, f.admin, [key]);
    const {session} = await openLink(client, link, key.key);
    const before = await eventState(client, f, true);
    await client.query('BEGIN');
    await presence(client, f, tab, 2, null);
    await presence(client, {...f, link, session});
    await client.query('COMMIT');
    assert.notEqual(
      (await eventState(client, f, true)).version,
      before.version,
    );
  });
});
test('projector snapshots never include identities and keep hidden distributions private', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {hideResultsUntilEnd: true});
    await cast(client, f, ballotInput(f.question));
    let reply = await results(client, f, true, f.question.id, {
      view: 'projector',
    });
    assert.equal(reply.result.available, false);
    assert.equal(reply.result.answerCount, 1);
    assert(!('options' in reply.result));
    f.question = (
      await lifecycle(client, f.admin, f.question, 'close')
    ).question;
    reply = await results(client, f, true, f.question.id, {view: 'projector'});
    assert.equal(reply.result.total, 1);
    assert(!('people' in reply.result));
    assert(!('sources' in reply.result));
    assert(!JSON.stringify(reply).includes(f.link.id));
    await runMigrations({databaseUrl, direction: 'down', count: total - 15});
    await runMigrations({databaseUrl});
    assert.equal((await results(client, f, true)).result.total, 1);
  });
});

const ratePolicy = {
  network: 100000,
  create: 1000,
  read: 5,
  write: 5,
  room: 100000,
};
// Use server-selected limits with real shared row locks
async function admit(
  client,
  f,
  action = 'write',
  network = hash('test network'),
  policy = ratePolicy,
) {
  return (
    await client.query(
      'SELECT vm_request_admission($1,$2,$3,$4,$5,$6) AS reply',
      [
        network,
        f?.link.id ?? null,
        f ? hash(f.session) : null,
        f ? 'vote' : 'public',
        action,
        JSON.stringify(policy),
      ],
    )
  ).rows[0].reply;
}
test('request budgets are shared across replicas and do not allow a last-token race', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const other = new pg.Client({connectionString: databaseUrl});
    await other.connect();
    try {
      const replies = await Promise.all(
        Array.from({length: 10}, (_, index) =>
          admit(index % 2 ? client : other, f),
        ),
      );
      assert.equal(replies.filter((reply) => reply.allowed).length, 5);
      assert(
        replies
          .filter((reply) => !reply.allowed)
          .every((reply) => reply.retryAfter > 0),
      );
    } finally {
      await other.end();
    }
  });
});
test('one shared network does not consume another participant session budget', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await reusableFixture(client);
    const session = (await openLink(client, f.link, f.key.key)).session;
    const second = {...f, session};
    for (let i = 0; i < 5; i++)
      assert.equal((await admit(client, f)).allowed, true);
    assert.equal((await admit(client, f)).allowed, false);
    assert.equal((await admit(client, second)).allowed, true);
  });
});
test('room creation has a separate configurable network budget and old entries are cleaned', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const policy = {...ratePolicy, create: 1};
    assert.equal(
      (await admit(client, null, 'create', hash('one'), policy)).allowed,
      true,
    );
    assert.equal(
      (await admit(client, null, 'create', hash('one'), policy)).allowed,
      false,
    );
    assert.equal(
      (await admit(client, null, 'read', hash('one'), policy)).allowed,
      true,
    );
    await client.query(
      "UPDATE request_limits SET updated_at=clock_timestamp()-interval '3 days'",
    );
    await client.query('SELECT vm_security_cleanup()');
    assert.equal(
      (await client.query('SELECT count(*) FROM request_limits')).rows[0].count,
      '0',
    );
    await runMigrations({databaseUrl, direction: 'down', count: total - 16});
    await runMigrations({databaseUrl});
  });
});
test('request budget rollback preserves room and voting sessions', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    await admit(client, f);
    await runMigrations({databaseUrl, direction: 'down', count: total - 16});
    await runMigrations({databaseUrl});
    assert.equal((await journey(client, f)).status, 200);
  });
});

// The list and results tabs still belong to an active visitor
test('online presence stays active outside a question and clears on leaving', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const tab = randomUUID();
    for (const [sequence, active] of [
      [1, true],
      [2, false],
    ]) {
      const response = (
        await client.query('SELECT vm_question_presence($1,$2,$3) AS reply', [
          f.link.id,
          hash(f.session),
          JSON.stringify({tabId: tab, sequence, questionId: null, active}),
        ])
      ).rows[0].reply;
      assert.equal(response.status, 200);
      const result = await online(client, f);
      assert.equal(result.links[0].online, active ? 1 : 0);
      assert.deepEqual(result.links[0].questions, []);
    }
  });
});

// Public cursors must not reveal hidden answer events
async function experience(client, f, admin = true, data = {}) {
  return (
    await client.query('SELECT vm_room_experience($1,$2,$3,$4) AS reply', [
      admin ? f.admin.room.id : f.link.id,
      hash(admin ? f.admin.session : f.session),
      admin,
      JSON.stringify(data),
    ])
  ).rows[0].reply;
}
test('room accents share access checks and update both live versions', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const before = await eventState(client, f, false);
    assert.equal(
      (await experience(client, f, true, {accent: 'violet'})).accent,
      'violet',
    );
    assert.equal((await experience(client, f, false)).accent, 'violet');
    assert.notEqual(
      (await eventState(client, f, false)).version,
      before.version,
    );
    assert.equal(
      (await experience(client, f, false, {accent: 'blue'})).status,
      403,
    );
    assert.equal(
      (await experience(client, f, true, {accent: 'fake'})).status,
      400,
    );
    const other = await personalFixture(client);
    assert.equal(
      (
        await experience(client, {
          ...f,
          admin: {...f.admin, session: other.admin.session},
        })
      ).status,
      401,
    );
  });
});
test('sound events hide answer activity from participant cursors and survive reconnect', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {hideResultsUntilEnd: true});
    const admin = await experience(client, f);
    const voter = await experience(client, f, false);
    assert.deepEqual(admin.events, []);
    assert.deepEqual(voter.events, []);
    await cast(client, f, ballotInput(f.question));
    assert.equal(
      (await experience(client, f, true, {after: admin.cursor})).events[0].kind,
      'answer',
    );
    const unchanged = await experience(client, f, false, {after: voter.cursor});
    assert.deepEqual(unchanged.events, []);
    assert.equal(unchanged.cursor, voter.cursor);
    await lifecycle(client, f.admin, f.question, 'close');
    const closed = await experience(client, f, false, {after: voter.cursor});
    assert.equal(closed.events[0].kind, 'close');
    assert.deepEqual(
      (await experience(client, f, false, {after: closed.cursor})).events,
      [],
    );
  });
});
test('appearance rollback and reapply preserve rooms and answers', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    await cast(client, f, ballotInput(f.question));
    await runMigrations({databaseUrl, direction: 'down', count: total - 17});
    assert.equal(
      (
        await client.query(
          "SELECT to_regclass('room_sound_events') IS NULL AS absent",
        )
      ).rows[0].absent,
      true,
    );
    await runMigrations({databaseUrl});
    assert.equal((await journey(client, f)).status, 200);
    assert.equal(
      (
        await client.query(
          'SELECT count(*) FROM ballots WHERE question_id=$1',
          [f.question.id],
        )
      ).rows[0].count,
      '1',
    );
  });
});

// Use the real deletion function with the latest room revision
async function removeRoom(client, fixture, data = {}) {
  const {
    rows: [room],
  } = await client.query('SELECT revision::text FROM rooms WHERE id=$1', [
    fixture.admin.room.id,
  ]);
  return (
    await client.query('SELECT vm_delete_room($1,$2,$3) AS reply', [
      fixture.admin.room.id,
      hash(fixture.admin.session),
      JSON.stringify({
        confirmation: fixture.admin.room.id,
        revision: room?.revision ?? '0',
        ...data,
      }),
    ])
  ).rows[0].reply;
}
test('room deletion removes answers, links and sessions and keeps retryable object jobs', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    await cast(client, f, ballotInput(f.question));
    const asset = await readyAsset(client, f.admin);
    assert.equal(
      (await removeRoom(client, f, {confirmation: randomUUID()})).status,
      400,
    );
    assert.equal(
      (await removeRoom(client, f, {revision: '999999'})).status,
      409,
    );
    assert.equal((await removeRoom(client, f)).status, 200);
    for (const table of [
      'rooms',
      'questions',
      'ballots',
      'room_admin_sessions',
      'voting_links',
      'assets',
    ]) {
      const column = table === 'rooms' ? 'id' : 'room_id';
      assert.equal(
        (
          await client.query(
            `SELECT count(*) FROM ${table} WHERE ${column}=$1`,
            [f.admin.room.id],
          )
        ).rows[0].count,
        '0',
      );
    }
    assert.equal((await journey(client, f)).status, 401);
    assert.equal((await cleanupCall(client, 'claim')).jobs.length, 0);
    await client.query(
      "UPDATE object_deletions SET available_at=clock_timestamp()-interval '1 second'",
    );
    const [job] = (await cleanupCall(client, 'claim')).jobs;
    assert.equal(job.id, asset.id);
    assert.equal((await cleanupCall(client, 'claim')).jobs.length, 0);
    await cleanupCall(client, 'ack', {id: job.id, token: randomUUID()});
    assert.equal(
      (await client.query('SELECT count(*) FROM object_deletions')).rows[0]
        .count,
      '1',
    );
    await cleanupCall(client, 'ack', job);
    assert.equal(
      (await client.query('SELECT count(*) FROM object_deletions')).rows[0]
        .count,
      '0',
    );
  });
});
test('room deletion rejects another admin and rolls back all data on a failed child cleanup', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const other = await adminRoom(client);
    await cast(client, f, ballotInput(f.question));
    assert.equal(
      (
        await removeRoom(client, {
          ...f,
          admin: {...f.admin, session: other.session},
        })
      ).status,
      401,
    );
    await client.query(
      "CREATE FUNCTION fail_room_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER fail_delete BEFORE DELETE ON voting_links FOR EACH ROW EXECUTE FUNCTION fail_room_delete()",
    );
    await assert.rejects(removeRoom(client, f));
    assert.equal(
      (
        await client.query(
          'SELECT count(*) FROM ballots WHERE question_id=$1',
          [f.question.id],
        )
      ).rows[0].count,
      '1',
    );
    assert.equal((await journey(client, f)).status, 200);
  });
});
test('operations rollback refuses queued objects and reapply preserves active room data', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    await readyAsset(client, f.admin);
    await removeRoom(client, f);
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: total - 18}),
    );
    assert.equal(
      (
        await client.query(
          "SELECT to_regprocedure('vm_delete_room(uuid,bytea,jsonb)') IS NOT NULL AS present",
        )
      ).rows[0].present,
      true,
    );
    await client.query('DELETE FROM object_deletions');
    const active = await personalFixture(client);
    await cast(client, active, ballotInput(active.question));
    await runMigrations({databaseUrl, direction: 'down', count: total - 18});
    await runMigrations({databaseUrl});
    assert.equal((await journey(client, active)).status, 200);
    assert.equal(
      (
        await client.query(
          'SELECT count(*) FROM ballots WHERE question_id=$1',
          [active.question.id],
        )
      ).rows[0].count,
      '1',
    );
  });
});

test('reusable visit signals count concurrent new sessions, retain rotations and roll back safely', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const key = linkItem('Many sessions', 'reusable');
    const [link] = await addLinks(client, f.admin, [key]);
    const version = async () =>
      (
        await client.query('SELECT vm_event_state($1,$2,true) AS state', [
          f.admin.room.id,
          hash(f.admin.session),
        ])
      ).rows[0].state.version;
    const before = await version();
    const sessions = await Promise.all(
      Array.from({length: 12}, async () => {
        const other = new pg.Client({connectionString: databaseUrl});
        await other.connect();
        try {
          return await openLink(other, link, key.key);
        } finally {
          await other.end();
        }
      }),
    );
    assert(sessions.every((session) => session.count === 1));
    const visits = async () =>
      (
        await client.query(
          'SELECT count(*) FROM voting_sessions WHERE link_id=$1',
          [link.id],
        )
      ).rows[0].count;
    assert.equal(await visits(), '12');
    assert.notEqual(await version(), before);
    const reused = await client.query(
      'SELECT * FROM vm_exchange_voting_session($1,$2,$3,$4)',
      [link.id, hash(key.key), hash(randomUUID()), hash(sessions[0].session)],
    );
    assert.equal(reused.rows[0].reused, true);
    assert.equal(await visits(), '12');
    const next = linkItem('Many sessions', 'reusable');
    await editLink(client, f.admin, link, 'rotate', next);
    await openLink(client, link, next.key);
    assert.equal(await visits(), '13');
    // An outside dependency must block rollback without losing session history
    await client.query(
      'CREATE VIEW outside_live AS SELECT vm_event_state(NULL::uuid,NULL::bytea,false)',
    );
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: total - 19}),
      {
        code: '2BP01',
      },
    );
    assert.equal(await visits(), '13');
    assert.equal(await migrationCount(client), total);
    await client.query('DROP VIEW outside_live');
    await runMigrations({databaseUrl, direction: 'down', count: total - 19});
    assert.equal(await visits(), '13');
    await runMigrations({databaseUrl});
    assert.equal(await visits(), '13');
  });
});

test('room deletion and a simultaneous vote leave no orphan data', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    const other = new pg.Client({connectionString: databaseUrl});
    await other.connect();
    try {
      const [removed, vote] = await Promise.all([
        removeRoom(client, f),
        cast(other, f, ballotInput(f.question)),
      ]);
      assert([200, 409].includes(removed.status));
      assert([200, 401, 409].includes(vote.status));
      if (removed.status === 409)
        assert.equal((await removeRoom(client, f)).status, 200);
      assert.equal(
        (
          await client.query('SELECT count(*) FROM ballots WHERE room_id=$1', [
            f.admin.room.id,
          ])
        ).rows[0].count,
        '0',
      );
      assert.equal(
        (
          await client.query('SELECT count(*) FROM rooms WHERE id=$1', [
            f.admin.room.id,
          ])
        ).rows[0].count,
        '0',
      );
    } finally {
      await other.end();
    }
  });
});

test('zero minimum accepts empty personal, reusable and manual answers and completes expected links', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const extra = {choiceMode: 'multiple', minChoices: 0, maxChoices: 2};
    const f = await personalFixture(client, extra);
    const body = ballotInput(f.question, {choices: []});
    const reply = await cast(client, f, body);
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.answer.choices, []);
    assert.deepEqual(await cast(client, f, body), reply);
    assert.equal((await results(client, f, true)).result.total, 1);
    const reusable = await reusableFixture(client, extra);
    assert.equal(
      (
        await generalCast(
          client,
          reusable,
          ballotInput(reusable.question, {choices: [], runId: reusable.run.id}),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await generalCast(
          client,
          f,
          ballotInput(f.question, {choices: []}),
          true,
        )
      ).status,
      200,
    );
    const required = await personalFixture(client);
    assert.equal(
      (
        await cast(
          client,
          required,
          ballotInput(required.question, {choices: []}),
        )
      ).status,
      400,
    );
    const completion = await completionFixture(client, extra);
    assert.equal(
      (
        await cast(
          client,
          completion,
          ballotInput(completion.question, {choices: []}),
        )
      ).status,
      200,
    );
    const second = {
      ...completion,
      link: completion.links[1],
      session: completion.sessions[1].session,
    };
    assert.equal(
      (
        await cast(
          client,
          second,
          ballotInput(completion.question, {choices: []}),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await client.query('SELECT state FROM questions WHERE id=$1', [
          completion.question.id,
        ])
      ).rows[0].state,
      'closed',
    );
  });
});

test('zero minimum rollback refuses data loss and supports recovery and reapply', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const q = await readyQuestion(client, admin, {
      choiceMode: 'multiple',
      minChoices: 0,
    });
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: total - 20}),
      {
        code: '23514',
      },
    );
    assert.equal(await migrationCount(client), total);
    assert.equal(
      (
        await client.query('SELECT min_choices FROM questions WHERE id=$1', [
          q.id,
        ])
      ).rows[0].min_choices,
      0,
    );
    await client.query('UPDATE questions SET min_choices=1 WHERE id=$1', [
      q.id,
    ]);
    await runMigrations({databaseUrl, direction: 'down', count: total - 20});
    assert.equal(
      (
        await questionCall(
          client,
          admin,
          'create',
          questionDocument({choiceMode: 'multiple', minChoices: 0}),
        )
      ).status,
      400,
    );
    await runMigrations({databaseUrl});
    assert(
      (
        await readyQuestion(client, admin, {
          choiceMode: 'multiple',
          minChoices: 0,
        })
      ).id,
    );
  });
});

// Use the same result entry point as HTTP for both report roles
async function roomReport(client, f, admin = true, exporting = false) {
  return (
    await client.query('SELECT vm_results($1,$2,$3,NULL,$4) AS reply', [
      admin ? f.admin.room.id : f.link.id,
      hash(admin ? f.admin.session : f.session),
      admin,
      JSON.stringify({view: exporting ? 'export' : 'summary'}),
    ])
  ).rows[0].reply;
}

test('room reports count identities once and keep hidden choices, names and anonymous links private', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    assert.equal((await cast(client, f, ballotInput(f.question))).status, 200);
    const anonymous = (
      await lifecycle(
        client,
        f.admin,
        await readyQuestion(client, f.admin, {
          content: 'Anonymous',
          anonymous: true,
          shareResults: true,
          publication: 'after_answer',
        }),
        'open',
      )
    ).question;
    assert.equal(
      (await cast(client, {...f, question: anonymous}, ballotInput(anonymous)))
        .status,
      200,
    );
    const hidden = (
      await lifecycle(
        client,
        f.admin,
        await readyQuestion(client, f.admin, {
          content: 'Hidden',
          hideResultsUntilEnd: true,
        }),
        'open',
      )
    ).question;
    assert.equal(
      (
        await generalCast(
          client,
          {...f, question: hidden},
          ballotInput(hidden),
          true,
        )
      ).status,
      200,
    );
    assert.equal(
      (await generalCast(client, f, ballotInput(f.question), true)).status,
      200,
    );
    const key = linkItem('Reusable report', 'reusable');
    const [link] = await addLinks(client, f.admin, [key]);
    const {session} = await openLink(client, link, key.key);
    const g = {...f, link, session};
    const run = (await journey(client, g)).run;
    assert.equal(
      (await generalCast(client, g, ballotInput(f.question, {runId: run.id})))
        .status,
      200,
    );
    const report = (await roomReport(client, f, true, true)).report;
    assert.equal(report.answers, 4);
    assert.equal(report.participants, 3);
    assert.equal(report.links.find((item) => item.id === f.link.id).answers, 1);
    assert.equal(
      report.links.find((item) => item.id === link.id).participants,
      1,
    );
    assert(!report.questions.some((q) => q.id === hidden.id));
    assert(!report.sheets.some((q) => q.id === hidden.id));
    assert(
      report.people.every((person) =>
        person.answers.every((answer) => answer.questionId !== anonymous.id),
      ),
    );
    assert.equal((await roomReport(client, f, false)).status, 403);
    const saved = await client.query(
      'SELECT vm_room_experience($1,$2,true,$3) AS reply',
      [f.admin.room.id, hash(f.admin.session), {showAllResults: true}],
    );
    assert.equal(saved.rows[0].reply.showAllResults, true);
    assert.equal((await journey(client, f)).resultsAvailable, true);
    const publicReport = (await roomReport(client, f, false, true)).report;
    assert.equal(publicReport.answers, 4);
    assert.deepEqual(publicReport.links, []);
    assert.deepEqual(publicReport.people, []);
    assert.deepEqual(
      publicReport.sheets.map((q) => q.id),
      [anonymous.id],
    );
    assert(!JSON.stringify(publicReport).includes(link.id));
    assert.equal((await results(client, f)).status, 404);
    const liveVersion = async () =>
      (
        await client.query('SELECT vm_event_state($1,$2,false) AS reply', [
          f.link.id,
          hash(f.session),
        ])
      ).rows[0].reply.version;
    const before = await liveVersion();
    assert.equal(
      (await generalCast(client, f, ballotInput(f.question), true)).status,
      200,
    );
    assert.notEqual(await liveVersion(), before);
    const shown = await liveVersion();
    assert.equal(
      (
        await generalCast(
          client,
          {...f, question: hidden},
          ballotInput(hidden),
          true,
        )
      ).status,
      200,
    );
    assert.equal(await liveVersion(), shown);
    assert.equal(
      (
        await client.query(
          'SELECT vm_room_experience($1,$2,false,$3) AS reply',
          [f.link.id, hash(f.session), {showAllResults: false}],
        )
      ).rows[0].reply.status,
      403,
    );
    await editLink(client, f.admin, f.link, 'revoke');
    assert.equal((await roomReport(client, f, false)).status, 401);
  });
});

test('report rollback is atomic when a dependent view exists and reapply preserves votes', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    await cast(client, f, ballotInput(f.question));
    await client.query(
      'CREATE VIEW external_report AS SELECT vm_room_report(NULL::uuid,NULL::bytea,false,NULL::uuid,false)',
    );
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: total - 21}),
      {
        code: '2BP01',
      },
    );
    assert.equal(await migrationCount(client), total);
    assert.equal((await roomReport(client, f)).report.answers, 1);
    await client.query('DROP VIEW external_report');
    await runMigrations({databaseUrl, direction: 'down', count: total - 21});
    assert.equal((await results(client, f, true)).result.total, 1);
    await runMigrations({databaseUrl});
    assert.equal((await roomReport(client, f)).report.answers, 1);
  });
});

test('a report waiting behind a room change observes sharing and access revocation', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client);
    await client.query('UPDATE rooms SET show_all_results=true WHERE id=$1', [
      f.admin.room.id,
    ]);
    const other = new pg.Client({connectionString: databaseUrl});
    await other.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE', [
        f.admin.room.id,
      ]);
      const disabled = roomReport(other, f, false, true);
      await delay(30);
      await client.query(
        'UPDATE rooms SET show_all_results=false WHERE id=$1',
        [f.admin.room.id],
      );
      await client.query('COMMIT');
      assert.equal((await disabled).status, 403);
      await client.query('UPDATE rooms SET show_all_results=true WHERE id=$1', [
        f.admin.room.id,
      ]);
      await client.query('BEGIN');
      await client.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE', [
        f.admin.room.id,
      ]);
      const revoked = roomReport(other, f, false, true);
      await delay(30);
      await editLink(client, f.admin, f.link, 'revoke');
      await client.query('COMMIT');
      assert.equal((await revoked).status, 401);
    } finally {
      await client.query('ROLLBACK');
      await other.end();
    }
  });
});

// Save the label and history choice through one locked admin action
async function historyRule(client, f, enabled) {
  return client.query(
    'SELECT * FROM vm_edit_voting_link($1,$2,$3,$4,$5,NULL,NULL,$6)',
    [
      f.admin.room.id,
      hash(f.admin.session),
      f.link.id,
      'rename',
      f.link.name,
      enabled,
    ],
  );
}

test('reusable history starts disabled and old IDs cannot bypass the link rule', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await reusableFixture(client, {allowAnswerChange: true});
    assert.equal(
      (
        await client.query(
          'SELECT allow_run_history FROM voting_links WHERE id=$1',
          [f.link.id],
        )
      ).rows[0].allow_run_history,
      false,
    );
    const body = ballotInput(f.question, {runId: f.run.id});
    assert.equal((await generalCast(client, f, body)).status, 200);
    await client.query(
      'UPDATE rooms SET allow_reusable_repeat=true,show_all_results=true WHERE id=$1',
      [f.admin.room.id],
    );
    const current = (await startRun(client, f)).run;
    assert.deepEqual(
      (await journey(client, f)).runs.map((run) => run.id),
      [current.id],
    );
    assert.equal((await journey(client, f, {run: f.run.id})).status, 404);
    assert.equal(
      (await results(client, f, false, f.question.id, {run: f.run.id})).status,
      404,
    );
    assert.equal((await generalCast(client, f, body)).status, 404);
    assert.equal((await startRun(client, f, f.run.id)).status, 404);
    const ownAnswer = async () =>
      (
        await client.query('SELECT vm_current_answer($1,$2,$3,$4) AS reply', [
          f.link.id,
          hash(f.session),
          f.question.id,
          f.run.id,
        ])
      ).rows[0].reply;
    assert.equal((await ownAnswer()).status, 404);
    assert.equal(
      (
        await client.query(
          'SELECT vm_room_report($1,$2,false,$3,true) AS reply',
          [f.link.id, hash(f.session), f.run.id],
        )
      ).rows[0].reply.status,
      404,
    );
    await historyRule(client, f, true);
    assert.equal((await journey(client, f)).runs.length, 2);
    assert.equal((await journey(client, f, {run: f.run.id})).status, 200);
    assert.deepEqual((await ownAnswer()).answer.choices, body.choices);
    const another = {
      ...f,
      session: (await openLink(client, f.link, f.key.key)).session,
    };
    assert.equal((await journey(client, another, {run: f.run.id})).status, 404);
    await historyRule(client, f, false);
    assert.equal((await ownAnswer()).status, 404);
    assert.equal((await journey(client, f)).run.id, current.id);
    assert.equal(
      (
        await client.query(
          'SELECT count(*) FROM ballots WHERE question_id=$1',
          [f.question.id],
        )
      ).rows[0].count,
      '1',
    );
  });
});

test('history rollback refuses outside dependencies and reapply preserves runs and answers', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await reusableFixture(client);
    await generalCast(client, f, ballotInput(f.question, {runId: f.run.id}));
    await client.query(
      'CREATE VIEW external_history AS SELECT vm_run_readable(NULL::uuid,NULL::bytea,NULL::uuid)',
    );
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: total - 22}),
      {
        code: '2BP01',
      },
    );
    assert.equal(await migrationCount(client), total);
    await client.query('DROP VIEW external_history');
    await runMigrations({databaseUrl, direction: 'down', count: total - 22});
    await runMigrations({databaseUrl});
    assert.equal((await journey(client, f)).run.id, f.run.id);
    assert.equal((await results(client, f, true)).result.total, 1);
  });
});

test('old reusable media and an answer waiting behind history disable follow the link rule', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await reusableFixture(client);
    await lifecycle(client, f.admin, f.question, 'close');
    const asset = await readyAsset(client, f.admin);
    const draft = await readyQuestion(client, f.admin, {
      content: `![Photo](asset:${asset.id})`,
      assetRefs: [{position: -1, assetId: asset.id}],
    });
    f.question = (await lifecycle(client, f.admin, draft, 'open')).question;
    await generalCast(client, f, ballotInput(f.question, {runId: f.run.id}));
    await lifecycle(client, f.admin, f.question, 'close');
    await client.query(
      'UPDATE rooms SET allow_reusable_repeat=true WHERE id=$1',
      [f.admin.room.id],
    );
    await startRun(client, f);
    const media = async () =>
      (
        await client.query('SELECT vm_participant_asset($1,$2,$3) AS reply', [
          f.link.id,
          hash(f.session),
          asset.id,
        ])
      ).rows[0].reply;
    assert.equal((await media()).status, 404);
    await historyRule(client, f, true);
    assert.equal((await media()).status, 200);
    const other = new pg.Client({connectionString: databaseUrl});
    await other.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE', [
        f.admin.room.id,
      ]);
      const pending = other.query(
        'SELECT vm_current_answer($1,$2,$3,$4) AS reply',
        [f.link.id, hash(f.session), f.question.id, f.run.id],
      );
      await delay(30);
      await historyRule(client, f, false);
      await client.query('COMMIT');
      assert.equal((await pending).rows[0].reply.status, 404);
      assert.equal((await media()).status, 404);
    } finally {
      await client.query('ROLLBACK');
      await other.end();
    }
  });
});

test('empty result choices survive upgrade, rollback, failed rollback and reapply', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    await runMigrations({databaseUrl, direction: 'down', count: total - 24});
    const f = await personalFixture(client, {
      choiceMode: 'multiple',
      minChoices: 0,
      maxChoices: 2,
      anonymous: false,
    });
    await cast(client, f, ballotInput(f.question, {choices: []}));
    const read = async () => (await results(client, f, true)).result;
    assert.deepEqual((await read()).people[0].choices, []);
    const signature = 'vm_results_before_review(uuid,bytea,boolean,uuid,jsonb)';
    const definition = (
      await client.query('SELECT pg_get_functiondef($1::regprocedure) AS sql', [
        signature,
      ])
    ).rows[0].sql;
    // Refuse a rollback when another change replaced the expected expression
    await client.query(
      definition.replace("'choices',COALESCE", "'choices', COALESCE"),
    );
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down'}),
      /Missing empty result choices expression/,
    );
    assert.equal(await migrationCount(client), 24);
    assert.equal((await read()).total, 1);
    await client.query(definition);
    await runMigrations({databaseUrl, direction: 'down'});
    assert.equal((await read()).people[0].choices, null);
    assert.equal((await read()).total, 1);
    await runMigrations({databaseUrl});
    assert.deepEqual((await read()).people[0].choices, []);
    assert.equal((await read()).total, 1);
  });
});

test('link creation saves history choices atomically and survives rollback and reapply', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    await runMigrations({databaseUrl, direction: 'down', count: total - 25});
    const admin = await adminRoom(client);
    const items = [
      {...linkItem('History', 'reusable'), allowRunHistory: true},
      linkItem('Default', 'reusable'),
    ];
    const saved = await addLinks(client, admin, items);
    assert.deepEqual(
      saved.map((link) => link.allow_run_history),
      [true, false],
    );
    for (const invalid of [
      {...linkItem(), allowRunHistory: true},
      {...linkItem('Bad', 'reusable'), allowRunHistory: 'true'},
    ]) {
      await assert.rejects(addLinks(client, admin, [linkItem(), invalid]), {
        code: '23514',
      });
      assert.equal(
        (await client.query('SELECT count(*) FROM voting_links')).rows[0].count,
        '2',
      );
    }
    const definition = (
      await client.query(
        "SELECT pg_get_functiondef('vm_add_voting_links(uuid,bytea,jsonb)'::regprocedure) AS sql",
      )
    ).rows[0].sql;
    await client.query(
      definition.replace(
        'secret_hash, secret_cipher, allow_run_history)',
        'secret_hash, secret_cipher,  allow_run_history)',
      ),
    );
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down'}),
      /Missing link history insert/,
    );
    assert.equal(await migrationCount(client), 25);
    await client.query(definition);
    await runMigrations({databaseUrl, direction: 'down'});
    assert.equal(
      (
        await addLinks(client, admin, [
          {...linkItem('Old', 'reusable'), allowRunHistory: true},
        ])
      )[0].allow_run_history,
      false,
    );
    assert.equal(
      (
        await client.query(
          'SELECT allow_run_history FROM voting_links WHERE id=$1',
          [saved[0].id],
        )
      ).rows[0].allow_run_history,
      true,
    );
    await runMigrations({databaseUrl});
    assert.equal(
      (
        await addLinks(client, admin, [
          {...linkItem('New', 'reusable'), allowRunHistory: true},
        ])
      )[0].allow_run_history,
      true,
    );
  });
});

test('hidden scheduled content stays private until opening and rollback requires a choice', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {shareResults: true});
    await cast(client, f, ballotInput(f.question));
    await lifecycle(client, f.admin, f.question, 'close');
    await client.query('UPDATE rooms SET show_all_results=true WHERE id=$1', [
      f.admin.room.id,
    ]);
    const armed = await reviewSave(client, f, {
      state: 'open',
      startMode: 'duration',
      startAfterSeconds: 600,
      hideUntilOpen: true,
    });
    assert.equal(armed.status, 200);
    assert.equal(armed.question.hideUntilOpen, true);
    assert.equal(armed.question.state, 'scheduled');
    const hidden = await journey(client, f, {selected: f.question.id});
    assert.equal(hidden.current, null);
    assert.deepEqual(hidden.questions, []);
    assert.equal(hidden.upcoming.preview, '');
    assert.ok(hidden.upcoming.scheduledAt);
    const participantResults = await results(client, f, false);
    assert.equal(participantResults.result.available, false);
    const listed = (
      await client.query("SELECT vm_results($1,$2,false,NULL,'{}') AS reply", [
        f.link.id,
        hash(f.session),
      ])
    ).rows[0].reply;
    assert.deepEqual(listed.questions, []);
    const report = (
      await client.query(
        'SELECT vm_room_report($1,$2,false,NULL,true) AS reply',
        [f.link.id, hash(f.session)],
      )
    ).rows[0].reply;
    assert.doesNotMatch(JSON.stringify(report), /Choose/);
    assert.equal((await results(client, f, true)).result.available, true);
    const before = await eventState(client, f, false);
    assert.equal(
      (await reviewSave(client, f, {hideUntilOpen: 'true'})).status,
      400,
    );
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down', count: total - 25}),
      /Disable hidden question content/,
    );
    assert.equal(await migrationCount(client), total);
    assert.equal((await journey(client, f)).upcoming.preview, '');
    // Turning the setting off restores the old preview without opening
    const visible = await reviewSave(client, f, {hideUntilOpen: false});
    assert.equal(visible.status, 200);
    assert.notEqual(
      (await eventState(client, f, false)).version,
      before.version,
    );
    assert.equal((await journey(client, f)).upcoming.preview, 'Choose');
    await runMigrations({databaseUrl, direction: 'down', count: total - 25});
    await runMigrations({databaseUrl});
    assert.equal(
      (await reviewSave(client, f, {hideUntilOpen: true})).status,
      200,
    );
    // The scheduler reveals the saved content in the opening transaction
    await client.query(
      "UPDATE questions SET scheduled_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [f.question.id],
    );
    await client.query('SELECT vm_close_due()');
    const revealed = await journey(client, f, {selected: f.question.id});
    assert.equal(revealed.current.content, 'Choose');
    assert.equal(revealed.current.choices.length, 2);
    assert.equal(revealed.current.hideUntilOpen, true);
  });
});

test('first scheduled opening hides text, choices and media while keeping the timer', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const asset = await readyAsset(client, admin);
    const question = await readyQuestion(client, admin, {
      content: `Secret ![Photo](asset:${asset.id})`,
      hideUntilOpen: true,
      assetRefs: [{position: -1, assetId: asset.id}],
    });
    const key = linkItem();
    const [link] = await addLinks(client, admin, [key]);
    const {session} = await openLink(client, link, key.key);
    const f = {admin, question, link, session};
    const saved = await reviewSave(client, f, {
      startMode: 'duration',
      startAfterSeconds: 600,
      assetRefs: [{position: -1, assetId: asset.id}],
    });
    assert.equal(saved.question.hideUntilOpen, true);
    const armed = await lifecycle(client, admin, saved.question, 'open');
    assert.equal(armed.question.state, 'scheduled');
    const readAsset = async () =>
      (
        await client.query('SELECT vm_participant_asset($1,$2,$3) AS reply', [
          link.id,
          hash(session),
          asset.id,
        ])
      ).rows[0].reply;
    const hidden = await journey(client, f, {selected: question.id});
    assert.equal(hidden.current, null);
    assert.deepEqual(hidden.questions, []);
    assert.equal(hidden.upcoming.preview, '');
    assert.ok(hidden.upcoming.scheduledAt);
    assert.doesNotMatch(JSON.stringify(hidden), /Secret|Photo|asset:/);
    assert.equal((await readAsset()).status, 404);
    assert.equal(
      (await assetCall(client, admin, 'get', {}, asset.id)).status,
      200,
    );
    await client.query(
      "UPDATE questions SET scheduled_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [question.id],
    );
    await client.query('SELECT vm_close_due()');
    assert.match((await journey(client, f)).current.content, /Secret/);
    assert.equal((await readAsset()).status, 200);
  });
});

test('hidden content default preserves saved choices through upgrade and rollback', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    await runMigrations({
      databaseUrl,
      direction: 'down',
      count: (await readdir(source)).filter(
        (name) =>
          name.endsWith('.mjs') &&
          name >= '1795046400000-hidden-content-default.mjs',
      ).length,
    });
    const admin = await adminRoom(client);
    const old = await readyQuestion(client, admin, {hideUntilOpen: undefined});
    assert.equal(old.hideUntilOpen, false);
    await runMigrations({databaseUrl});
    assert.equal(
      (await questionCall(client, admin, 'get', {}, old.id)).question
        .hideUntilOpen,
      false,
    );
    const fresh = await readyQuestion(client, admin, {
      hideUntilOpen: undefined,
    });
    assert.equal(fresh.hideUntilOpen, true);
    const explicit = await readyQuestion(client, admin, {hideUntilOpen: false});
    assert.equal(explicit.hideUntilOpen, false);
    await runMigrations({
      databaseUrl,
      direction: 'down',
      count: (await readdir(source)).filter(
        (name) =>
          name.endsWith('.mjs') &&
          name >= '1795046400000-hidden-content-default.mjs',
      ).length,
    });
    assert.equal(
      (await questionCall(client, admin, 'get', {}, fresh.id)).question
        .hideUntilOpen,
      true,
    );
    assert.equal(
      (await readyQuestion(client, admin, {hideUntilOpen: undefined}))
        .hideUntilOpen,
      false,
    );
    await runMigrations({databaseUrl});
    assert.equal(
      (await readyQuestion(client, admin, {hideUntilOpen: undefined}))
        .hideUntilOpen,
      true,
    );
  });
});

// Competing claims must be serialized by PostgreSQL, not by the browser
test('allocation capacity races keep exactly one owner and retries stay stable', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(
      client,
      {
        questionType: 'allocation',
        allowAnswerChange: true,
        choices: [
          {content: 'Slot A', capacity: 1},
          {content: 'Slot B', capacity: 2},
        ],
      },
      true,
    );
    assert.equal(f.question.questionType, 'allocation');
    const key = linkItem();
    const [link] = await addLinks(client, f.admin, [key]);
    const {session} = await openLink(client, link, key.key);
    const other = {...f, link, session};
    const rival = new pg.Client({connectionString: databaseUrl});
    await rival.connect();
    try {
      const body = ballotInput(f.question);
      const attempts = await Promise.all([
        cast(client, f, body),
        cast(rival, other, ballotInput(f.question)),
      ]);
      assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
      assert.equal(attempts.find((r) => r.status === 409).error, 'full');
      const winner = attempts[0].status === 200 ? f : other;
      const winnerBody = attempts[0].status === 200 ? body : null;
      const saved = attempts.find((r) => r.status === 200).answer;
      if (winnerBody)
        assert.deepEqual(await cast(client, winner, winnerBody), attempts[0]);
      assert.equal(
        Number(
          (
            await client.query(
              'SELECT count(*) FROM ballot_choices WHERE option_id=$1',
              [f.question.choices[0].id],
            )
          ).rows[0].count,
        ),
        1,
      );
      const released = await cast(
        client,
        winner,
        ballotInput(f.question, {choices: [], ballotRevision: saved.revision}),
      );
      assert.equal(released.status, 200);
      const loser = winner === f ? other : f;
      assert.equal(
        (await cast(client, loser, ballotInput(f.question))).status,
        200,
      );
      const page = await journey(client, loser);
      assert.equal(page.questions[0].selectedChoices[0].content, 'Slot A');
      assert.equal(page.progress.answered, 1);
    } finally {
      await rival.end();
    }
  });
});

// A partial selection holds real places while its required minimum stays pending
test('allocation minimum blocks navigation and fixed answers can only add places', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {
      questionType: 'allocation',
      choiceMode: 'multiple',
      minChoices: 2,
      maxChoices: 3,
      choices: [
        {content: 'A', capacity: 1},
        {content: 'B', capacity: 1},
        {content: 'C', capacity: 1},
      ],
    });
    const next = await laterQuestion(client, f);
    const first = await cast(client, f, ballotInput(f.question));
    assert.equal(first.status, 200);
    let page = await journey(client, f);
    assert.equal(page.progress.answered, 0);
    assert.equal(page.current.id, f.question.id);
    assert.equal(page.questions.find((q) => q.id === next.id).canChoose, false);
    assert.equal((await journey(client, f, {skip: f.question.id})).status, 409);
    const denied = await cast(
      client,
      f,
      ballotInput(f.question, {
        choices: [],
        ballotRevision: first.answer.revision,
      }),
    );
    assert.equal(denied.status, 409);
    assert.equal(denied.error, 'used');
    const second = await cast(
      client,
      f,
      ballotInput(f.question, {
        choices: f.question.choices.slice(0, 2).map((c) => c.id),
        ballotRevision: first.answer.revision,
      }),
    );
    assert.equal(second.status, 200);
    page = await journey(client, f);
    assert.equal(page.progress.answered, 1);
    assert.equal(page.questions.find((q) => q.id === next.id).canChoose, true);
    const third = await cast(
      client,
      f,
      ballotInput(f.question, {
        choices: f.question.choices.map((c) => c.id),
        ballotRevision: second.answer.revision,
      }),
    );
    assert.equal(third.status, 200);
    const result = await client.query(
      'SELECT vm_admin_question_metrics($1) AS reply',
      [f.question.id],
    );
    assert.equal(result.rows[0].reply.answerCount, 1);
  });
});

// A failed replacement must not free the participant's previous place
test('allocation failed transfers preserve claims and reject unsafe editor changes', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(
      client,
      {
        questionType: 'allocation',
        allowAnswerChange: true,
        choices: [
          {content: 'A', capacity: 1},
          {content: 'B', capacity: 1},
        ],
      },
      true,
    );
    const a = await cast(client, f, ballotInput(f.question));
    const key = linkItem();
    const [link] = await addLinks(client, f.admin, [key]);
    const {session} = await openLink(client, link, key.key);
    assert.equal(
      (
        await cast(
          client,
          {...f, link, session},
          ballotInput(f.question, {choices: [f.question.choices[1].id]}),
        )
      ).status,
      200,
    );
    const transfer = await cast(
      client,
      f,
      ballotInput(f.question, {
        choices: [f.question.choices[1].id],
        ballotRevision: a.answer.revision,
      }),
    );
    assert.equal(transfer.error, 'full');
    const page = await journey(client, f, {selected: f.question.id});
    assert.deepEqual(page.answer.choices, [f.question.choices[0].id]);
    assert.equal(page.current.choices[0].remaining, 0);
    const current = (
      await questionCall(client, f.admin, 'get', {}, f.question.id)
    ).question;
    const wrongType = await questionCall(
      client,
      f.admin,
      'save',
      {...current, questionType: 'choice'},
      current.id,
    );
    assert.equal(wrongType.error, 'type_fixed');
    assert.equal(
      (
        await cast(
          client,
          {...f, session: randomBytes(32).toString('hex')},
          ballotInput(f.question),
        )
      ).status,
      401,
    );
  });
});

// Additive migrations preserve ordinary data and rollback cannot erase new semantics
test('question types apply rollback reapply and refuse a destructive rollback', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    await rollbackFrom(databaseUrl, '1795132800000-question-types.mjs');
    assert.equal(
      (
        await client.query(
          "SELECT count(*) FROM information_schema.columns WHERE table_name='questions' AND column_name='question_type'",
        )
      ).rows[0].count,
      '0',
    );
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {
      questionType: 'allocation',
      choices: [
        {content: 'A', capacity: 1},
        {content: 'B', capacity: 1},
      ],
    });
    await assert.rejects(
      rollbackFrom(databaseUrl, '1795132800000-question-types.mjs'),
      /recover allocation/,
    );
    assert.equal(
      (
        await client.query('SELECT question_type FROM questions WHERE id=$1', [
          f.question.id,
        ])
      ).rows[0].question_type,
      'allocation',
    );
    assert.equal((await cast(client, f, ballotInput(f.question))).status, 200);
  });
});

// Partial choices must not leak through published results or complete a run
test('allocation partial answers stay out of results and anonymity protects list selections', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {
      questionType: 'allocation',
      choiceMode: 'multiple',
      minChoices: 2,
      maxChoices: 2,
      anonymous: true,
      shareResults: true,
      publication: 'after_answer',
      allowAnswerChange: true,
      choices: [
        {content: 'A', capacity: 2},
        {content: 'B', capacity: 2},
      ],
    });
    const first = await cast(client, f, ballotInput(f.question));
    assert.equal(first.status, 200);
    assert.equal((await results(client, f)).result.available, false);
    const partial = (await results(client, f, true)).result;
    assert.equal(partial.total, 0);
    assert.deepEqual(
      partial.options.map((o) => o.count),
      [0, 0],
    );
    const next = await cast(
      client,
      f,
      ballotInput(f.question, {
        choices: f.question.choices.map((c) => c.id),
        ballotRevision: first.answer.revision,
      }),
    );
    assert.equal(next.status, 200);
    assert.equal((await results(client, f)).result.total, 1);
    const secondSession = randomBytes(32).toString('hex');
    await client.query(
      'INSERT INTO voting_sessions(link_id,secret_hash,generation) SELECT id,$2,generation FROM voting_links WHERE id=$1',
      [f.link.id, hash(secondSession)],
    );
    const snapshot = await journey(
      client,
      {...f, session: secondSession},
      {selected: f.question.id},
    );
    assert.equal(snapshot.answer.hidden, true);
    assert.deepEqual(snapshot.questions[0].selectedChoices, []);
    const released = await cast(
      client,
      f,
      ballotInput(f.question, {
        choices: [],
        ballotRevision: next.answer.revision,
      }),
    );
    assert.equal(released.status, 200);
    assert.equal((await journey(client, f)).questions[0].answered, false);
    assert.equal((await results(client, f, true)).result.total, 0);
  });
});

// All answer sources share capacity and anonymous manual entry has one stable identity
test('allocation reusable runs and manual entry share capacity and live versions', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await reusableFixture(client, {
      questionType: 'allocation',
      allowAnswerChange: true,
      choices: [
        {content: 'A', capacity: 1},
        {content: 'B', capacity: 1},
      ],
    });
    const version = async () =>
      (
        await client.query('SELECT vm_event_state($1,$2,false) AS reply', [
          f.link.id,
          hash(f.session),
        ])
      ).rows[0].reply.version;
    const before = await version();
    const manualId = randomUUID();
    const manual = await generalCast(
      client,
      f,
      ballotInput(f.question, {ballotId: manualId}),
      true,
    );
    assert.equal(manual.status, 200);
    assert.equal(manual.answer.id, manualId);
    assert.notEqual(await version(), before);
    const full = await generalCast(
      client,
      f,
      ballotInput(f.question, {runId: f.run.id}),
    );
    assert.equal(full.error, 'full');
    const changed = await generalCast(
      client,
      f,
      ballotInput(f.question, {
        ballotId: manualId,
        choices: [f.question.choices[1].id],
        ballotRevision: manual.answer.revision,
      }),
      true,
    );
    assert.equal(changed.status, 200);
    assert.equal(
      (await generalCast(client, f, ballotInput(f.question, {runId: f.run.id})))
        .status,
      200,
    );
    assert.equal(
      (
        await generalCast(
          client,
          {...f, run: {id: randomUUID()}},
          ballotInput(f.question, {runId: randomUUID()}),
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await client.query(
          'SELECT count(*) FROM ballots WHERE question_id=$1',
          [f.question.id],
        )
      ).rows[0].count,
      '2',
    );
  });
});

// Constraints protect direct writes too, including capacity edits below occupancy
test('allocation guards reject direct overbooking and lower capacity', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(
      client,
      {
        questionType: 'allocation',
        allowAnswerChange: true,
        choices: [
          {content: 'A', capacity: 1},
          {content: 'B', capacity: 2},
        ],
      },
      true,
    );
    await cast(client, f, ballotInput(f.question));
    const key = linkItem();
    const [link] = await addLinks(client, f.admin, [key]);
    const {session} = await openLink(client, link, key.key);
    const own = await cast(
      client,
      {...f, link, session},
      ballotInput(f.question, {choices: [f.question.choices[1].id]}),
    );
    await assert.rejects(
      client.query(
        'INSERT INTO ballot_choices(ballot_id,question_id,room_id,option_id) VALUES($1,$2,$3,$4)',
        [
          own.answer.id,
          f.question.id,
          f.admin.room.id,
          f.question.choices[0].id,
        ],
      ),
      {code: 'P0002'},
    );
    // Two claims cannot be made invalid by changing a live capacity
    const key2 = linkItem();
    const [link2] = await addLinks(client, f.admin, [key2]);
    const session2 = (await openLink(client, link2, key2.key)).session;
    assert.equal(
      (
        await cast(
          client,
          {...f, link: link2, session: session2},
          ballotInput(f.question, {choices: [f.question.choices[1].id]}),
        )
      ).status,
      200,
    );
    await assert.rejects(
      client.query('UPDATE question_options SET capacity=1 WHERE id=$1', [
        f.question.choices[1].id,
      ]),
      {code: '23514'},
    );
    const current = (
      await questionCall(client, f.admin, 'get', {}, f.question.id)
    ).question;
    const response = await questionCall(
      client,
      f.admin,
      'save',
      {...current, choices: current.choices.map((c) => ({...c, capacity: 1}))},
      current.id,
    );
    assert.equal(response.error, 'capacity');
  });
});

// A release upgrade and its rollback must preserve ordinary ballots byte for byte
test('question types preserve existing ordinary ballots through upgrade and rollback', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await withMigrations(async (dir) => {
      for (const name of await readdir(dir))
        if (name >= '1795132800000-question-types.mjs')
          await rm(join(dir, name));
      await runMigrations({databaseUrl, dir});
      const f = await personalFixture(client);
      const vote = await cast(client, f, ballotInput(f.question));
      assert.equal(vote.status, 200);
      const before = (await journey(client, f, {selected: f.question.id}))
        .answer;
      await runMigrations({databaseUrl});
      const after = await journey(client, f, {selected: f.question.id});
      assert.deepEqual(after.answer, before);
      assert.equal(after.current.questionType, 'choice');
      await rollbackFrom(databaseUrl, '1795132800000-question-types.mjs');
      assert.deepEqual(
        (await journey(client, f, {selected: f.question.id})).answer,
        before,
      );
      await runMigrations({databaseUrl});
      assert.deepEqual(
        (await journey(client, f, {selected: f.question.id})).answer,
        before,
      );
    });
  });
});

// The type is fixed at creation while allocation visibility stays editable
test('allocation display policy defaults to hidden and keeps the creation type fixed', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {
      questionType: 'allocation',
      choices: [
        {content: 'A', capacity: 1},
        {content: 'B', capacity: 1},
      ],
    });
    assert.equal(f.question.hideUnavailable, true);
    let current = (
      await questionCall(client, f.admin, 'get', {}, f.question.id)
    ).question;
    const saved = await questionCall(
      client,
      f.admin,
      'save',
      {...current, hideUnavailable: false},
      current.id,
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.question.hideUnavailable, false);
    assert.equal((await journey(client, f)).current.hideUnavailable, false);
    assert.equal(
      (
        await cast(
          client,
          {...f, question: saved.question},
          ballotInput(saved.question),
        )
      ).status,
      200,
    );
    const draft = await readyQuestion(client, f.admin);
    assert.equal(
      (
        await questionCall(
          client,
          f.admin,
          'save',
          {
            ...draft,
            questionType: 'allocation',
            choices: draft.choices.map((c) => ({...c, capacity: 1})),
          },
          draft.id,
        )
      ).error,
      'type_fixed',
    );
    await assert.rejects(
      client.query(
        "UPDATE questions SET question_type='allocation' WHERE id=$1",
        [draft.id],
      ),
      {code: '23514'},
    );
  });
});

// A rollback must not discard a saved choice to show full options
test('allocation display policy rollback reapply and failed rollback preserve selections', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await personalFixture(client, {
      questionType: 'allocation',
      allowAnswerChange: true,
      choices: [
        {content: 'A', capacity: 1},
        {content: 'B', capacity: 1},
      ],
    });
    const answer = (await cast(client, f, ballotInput(f.question))).answer;
    await rollbackFrom(
      databaseUrl,
      '1795219200000-allocation-display-policy.mjs',
    );
    await runMigrations({databaseUrl});
    let q = (await questionCall(client, f.admin, 'get', {}, f.question.id))
      .question;
    assert.equal(q.hideUnavailable, true);
    assert.deepEqual(
      (await journey(client, f, {selected: q.id})).answer,
      answer,
    );
    q = (
      await questionCall(
        client,
        f.admin,
        'save',
        {...q, hideUnavailable: false},
        q.id,
      )
    ).question;
    await assert.rejects(
      rollbackFrom(databaseUrl, '1795219200000-allocation-display-policy.mjs'),
      /Enable hidden unavailable/,
    );
    assert.equal(
      (await questionCall(client, f.admin, 'get', {}, q.id)).question
        .hideUnavailable,
      false,
    );
    assert.deepEqual(
      (await journey(client, f, {selected: q.id})).answer,
      answer,
    );
  });
});

// Registration keeps one stable person behind a shared group link
async function registrationFixture(client, moderation = true) {
  const admin = await adminRoom(client);
  const question = (
    await lifecycle(client, admin, await readyQuestion(client, admin), 'open')
  ).question;
  const key = {
    ...linkItem('Students', 'registration'),
    requireModeration: moderation,
  };
  const [group] = await addLinks(client, admin, [key]);
  const {session} = await openLink(client, group, key.key);
  return {admin, question, group, key, session};
}
function registrationPacket(name = 'Alice') {
  const person = linkItem(name);
  const session = randomBytes(32).toString('hex');
  return {
    person,
    session,
    data: {
      name,
      hash: person.hash,
      cipher: person.cipher,
      sessionHash: hash(session).toString('hex'),
      sessionCipher: randomBytes(92).toString('hex'),
    },
  };
}
async function registerPerson(client, f, packet) {
  return (
    await client.query('SELECT vm_registration_request($1,$2,$3) AS reply', [
      f.group.id,
      hash(f.session),
      JSON.stringify(packet?.data ?? {}),
    ])
  ).rows[0].reply;
}
async function moderate(client, f, member, action) {
  return (
    await client.query(
      'SELECT vm_registration_admin($1,$2,$3,$4,$5,$6) AS reply',
      [
        f.admin.room.id,
        hash(f.admin.session),
        f.group.id,
        member.id,
        action,
        JSON.stringify({revision: member.revision}),
      ],
    )
  ).rows[0].reply;
}

test('registration approval block and unblock protect all private voting paths', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await registrationFixture(client);
    const p = registrationPacket();
    const waiting = await registerPerson(client, f, p);
    assert.equal(waiting.member.state, 'pending');
    assert.equal(waiting.votingId, undefined);
    assert.equal(waiting.sessionCipher, undefined);
    assert.equal(
      (await journey(client, {link: f.group, session: f.session})).status,
      401,
    );
    const child = (
      await client.query(
        'SELECT link_id FROM registration_members WHERE id=$1',
        [waiting.member.id],
      )
    ).rows[0].link_id;
    const voter = {...f, link: {id: child}, session: p.session};
    assert.equal(
      (await cast(client, voter, ballotInput(f.question))).status,
      401,
    );
    assert.equal(
      (await moderate(client, f, waiting.member, 'approve')).status,
      200,
    );
    let status = await registerPerson(client, f);
    assert.equal(status.votingId, child);
    const answer = (await cast(client, voter, ballotInput(f.question))).answer;
    assert(answer.id);
    assert.equal(
      (await moderate(client, f, status.member, 'block')).status,
      200,
    );
    status = await registerPerson(client, f);
    assert.equal(status.member.blocked, true);
    assert.equal(status.votingId, undefined);
    assert.equal((await journey(client, voter)).status, 401);
    assert.equal((await results(client, voter)).status, 401);
    assert.equal(
      (await moderate(client, f, status.member, 'unblock')).status,
      200,
    );
    assert.deepEqual(
      (await journey(client, voter, {selected: f.question.id})).answer,
      answer,
    );
    const list = (
      await client.query(
        "SELECT vm_registration_admin($1,$2,$3,NULL,'list','{}') AS reply",
        [f.admin.room.id, hash(f.admin.session), f.group.id],
      )
    ).rows[0].reply;
    assert.equal(list.members[0].name, 'Alice');
  });
});

test('registration rejects names for moderation and resubmits without making a second person', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await registrationFixture(client);
    const p = registrationPacket();
    const first = await registerPerson(client, f, p);
    assert.equal(
      (await moderate(client, f, first.member, 'reject')).status,
      200,
    );
    assert.equal((await registerPerson(client, f, p)).error, 'same_name');
    const second = await registerPerson(
      client,
      f,
      registrationPacket('Alice Smith'),
    );
    assert.equal(second.member.id, first.member.id);
    assert.equal(second.member.state, 'pending');
    assert.equal(
      (await client.query('SELECT count(*) FROM registration_members')).rows[0]
        .count,
      '1',
    );
    assert.equal(
      (await moderate(client, f, first.member, 'approve')).status,
      409,
    );
    const other = await adminRoom(client);
    assert.equal(
      (
        await client.query(
          "SELECT vm_registration_admin($1,$2,$3,$4,'approve',$5) AS reply",
          [
            other.room.id,
            hash(other.session),
            f.group.id,
            second.member.id,
            JSON.stringify({revision: second.member.revision}),
          ],
        )
      ).rows[0].reply.status,
      404,
    );
  });
});

test('registration races share one browser identity and groups hide their private child links', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await registrationFixture(client, false);
    const other = new pg.Client({connectionString: databaseUrl});
    await other.connect();
    try {
      const replies = await Promise.all([
        registerPerson(client, f, registrationPacket('A')),
        registerPerson(other, f, registrationPacket('B')),
      ]);
      assert.equal(replies[0].member.id, replies[1].member.id);
      assert.equal(replies[0].member.state, 'approved');
      const links = (
        await client.query('SELECT * FROM vm_list_voting_links($1,$2,0,51)', [
          f.admin.room.id,
          hash(f.admin.session),
        ])
      ).rows;
      assert.deepEqual(
        links.map((l) => l.id),
        [f.group.id],
      );
      assert.equal(
        (await client.query('SELECT count(*) FROM registration_devices'))
          .rows[0].count,
        '1',
      );
    } finally {
      await other.end();
    }
  });
});

test('registration group revocation stops new entry but keeps approved people and recovery working', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await registrationFixture(client, false);
    const p = registrationPacket();
    const first = await registerPerson(client, f, p);
    await editLink(client, f.admin, f.group, 'revoke');
    assert.equal((await openLink(client, f.group, f.key.key)).count, 0);
    const current = await registerPerson(client, f);
    assert.equal(current.member.id, first.member.id);
    assert.equal(current.closed, true);
    assert.equal(
      (
        await cast(
          client,
          {...f, link: {id: current.votingId}, session: p.session},
          ballotInput(f.question),
        )
      ).status,
      200,
    );
    const root2 = randomBytes(32).toString('hex'),
      child2 = randomBytes(32).toString('hex');
    const recovered = await client.query(
      'SELECT * FROM vm_recover_registration($1,$2,$3,$4,$5,$6)',
      [
        f.group.id,
        first.member.id,
        Buffer.from(p.person.hash, 'hex'),
        hash(root2),
        hash(child2),
        randomBytes(92),
      ],
    );
    assert.equal(recovered.rowCount, 1);
    const restored = await registerPerson(client, {...f, session: root2});
    assert.equal(restored.member.id, first.member.id);
    for (const session of [f.session, root2])
      await client.query('SELECT vm_question_presence($1,$2,$3)', [
        f.group.id,
        hash(session),
        JSON.stringify({
          tabId: randomUUID(),
          sequence: 1,
          questionId: null,
          active: true,
        }),
      ]);
    assert.equal(
      (
        await client.query('SELECT vm_registration_online($1) AS n', [
          first.member.id,
        ])
      ).rows[0].n,
      '2',
    );
    assert.equal(
      (
        await client.query(
          'SELECT * FROM vm_recover_registration($1,$2,$3,$4,$5,$6)',
          [
            f.group.id,
            first.member.id,
            randomBytes(32),
            randomBytes(32),
            randomBytes(32),
            randomBytes(92),
          ],
        )
      ).rowCount,
      0,
    );
  });
});

test('registration calls change only the targeted browser signal and preserve anonymous result privacy', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await registrationFixture(client, false);
    const p = registrationPacket();
    const first = await registerPerson(client, f, p);
    const version = async () =>
      (
        await client.query('SELECT vm_event_state($1,$2,false) AS reply', [
          f.group.id,
          hash(f.session),
        ])
      ).rows[0].reply.version;
    const before = await version();
    assert.equal((await moderate(client, f, first.member, 'call')).status, 200);
    const called = await registerPerson(client, f);
    assert.equal(called.member.callSequence, '1');
    assert.notEqual(await version(), before);
    assert.equal(called.member.state, 'approved');
    const person = {...f, link: {id: called.votingId}, session: p.session};
    assert.equal(
      (await cast(client, person, ballotInput(f.question))).status,
      200,
    );
    const named = (await results(client, person, true)).result;
    assert.equal(named.people[0].name, p.person.name);
    assert.equal(named.people[0].groupName, 'Students');
    assert.equal((await results(client, person)).status, 404);
    const anonymous = (
      await lifecycle(
        client,
        f.admin,
        await readyQuestion(client, f.admin, {anonymous: true}),
        'open',
      )
    ).question;
    assert.equal(
      (
        await cast(
          client,
          {...person, question: anonymous},
          ballotInput(anonymous),
        )
      ).status,
      200,
    );
    const hidden = (await results(client, person, true, anonymous.id)).result;
    assert.equal(hidden.total, 1);
    assert.equal('people' in hidden, false);
    assert.equal(JSON.stringify(hidden).includes('Students'), false);
    const q = (await lifecycle(client, f.admin, f.question, 'close')).question;
    // Existing anonymity rules still decide whether identities reach results
    assert.equal(
      (
        await results(
          client,
          {...f, link: {id: called.votingId}, session: p.session},
          true,
          q.id,
        )
      ).status,
      200,
    );
  });
});

test('registration lobbies share authenticated session and room request budgets', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await registrationFixture(client);
    const access = {...f, link: f.group};
    for (let i = 0; i < 5; i++)
      assert.equal((await admit(client, access)).allowed, true);
    assert.equal((await admit(client, access)).allowed, false);
    await client.query('DELETE FROM request_limits');
    const policy = {...ratePolicy, write: 100, room: 1};
    assert.equal(
      (await admit(client, access, 'write', hash('a'), policy)).allowed,
      true,
    );
    const second = await openLink(client, f.group, f.key.key);
    assert.equal(
      (
        await admit(
          client,
          {...access, session: second.session},
          'write',
          hash('b'),
          policy,
        )
      ).allowed,
      false,
    );
  });
});

test('registration migrations rollback reapply and refuse loss of registered access', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    await rollbackFrom(databaseUrl, '1795305600000');
    await runMigrations({databaseUrl});
    const f = await registrationFixture(client, false);
    const p = registrationPacket();
    const first = await registerPerson(client, f, p);
    await assert.rejects(
      rollbackFrom(databaseUrl, '1795305600000'),
      /Recover registration groups/,
    );
    assert.equal((await registerPerson(client, f)).member.id, first.member.id);
    const room = (
      await client.query('SELECT revision FROM rooms WHERE id=$1', [
        f.admin.room.id,
      ])
    ).rows[0];
    const removed = (
      await client.query('SELECT vm_delete_room($1,$2,$3) AS reply', [
        f.admin.room.id,
        hash(f.admin.session),
        JSON.stringify({
          confirmation: f.admin.room.id,
          revision: String(room.revision),
        }),
      ])
    ).rows[0].reply;
    assert.equal(removed.status, 200);
    assert.equal(
      (await client.query('SELECT count(*) FROM registration_members')).rows[0]
        .count,
      '0',
    );
  });
});

test('registration roster filters rejected names and renames both identities with revision checks', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await registrationFixture(client);
    const first = await registerPerson(client, f, registrationPacket());
    const list = async (filter = 'registered') =>
      (
        await client.query(
          'SELECT vm_registration_admin($1,$2,$3,NULL,$4,$5) AS reply',
          [
            f.admin.room.id,
            hash(f.admin.session),
            f.group.id,
            'list',
            JSON.stringify({filter}),
          ],
        )
      ).rows[0].reply;
    assert.equal((await list()).pendingCount, 1);
    assert.equal((await list()).registeredCount, 0);
    await moderate(client, f, first.member, 'reject');
    assert.deepEqual((await list()).members, []);
    assert.equal((await list()).pendingCount, 0);
    const retry = await registerPerson(client, f, registrationPacket('Bob'));
    await moderate(client, f, retry.member, 'approve');
    const approved = (await registerPerson(client, f)).member;
    await moderate(client, f, approved, 'block');
    assert.equal((await list()).members.length, 1);
    const current = (await registerPerson(client, f)).member;
    const rename = async (revision, name) =>
      (
        await client.query(
          'SELECT vm_registration_admin($1,$2,$3,$4,$5,$6) AS reply',
          [
            f.admin.room.id,
            hash(f.admin.session),
            f.group.id,
            current.id,
            'rename',
            JSON.stringify({revision, name}),
          ],
        )
      ).rows[0].reply;
    assert.equal((await rename(approved.revision, 'Charlie')).status, 409);
    assert.equal((await rename(current.revision, '  ')).status, 400);
    assert.equal((await rename(current.revision, 'Charlie')).status, 200);
    assert.equal((await registerPerson(client, f)).member.name, 'Charlie');
    assert.equal(
      (
        await client.query(
          'SELECT l.name FROM voting_links l JOIN registration_members m ON m.link_id=l.id WHERE m.id=$1',
          [current.id],
        )
      ).rows[0].name,
      'Charlie',
    );
    await runMigrations({databaseUrl, direction: 'down'});
    assert.equal((await registerPerson(client, f)).member.name, 'Charlie');
    await runMigrations({databaseUrl});
    assert.equal((await list()).registeredCount, 1);
  });
});

test('registration presence uses active tabs and ignores late heartbeats after leaving', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await registrationFixture(client, false);
    const person = await registerPerson(client, f, registrationPacket());
    const online = async () =>
      (
        await client.query('SELECT vm_registration_online($1) AS n', [
          person.member.id,
        ])
      ).rows[0].n;
    const tab = randomUUID();
    const report = async (sequence, active, questionId = null) =>
      (
        await client.query('SELECT vm_question_presence($1,$2,$3) AS reply', [
          f.group.id,
          hash(f.session),
          JSON.stringify({tabId: tab, sequence, questionId, active}),
        ])
      ).rows[0].reply;
    assert.equal(await online(), '0');
    assert.equal((await report(1, true)).status, 200);
    assert.equal(await online(), '1');
    assert.equal((await report(2, true, f.question.id)).status, 404);
    await report(3, false);
    await registerPerson(client, f);
    await report(2, true);
    assert.equal(await online(), '0');
    await report(4, true);
    await client.query(
      "UPDATE question_views SET seen_at=clock_timestamp()-interval '36 seconds' WHERE session_id IN (SELECT id FROM voting_sessions WHERE secret_hash=$1)",
      [hash(f.session)],
    );
    assert.equal(await online(), '0');
  });
});

// Use the revoked revision the admin confirmed on the link row
async function deleteLink(client, admin, link, revision = link.revision) {
  return (
    await client.query('SELECT vm_delete_voting_link($1,$2,$3,$4) AS reply', [
      admin.room.id,
      hash(admin.session),
      link.id,
      revision,
    ])
  ).rows[0].reply;
}

test('new rooms allow editing and locked allocation questions close without rewriting content', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    await rollbackFrom(databaseUrl, '1795564800000');
    const old = await adminRoom(client);
    await runMigrations({databaseUrl});
    assert.equal(
      (await questionCall(client, old, 'policy')).policy.lockAfterOpen,
      true,
    );
    const fresh = await personalFixture(client);
    assert.equal(fresh.question.editLocked, false);
    const q = (
      await workspaceSave(client, old, null, {
        questionType: 'allocation',
        content: 'Reserve a seat',
        choices: [
          {content: 'First', capacity: 2},
          {content: 'Second', capacity: 2},
        ],
        state: 'open',
      })
    ).question;
    assert.equal(q.editLocked, true);
    assert.equal(
      (
        await workspaceSave(client, old, q, {
          content: 'Changed',
          state: 'closed',
        })
      ).status,
      409,
    );
    const closed = await lifecycle(client, old, q, 'close');
    assert.equal(closed.status, 200);
    assert.equal(closed.question.state, 'closed');
    assert.equal(closed.question.editLocked, true);
    assert.deepEqual(closed.question.choices, q.choices);
  });
});

test('deleting a registration group removes its members and named answers while retaining anonymous totals', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await registrationFixture(client, false);
    const second = await openLink(client, f.group, f.key.key);
    const voters = [];
    for (const [i, session] of [f.session, second.session].entries()) {
      const packet = registrationPacket('Member ' + i);
      const entry = await registerPerson(client, {...f, session}, packet);
      voters.push({...f, link: {id: entry.votingId}, session: packet.session});
    }
    const anonymous = (
      await lifecycle(
        client,
        f.admin,
        await readyQuestion(client, f.admin, {anonymous: true}),
        'open',
      )
    ).question;
    for (const voter of voters) {
      assert.equal(
        (await cast(client, voter, ballotInput(f.question))).status,
        200,
      );
      assert.equal(
        (
          await cast(
            client,
            {...voter, question: anonymous},
            ballotInput(anonymous),
          )
        ).status,
        200,
      );
    }
    const report = async () =>
      (await results(client, f, true, f.question.id, {view: 'export'})).report;
    const before = await report();
    assert.equal(before.answers, 4);
    assert.deepEqual(before.sources, [{kind: 'registration', answers: 4}]);
    assert.equal(before.participants, 2);
    assert.deepEqual(before.links, [
      {
        id: f.group.id,
        name: 'Students',
        mode: 'registration',
        participants: 2,
        answers: 2,
      },
    ]);
    assert.equal(before.people.length, 2);
    assert.equal((await deleteLink(client, f.admin, f.group, '0')).status, 409);
    const revoked = (await editLink(client, f.admin, f.group, 'revoke'))[0];
    assert.equal((await registerPerson(client, f)).status, 200);
    assert.equal(
      (
        await deleteLink(
          client,
          await adminRoom(client),
          f.group,
          revoked.revision,
        )
      ).status,
      404,
    );
    assert.equal((await deleteLink(client, f.admin, f.group, '0')).status, 409);
    assert.equal(
      (await deleteLink(client, f.admin, f.group, revoked.revision)).status,
      200,
    );
    const after = await report();
    assert.equal(after.answers, 2);
    assert.deepEqual(after.sources, [{kind: 'registration', answers: 2}]);
    assert.equal(after.participants, 2);
    assert.deepEqual(after.links, []);
    assert.deepEqual(after.people, []);
    assert.deepEqual(
      after.sheets.find((q) => q.id === anonymous.id),
      before.sheets.find((q) => q.id === anonymous.id),
    );
    assert.equal((await registerPerson(client, f)).status, 401);
    assert.equal((await journey(client, voters[0])).status, 401);
    assert.equal(
      (await client.query('SELECT count(*) FROM registration_members')).rows[0]
        .count,
      '0',
    );
    assert.equal(
      (
        await client.query(
          'SELECT count(*) FROM voting_links WHERE room_id=$1',
          [f.admin.room.id],
        )
      ).rows[0].count,
      '0',
    );
    await assert.rejects(
      rollbackFrom(databaseUrl, '1795651200000'),
      /Recover detached registration sources/,
    );
    assert.deepEqual(await report(), after);
  });
});

test('removing an expected personal link cannot end the opening early', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await completionFixture(client);
    const link = f.links[0];
    const revoked = (await editLink(client, f.admin, link, 'revoke'))[0];
    assert.equal(
      (await deleteLink(client, f.admin, link, revoked.revision)).status,
      200,
    );
    assert.equal(
      (
        await client.query('SELECT vm_all_expected_answered($1) AS done', [
          f.question.id,
        ])
      ).rows[0].done,
      false,
    );
    assert.equal(
      (await lifecycle(client, f.admin, f.question, 'close')).status,
      200,
    );
  });
});

test('concurrent deletion of a reusable link keeps anonymous runs distinct and removes sessions', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await reusableFixture(client, {anonymous: true});
    const second = await openLink(client, f.link, f.key.key);
    const otherVoter = {...f, session: second.session};
    const {run} = await journey(client, otherVoter);
    for (const [voter, runId] of [
      [f, f.run.id],
      [otherVoter, run.id],
    ]) {
      assert.equal(
        (await generalCast(client, voter, ballotInput(f.question, {runId})))
          .status,
        200,
      );
    }
    const [revoked] = await editLink(client, f.admin, f.link, 'revoke');
    const other = new pg.Client({connectionString: databaseUrl});
    await other.connect();
    try {
      const replies = await Promise.all([
        deleteLink(client, f.admin, revoked),
        deleteLink(other, f.admin, revoked),
      ]);
      assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 404]);
    } finally {
      await other.end();
    }
    const {report} = await results(client, f, true, f.question.id, {
      view: 'export',
    });
    assert.equal(report.answers, 2);
    assert.equal(report.participants, 2);
    assert.deepEqual(report.people, []);
    assert.deepEqual(report.links, []);
    assert.equal(
      (await client.query('SELECT count(*) FROM voting_runs')).rows[0].count,
      '0',
    );
    assert.equal(
      (await client.query('SELECT count(*) FROM voting_sessions')).rows[0]
        .count,
      '0',
    );
  });
});

test('MCP question batches are atomic and retry safe and updates honor question revisions', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const token = randomBytes(32).toString('hex');
    assert.equal((await agentToken(client, admin, token)).status, 200);
    const run = (action, data = {}) =>
      agentOperation(client, null, token, action, data);
    const question = questionDocument({
      content: 'First draft',
      choices: [{content: 'A'}, {content: 'B'}],
    });
    const invalid = await run('questions_create_batch', {
      requestId: randomUUID(),
      questions: [question, {...question, minChoices: 5}],
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.index, 1);
    assert.deepEqual((await run('questions_list', {after: '0'})).questions, []);
    const batch = {
      requestId: randomUUID(),
      questions: [
        question,
        {...question, content: 'Second draft', state: 'open'},
      ],
    };
    const created = await run('questions_create_batch', batch);
    assert.equal(created.status, 201);
    assert.deepEqual(await run('questions_create_batch', batch), created);
    assert.equal(
      (await run('questions_create_batch', {...batch, questions: [question]}))
        .status,
      409,
    );
    const list = (await run('questions_list', {after: '0'})).questions;
    assert.equal(list.length, 2);
    assert(list.every((q) => q.state === 'draft'));
    const q = (await run('questions_get', {id: created.questions[0].id}))
      .question;
    const update = {
      id: q.id,
      revision: q.revision,
      question: {...q, content: 'Edited by agent', state: 'open'},
    };
    assert.equal((await run('questions_update', update)).status, 200);
    assert.equal((await run('questions_update', update)).status, 409);
    const current = (await questionCall(client, admin, 'get', {}, q.id))
      .question;
    assert.equal(current.content, 'Edited by agent');
    assert.equal(current.state, 'draft');
  });
});

// Use a fake cipher here because encryption is handled by the API
async function agentToken(client, admin, token, action = 'ensure') {
  const {rows} = await client.query(
    'SELECT * FROM vm_room_agent_token($1,$2,$3,$4,$5)',
    [
      admin.room.id,
      hash(admin.session),
      action,
      hash(token),
      Buffer.from(token, 'hex'),
    ],
  );
  return rows[0];
}

// Exercise the same token check used by both public endpoints
async function agentOperation(
  client,
  room,
  token,
  action = 'access',
  data = {},
) {
  const {rows} = await client.query(
    'SELECT vm_room_agent_operation($1,$2,$3,$4) AS reply',
    [room, hash(token), action, JSON.stringify(data)],
  );
  return rows[0].reply;
}

test('room API tokens are stable on concurrent issuance and rotate for both access paths', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const admin = await adminRoom(client);
    const other = await adminRoom(client);
    const candidates = [
      randomBytes(32).toString('hex'),
      randomBytes(32).toString('hex'),
    ];
    const replacement = randomBytes(32).toString('hex');
    const second = new pg.Client({connectionString: databaseUrl});
    await second.connect();
    try {
      const issued = await Promise.all([
        agentToken(client, admin, candidates[0]),
        agentToken(second, admin, candidates[1]),
      ]);
      const token = issued[0].encrypted;
      assert(candidates.includes(token));
      assert.deepEqual(issued, [
        {status: 200, encrypted: token},
        {status: 200, encrypted: token},
      ]);
      assert.equal(
        (await agentOperation(client, null, token)).room,
        admin.room.id,
      );
      assert.equal(
        (await agentOperation(client, other.room.id, token)).status,
        401,
      );
      assert.equal(
        (
          await agentToken(
            client,
            {...admin, session: other.session},
            replacement,
            'rotate',
          )
        ).status,
        401,
      );
      assert.equal(
        (
          await agentToken(
            client,
            {...admin, session: token},
            replacement,
            'rotate',
          )
        ).status,
        401,
      );

      const batch = {
        requestId: randomUUID(),
        questions: [questionDocument({content: 'Retained draft'})],
      };
      const created = await agentOperation(
        client,
        null,
        token,
        'questions_create_batch',
        batch,
      );
      assert.equal(created.status, 201);
      assert.deepEqual(await agentToken(client, admin, replacement, 'rotate'), {
        status: 200,
        encrypted: replacement,
      });
      for (const room of [null, admin.room.id]) {
        assert.equal((await agentOperation(second, room, token)).status, 401);
        assert.equal(
          (await agentOperation(second, room, replacement)).room,
          admin.room.id,
        );
      }
      assert.deepEqual(
        await agentOperation(
          second,
          null,
          replacement,
          'questions_create_batch',
          batch,
        ),
        created,
      );
      await assert.rejects(
        rollbackFrom(databaseUrl, '1795910400000'),
        /Room API tokens must be cleared before rollback/,
      );
      assert.equal(
        (await agentOperation(client, null, replacement)).status,
        200,
      );

      // Delete only the disposable room and check a clean rollback and reapply
      const {
        rows: [room],
      } = await client.query('SELECT revision FROM rooms WHERE id=$1', [
        admin.room.id,
      ]);
      const {
        rows: [{reply: removed}],
      } = await client.query('SELECT vm_delete_room($1,$2,$3) AS reply', [
        admin.room.id,
        hash(admin.session),
        JSON.stringify({
          confirmation: admin.room.id,
          revision: String(room.revision),
        }),
      ]);
      assert.equal(removed.status, 200);
      assert.equal(
        (await agentOperation(client, null, replacement)).status,
        401,
      );
      await rollbackFrom(databaseUrl, '1795910400000');
      assert.equal(
        (
          await client.query(
            "SELECT to_regclass('room_agent_tokens') AS tokens",
          )
        ).rows[0].tokens,
        null,
      );
      await runMigrations({databaseUrl});
      assert.equal((await agentToken(client, other, replacement)).status, 200);
    } finally {
      await second.end();
    }
  });
});

test('retiring OAuth removes old grants while preserving room tokens and batch receipts', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    await rollbackFrom(databaseUrl, '1795996800000');
    const admin = await adminRoom(client);
    const room = admin.room.id;
    const legacy = randomBytes(32).toString('hex');
    const token = randomBytes(32).toString('hex');
    await client.query(
      `
      WITH old_client AS (
        INSERT INTO mcp_clients(name,redirects) VALUES('Old client',ARRAY['https://client.test/callback']) RETURNING id
      )
      INSERT INTO mcp_connections(room_id,admin_id,client_id,resource,scopes,redirect_uri,challenge,code_until,access_hash,access_until,full_admin)
      SELECT $1,a.id,c.id,'https://vote.test/mcp',ARRAY['questions:read'],'https://client.test/callback',repeat('a',43),
        now(),$2,now()+interval '1 hour',true FROM room_admin_sessions a CROSS JOIN old_client c WHERE a.room_id=$1
    `,
      [room, hash(legacy)],
    );

    const oldAccess = async () =>
      (
        await client.query('SELECT vm_mcp_operation($1,$2,$3,$4) AS reply', [
          room,
          hash(legacy),
          'access',
          '{"resource":"https://vote.test/mcp"}',
        ])
      ).rows[0].reply.status;
    const removed = async () =>
      (
        await client.query(`
      SELECT to_regclass('mcp_clients') IS NULL AND to_regclass('mcp_connections') IS NULL
        AND to_regclass('mcp_question_batches') IS NULL
        AND to_regprocedure('vm_mcp_oauth(uuid,bytea,text,jsonb)') IS NULL
        AND to_regprocedure('vm_mcp_operation(uuid,bytea,text,jsonb)') IS NULL
        AND to_regprocedure('vm_mcp_oauth_before_full_access(uuid,bytea,text,jsonb)') IS NULL
        AND to_regprocedure('vm_mcp_operation_before_full_access(uuid,bytea,text,jsonb)') IS NULL AS gone
    `)
      ).rows[0].gone;
    assert.equal(await oldAccess(), 200);
    await agentToken(client, admin, token);
    const batch = {
      requestId: randomUUID(),
      questions: [questionDocument({content: 'Keep this draft'})],
    };
    const created = await agentOperation(
      client,
      room,
      token,
      'questions_create_batch',
      batch,
    );
    assert.equal(created.status, 201);

    await runMigrations({databaseUrl});
    assert.equal(await removed(), true);
    assert.equal((await agentOperation(client, room, legacy)).status, 401);
    assert.deepEqual(
      await agentOperation(
        client,
        room,
        token,
        'questions_create_batch',
        batch,
      ),
      created,
    );
    await assert.rejects(
      rollbackFrom(databaseUrl, '1795910400000'),
      /Room API tokens must be cleared before rollback/,
    );
    assert.equal(await removed(), true);
    assert.equal(
      (await agentOperation(client, room, token, 'results_summary')).status,
      200,
    );

    await rollbackFrom(databaseUrl, '1795996800000');
    assert.equal(await oldAccess(), 401);
    assert.deepEqual(
      await agentOperation(
        client,
        room,
        token,
        'questions_create_batch',
        batch,
      ),
      created,
    );
    await runMigrations({databaseUrl});
    assert.equal(await removed(), true);
  });
});

test('MCP results and roster use room access, revisions and the same privacy rules as the admin UI', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await registrationFixture(client);
    const other = await registrationFixture(client, false);
    const token = randomBytes(32).toString('hex');
    await agentToken(client, f.admin, token);
    const run = (action, data = {}) =>
      agentOperation(client, null, token, action, data);
    const {groups} = await run('registration_groups_list');
    assert.deepEqual(groups, [
      {
        id: f.group.id,
        name: 'Students',
        requireModeration: true,
        revokedAt: null,
      },
    ]);
    assert.deepEqual(
      (await run('registration_groups_list', {after: '1'})).groups,
      [],
    );
    assert.equal(
      (await run('registration_members_list', {groupId: other.group.id}))
        .status,
      404,
    );

    const p = registrationPacket('A. Example');
    const {member} = await registerPerson(client, f, p);
    const groupId = f.group.id;
    const pending = await run('registration_members_list', {
      groupId,
      filter: 'pending',
    });
    assert.equal(pending.members[0].id, member.id);
    const change = {
      groupId,
      memberId: member.id,
      revision: pending.members[0].revision,
    };
    assert.equal(
      (await run('registration_member_moderate', {...change, action: 'secret'}))
        .status,
      400,
    );
    assert.equal(
      (
        await run('registration_member_moderate', {
          ...change,
          action: 'approve',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await run('registration_member_rename', {
          ...change,
          name: 'Wrong revision',
        })
      ).status,
      409,
    );
    const registered = (await run('registration_members_list', {groupId}))
      .members[0];
    assert.equal(
      (
        await run('registration_member_rename', {
          ...change,
          revision: registered.revision,
          name: 'Alice Example',
        })
      ).status,
      200,
    );
    const {votingId} = await registerPerson(client, f);
    const voter = {
      link: {id: votingId},
      session: p.session,
      question: f.question,
    };

    const hidden = (
      await lifecycle(
        client,
        f.admin,
        await readyQuestion(client, f.admin, {hideResultsUntilEnd: true}),
        'open',
      )
    ).question;
    const anonymous = (
      await lifecycle(
        client,
        f.admin,
        await readyQuestion(client, f.admin, {anonymous: true}),
        'open',
      )
    ).question;
    for (const question of [f.question, hidden, anonymous]) {
      assert(
        (await cast(client, {...voter, question}, ballotInput(question)))
          .answer,
      );
    }
    // An answer from another group in the same room is never included
    const key = linkItem('Other students', 'registration');
    const [anotherGroup] = await addLinks(client, f.admin, [key]);
    const {session} = await openLink(client, anotherGroup, key.key);
    const otherPacket = registrationPacket('Other member');
    const anotherVoter = await registerPerson(
      client,
      {group: anotherGroup, session},
      otherPacket,
    );
    assert(
      (
        await cast(
          client,
          {
            link: {id: anotherVoter.votingId},
            session: otherPacket.session,
            question: f.question,
          },
          ballotInput(f.question),
        )
      ).answer,
    );

    const questionId = f.question.id;
    const query = {groupId, questionId};
    const grouped = await run('registration_results', query);
    assert.deepEqual(grouped, {
      status: 200,
      available: true,
      groupId,
      questionId,
      nextCursor: null,
      answers: [
        {
          memberId: member.id,
          name: 'Alice Example',
          choices: [f.question.choices[0].id],
        },
      ],
    });
    assert.equal(
      (
        await run('registration_results', {
          ...query,
          questionId: other.question.id,
        })
      ).status,
      404,
    );
    const named = (await run('results_get', {questionId})).result;
    assert.equal(named.total, 2);
    assert.equal(
      named.people.find((person) => person.linkId === votingId).name,
      'Alice Example',
    );
    assert.deepEqual(
      (
        await run('registration_results', {
          ...query,
          after: named.people.find((person) => person.linkId === votingId).id,
        })
      ).answers,
      [],
    );
    assert(
      (await run('results_list')).questions.some(
        (question) => question.id === questionId,
      ),
    );
    const allocation = (
      await lifecycle(
        client,
        f.admin,
        await readyQuestion(client, f.admin, {
          questionType: 'allocation',
          choiceMode: 'multiple',
          minChoices: 2,
          maxChoices: 2,
          allowAnswerChange: true,
          choices: [
            {content: 'A', capacity: 2},
            {content: 'B', capacity: 2},
          ],
        }),
        'open',
      )
    ).question;
    const allocationVoter = {...voter, question: allocation};
    const partial = await cast(
      client,
      allocationVoter,
      ballotInput(allocation),
    );
    assert.equal(partial.status, 200);
    const allocationQuery = {...query, questionId: allocation.id};
    assert.deepEqual(
      (await run('registration_results', allocationQuery)).answers,
      [],
    );
    assert.equal((await run('results_summary')).report.answers, 3);
    const complete = await cast(
      client,
      allocationVoter,
      ballotInput(allocation, {
        choices: allocation.choices.map((choice) => choice.id),
        ballotRevision: partial.answer.revision,
      }),
    );
    assert.equal(complete.status, 200);
    assert.equal(
      (await run('registration_results', allocationQuery)).answers.length,
      1,
    );
    for (const question of [hidden, anonymous]) {
      assert.deepEqual(
        await run('registration_results', {...query, questionId: question.id}),
        {status: 200, available: false},
      );
      assert.equal(
        (await run('results_get', {questionId: question.id})).result.people,
        undefined,
      );
    }
    assert.equal(
      (await run('results_get', {questionId: hidden.id})).result.available,
      false,
    );
    assert.equal(
      (await run('results_get', {questionId: anonymous.id})).result.total,
      1,
    );
    assert.equal(
      (await lifecycle(client, f.admin, hidden, 'close')).status,
      200,
    );
    assert.equal(
      (await run('registration_results', {...query, questionId: hidden.id}))
        .answers.length,
      1,
    );

    await rollbackFrom(databaseUrl, '1796083200000');
    assert.equal((await run('registration_groups_list')).status, 403);
    await runMigrations({databaseUrl});
    assert.deepEqual(await run('registration_results', query), grouped);
  });
});

test('registration sources stay separate in question and room results across rollback and reapply', async () => {
  await withDatabase(async ({client, databaseUrl}) => {
    await runMigrations({databaseUrl});
    const f = await registrationFixture(client, false);
    const packet = registrationPacket();
    const person = await registerPerson(client, f, packet);
    const voter = {
      link: {id: person.votingId},
      session: packet.session,
      question: f.question,
    };
    assert.equal(
      (await cast(client, voter, ballotInput(f.question))).status,
      200,
    );
    const read = () => results(client, f, true, f.question.id);
    const report = () => results(client, f, true, null, {view: 'summary'});
    assert.deepEqual((await read()).result.sources, {
      personal: 0,
      reusable: 0,
      registration: 1,
      admin_manual: 0,
    });
    assert.deepEqual((await report()).report.sources, [
      {kind: 'registration', answers: 1},
    ]);

    const presence = async () =>
      (
        await client.query('SELECT vm_admin_presence($1,$2,$3) AS reply', [
          f.admin.room.id,
          hash(f.admin.session),
          JSON.stringify([f.group.id]),
        ])
      ).rows[0].reply.links[0];
    assert.equal((await presence()).registeredCount, 1);
    const key = linkItem('Pending group', 'registration');
    const [pendingGroup] = await addLinks(client, f.admin, [
      {...key, requireModeration: true},
    ]);
    const {session} = await openLink(client, pendingGroup, key.key);
    const pending = await registerPerson(
      client,
      {group: pendingGroup, session},
      registrationPacket('Pending'),
    );
    const {
      rows: [{reply: presencePage}],
    } = await client.query('SELECT vm_admin_presence($1,$2,$3) AS reply', [
      f.admin.room.id,
      hash(f.admin.session),
      JSON.stringify([pendingGroup.id]),
    ]);
    assert.equal(presencePage.links[0].pendingCount, 1);
    assert.equal(presencePage.links[0].registeredCount, 0);
    assert.equal(pending.member.state, 'pending');

    await client.query(
      "CREATE VIEW external_sources AS SELECT vm_results(NULL::uuid,NULL::bytea,true,NULL::uuid,'{}'::jsonb)",
    );
    await assert.rejects(
      runMigrations({databaseUrl, direction: 'down'}),
      /depend/,
    );
    assert.equal((await read()).result.sources.registration, 1);
    await client.query('DROP VIEW external_sources');
    await runMigrations({databaseUrl, direction: 'down'});
    assert.equal((await read()).result.sources.registration, undefined);
    await runMigrations({databaseUrl});
    assert.equal((await read()).result.sources.registration, 1);
    assert.equal((await report()).report.answers, 1);
  });
});
