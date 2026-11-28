// Shinies move from Mesh › Shiny and Texture › Shiny to Shiny Mesh › Shiny Texture, with Texture under Mesh.
// The database is PGlite.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.TZ = 'UTC';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const B = require('../src/board/board');
const shiny = require('../src/board/shiny-layout');

async function createDb() {
  const pg = new PGlite();
  await pg.exec(`SET TIME ZONE 'UTC'`);
  return {
    $queryRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).affectedRows ?? 0,
  };
}

// The card's layout as "Parent > Child [status, dev]" lines, parents in template order.
async function layout(prisma, ref) {
  const card = (await B.board(prisma)).cards.find(c => c.identifier === ref || c.id === ref);
  const line = t => `${t.name} [${t.status}${t.devName ? `, ${t.devName}` : ''}]`;
  return card.tasks.flatMap(t => [line(t), ...t.subtasks.map(s => `  ${line(s)}`)]);
}

test('a unit with the old shiny subtasks keeps every status and developer in the new layout', async () => {
  const prisma = await createDb();
  await B.ensureSchema(prisma);
  const card = await B.createCard({ name: 'Rukia', tasks: [{ name: 'Mesh', subtasks: ['Shiny'] }, { name: 'Texture', subtasks: ['Shiny'] }, { name: 'Aura' }] }, 'Alex', prisma);
  const tasks = await prisma.$queryRawUnsafe(`SELECT * FROM "BoardCardTask" WHERE "cardId" = $1`, card.id);
  const top = n => tasks.find(t => !t.parentId && t.name === n);
  const under = (p, n) => tasks.find(t => t.parentId === top(p).id && t.name === n);
  await B.setStatus(top('Mesh').identifier, 'done', null, 'Alex', prisma);
  await B.setStatus(top('Texture').identifier, 'done', null, 'Alex', prisma);
  await B.setStatus(under('Mesh', 'Shiny').identifier, 'done', null, 'Alex', prisma);
  await prisma.$executeRawUnsafe(`UPDATE "BoardCardTask" SET status = 'in_progress', "devName" = 'Ruku' WHERE id = $1`, under('Texture', 'Shiny').id);
  const shinyTextureRef = under('Texture', 'Shiny').identifier;

  const r = await shiny.convertOnce(prisma);
  assert.deepEqual([r.cards, r.added], [1, 0], 'nothing needed adding');
  const rows = await layout(prisma, card.id);
  assert.ok(rows.includes('Mesh [done]'));
  assert.ok(rows.includes('  Texture [done]'));
  assert.ok(rows.includes('Shiny Mesh [done]'));
  assert.ok(rows.includes('  Shiny Texture [in_progress, Ruku]'));
  assert.ok(rows.includes('Aura [untasked]'));
  // The same task, number and all: it moved, it wasn't remade.
  assert.equal((await B.findTask(shinyTextureRef, prisma)).name, 'Shiny Texture');
  assert.equal(rows.length, 5);
  // Only once.
  assert.equal(await shiny.convertOnce(prisma), null);
});

test('missing pieces are added as untasked; misc cards and new units are left alone', async () => {
  const prisma = await createDb();
  await B.ensureSchema(prisma);
  const old = await B.createCard({ name: 'Aizen', tasks: [{ name: 'Mesh' }, { name: 'Texture', subtasks: ['Shiny', 'Hair'] }] }, 'Alex', prisma);
  await B.setStatus((await prisma.$queryRawUnsafe(`SELECT identifier FROM "BoardCardTask" WHERE "cardId" = $1 AND name = 'Texture'`, old.id))[0].identifier, 'done', null, 'Alex', prisma);
  const pet = await B.createCard({ name: 'Dog', kind: 'misc', tasks: [{ name: 'Mesh', subtasks: ['Shiny'] }] }, 'Alex', prisma);

  const r = await shiny.convert(prisma);
  assert.equal(r.cards, 1);
  assert.deepEqual(await layout(prisma, old.id), [
    'Mesh [untasked]', '  Hair [untasked]', '  Texture [done]', 'Shiny Mesh [untasked]', '  Shiny Texture [untasked]',
  ]);
  assert.deepEqual(await layout(prisma, pet.id), ['Mesh [untasked]', '  Shiny [untasked]'], 'misc cards keep their layout');
  // Running it again changes nothing.
  assert.deepEqual(await shiny.convert(prisma), { cards: 1, moved: 0, added: 0 });

  // A new unit starts in the new layout.
  const fresh = await B.createCard({ name: 'Ichigo' }, 'Alex', prisma);
  const rows = await layout(prisma, fresh.id);
  assert.deepEqual(rows.slice(0, 5), ['Animations [untasked]', 'Mesh [untasked]', '  Texture [untasked]', 'Shiny Mesh [untasked]', '  Shiny Texture [untasked]']);
});
