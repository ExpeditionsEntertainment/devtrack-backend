// shiny-layout.js
// Units used to keep shinies as subtasks: Mesh › Shiny and Texture › Shiny. They're now laid out as
//   Mesh > Texture (subtask)   and   Shiny Mesh > Shiny Texture (subtask)
// This moves every unit card over once, keeping each task's status, developer, history, deliveries
// and number (it moves and renames tasks; it never deletes one). A piece a card was missing is
// added as Untasked, so every unit has all four.

const B = require('./board');
const crypto = require('crypto');

const isShiny = n => /shiny/i.test(n);
const isTexture = n => /texture/i.test(n);
const isMesh = n => /mesh|model/i.test(n) && !isTexture(n);

async function convert(prisma) {
  const cards = await prisma.$queryRawUnsafe(`SELECT id FROM "BoardCard" WHERE kind = 'unit'`);
  const all = await prisma.$queryRawUnsafe(`SELECT id, "cardId", "parentId", name FROM "BoardCardTask"`);
  const out = { cards: 0, moved: 0, added: 0 };

  const move = async (t, parentId, name) => {
    if (t.parentId === parentId && t.name === name) return;
    await prisma.$executeRawUnsafe(`UPDATE "BoardCardTask" SET "parentId" = $2, name = $3, "updatedAt" = now() WHERE id = $1`, t.id, parentId, name);
    t.parentId = parentId; t.name = name; out.moved++;
  };
  const add = async (cardId, parentId, name) => {
    const id = crypto.randomUUID();
    await prisma.$executeRawUnsafe(`INSERT INTO "BoardCardTask" (id, identifier, "cardId", "parentId", name) VALUES ($1, $2, $3, $4, $5)`,
      id, await B.nextIdentifier(prisma), cardId, parentId, name);
    out.added++;
    return { id, cardId, parentId, name };
  };

  for (const { id: cardId } of cards) {
    const tasks = all.filter(t => t.cardId === cardId);
    const top = tasks.filter(t => !t.parentId);
    const kids = id => tasks.filter(t => id && t.parentId === id);
    let mesh = top.find(t => !isShiny(t.name) && isMesh(t.name));
    const texture = top.find(t => !isShiny(t.name) && isTexture(t.name))
      || (mesh && kids(mesh.id).find(t => !isShiny(t.name) && isTexture(t.name)));
    let shinyMesh = top.find(t => isShiny(t.name) && isMesh(t.name));
    let shinyTexture = tasks.find(t => isShiny(t.name) && isTexture(t.name));
    // The old shiny subtasks: "Shiny" under Mesh is the shiny mesh, under Texture the shiny texture.
    for (const k of kids(mesh?.id).filter(k => isShiny(k.name) && k !== shinyTexture)) shinyMesh = shinyMesh || k;
    for (const k of kids(texture?.id).filter(k => isShiny(k.name) && k !== shinyMesh)) shinyTexture = shinyTexture || k;
    if (!mesh && !texture && !shinyMesh && !shinyTexture) continue;

    mesh = mesh || await add(cardId, null, 'Mesh');
    if (texture) {
      // Texture becomes a subtask, so anything else under it moves up to Mesh (a subtask can't have its own).
      for (const k of kids(texture.id).filter(k => k !== shinyTexture && k !== shinyMesh)) await move(k, mesh.id, k.name);
      await move(texture, mesh.id, texture.name);
    } else await add(cardId, mesh.id, 'Texture');
    if (shinyMesh) await move(shinyMesh, null, 'Shiny Mesh');
    else shinyMesh = await add(cardId, null, 'Shiny Mesh');
    if (shinyTexture) await move(shinyTexture, shinyMesh.id, 'Shiny Texture');
    else await add(cardId, shinyMesh.id, 'Shiny Texture');
    out.cards++;
  }
  return out;
}

// Runs once: remembered in BoardSetting "shinyLayout".
async function convertOnce(prisma) {
  if (await B.getMeta('shinyLayout', prisma)) return null;
  const r = await convert(prisma);
  await B.setMeta('shinyLayout', { at: new Date(), ...r }, prisma);
  return r;
}

module.exports = { convert, convertOnce };
