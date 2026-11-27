// The database's room: what's using it, and the daily cleanup of what isn't needed any more.
// The database is PGlite.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.TZ = 'UTC';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const B = require('../src/board/board');
const T = require('../src/board/triage');
const models = require('../src/models/store');
const storage = require('../src/storage');

async function createDb() {
  const pg = new PGlite();
  await pg.exec(`SET TIME ZONE 'UTC'`);
  return {
    $queryRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).affectedRows ?? 0,
  };
}

const NOW = new Date('2026-11-27T12:00:00Z');
const ago = days => new Date(NOW - days * 86400000);
const PNG = n => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(n)]);
const KB = 1024;

// A message from Discord with one image, kept the way the board keeps it.
async function message(prisma, id, postedDaysAgo, size) {
  await T.addMessage({ id, channelId: '222222222222222222', authorId: '111111111111111111', authorName: 'Ruku', content: 'wip',
    postedAt: ago(postedDaysAgo).toISOString(), attachments: [{ name: `${id}.png`, url: `https://cdn/${id}.png`, contentType: 'image/png', size: 10 }] },
  prisma, async () => ({ ok: true, arrayBuffer: async () => PNG(size) }));
  const [m] = await prisma.$queryRawUnsafe(`SELECT attachments FROM "BoardMessage" WHERE id = $1`, id);
  const imageId = m.attachments[0].imageId;
  await prisma.$executeRawUnsafe(`UPDATE "BoardImage" SET "createdAt" = $2 WHERE id = $1`, imageId, ago(postedDaysAgo));
  return imageId;
}

async function model(prisma, id, fields) {
  await models.ensureSchema(prisma);
  await prisma.$executeRawUnsafe(`INSERT INTO "ModelFile" (id, name, blend, glb) VALUES ($1, $2, $3, $4)`, id, `${id}.blend`, Buffer.alloc(300 * KB), Buffer.alloc(100 * KB));
  for (const [k, v] of Object.entries(fields)) await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "${k}" = $2 WHERE id = $1`, id, v);
}

test('the readout says what is using the room and what the cleanup would free; the cleanup frees just that', async () => {
  const prisma = await createDb();
  await B.ensureSchema(prisma);
  // Discord images: one gone through with nothing open (goes), one still in an open suggestion (stays),
  // one waiting to be gone through (stays), one too old (goes even though it's open).
  const done = await message(prisma, '900000000000000001', 1, 50 * KB);
  const open = await message(prisma, '900000000000000002', 1, 60 * KB);
  const waiting = await message(prisma, '900000000000000003', 0.1, 70 * KB);
  const old = await message(prisma, '900000000000000004', 20, 80 * KB);
  await prisma.$executeRawUnsafe(`UPDATE "BoardMessage" SET "triagedAt" = $1 WHERE id <> '900000000000000003'`, ago(0.5));
  await prisma.$executeRawUnsafe(`INSERT INTO "BoardSuggestion" (id, action, summary, "messageIds") VALUES
    ('s1', 'needs_reply', 'open one', '["900000000000000002", "900000000000000004"]'::jsonb),
    ('s2', 'needs_reply', 'dealt with', '["900000000000000001"]'::jsonb)`);
  await prisma.$executeRawUnsafe(`UPDATE "BoardSuggestion" SET status = 'dismissed' WHERE id = 's2'`);
  // A reference image someone added: always kept.
  const card = await B.createCard({ name: 'Rukia' }, 'Alex', prisma);
  await B.addImage({ issueId: card.id, kind: 'ref', data: PNG(40 * KB) }, prisma);
  // Models: an FBX imported 10 days ago (goes), one imported yesterday (stays), one still on its way (stays);
  // an .rbxm posted 10 days ago (goes), one still waiting to be posted (stays).
  await model(prisma, 'm1', { studioFbx: Buffer.alloc(200 * KB), studioStatus: 'done', studioAt: ago(10), rbxm: Buffer.alloc(90 * KB), rbxmPost: '{"state":"posted"}', rbxmAt: ago(10) });
  await model(prisma, 'm2', { studioFbx: Buffer.alloc(210 * KB), studioStatus: 'done', studioAt: ago(1), rbxm: Buffer.alloc(95 * KB), rbxmPost: '{"state":"waiting"}', rbxmAt: ago(10) });
  await model(prisma, 'm3', { studioFbx: Buffer.alloc(220 * KB), studioStatus: 'uploading', studioAt: ago(10) });

  const r = await storage.report(prisma, NOW);
  const part = k => r.parts.find(p => p.key === k);
  assert.equal(part('discord').count, 4);
  assert.equal(part('discord').freeableCount, 2, 'the one gone through and the old one');
  assert.equal(part('fbx').freeableCount, 1);
  assert.equal(part('rbxm').freeableCount, 1);
  assert.equal(part('blend').bytes, 900 * KB);
  assert.equal(part('blend').freeable, 0, 'model files are never cleared');
  assert.equal(part('refs').count, 1);
  assert.equal(r.freeable, part('discord').freeable + 200 * KB + 90 * KB);
  assert.ok(r.total > 0, 'the database\'s own size');

  const res = await storage.cleanup(prisma, NOW, 'Alex');
  assert.deepEqual([res.images, res.fbx, res.rbxm, res.freed], [2, 1, 1, r.freeable]);
  const left = (await prisma.$queryRawUnsafe(`SELECT id FROM "BoardImage" WHERE kind = 'msg'`)).map(x => x.id).sort();
  assert.deepEqual(left, [open, waiting].sort());
  assert.equal((await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "BoardImage" WHERE kind = 'ref'`))[0].n, 1);
  // The message whose image went no longer points at it; the open one still shows its image.
  const [m4] = await prisma.$queryRawUnsafe(`SELECT attachments FROM "BoardMessage" WHERE id = '900000000000000004'`);
  assert.equal(m4.attachments[0].imageId, undefined);
  assert.equal(m4.attachments[0].name, '900000000000000004.png', 'the file is still named');
  const box = await T.inbox(prisma);
  assert.ok(box.items[0].messages.find(m => m.id === '900000000000000002').files[0].imageUrl);
  assert.equal(box.items[0].messages.find(m => m.id === '900000000000000004').files[0].imageUrl, null);
  const rows = await prisma.$queryRawUnsafe(`SELECT id, "studioFbx" IS NOT NULL AS fbx, rbxm IS NOT NULL AS rbxm, blend IS NOT NULL AS blend FROM "ModelFile" ORDER BY id`);
  assert.deepEqual(rows.map(x => [x.id, x.fbx, x.rbxm, x.blend]), [['m1', false, false, true], ['m2', true, true, true], ['m3', true, false, true]]);
  assert.equal(done.length > 0, true);
  assert.equal(old.length > 0, true);

  // Nothing more to clear; the last run is remembered.
  const again = await storage.cleanup(prisma, NOW);
  assert.equal(again.freed, 0);
  assert.equal((await storage.report(prisma, NOW)).lastCleanup.by, 'daily');
});

test('a database without the Models tables yet still reports and cleans', async () => {
  const prisma = await createDb();
  const r = await storage.report(prisma, NOW);
  assert.equal(r.parts.find(p => p.key === 'blend').bytes, 0);
  assert.equal((await storage.cleanup(prisma, NOW)).freed, 0);
});
