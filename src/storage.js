// storage.js
// What's taking room in the database, and clearing out what isn't needed any more.
// On 2026-11-27 the 500 MB disk filled up and Postgres stopped: nothing below was ever
// deleted. Files kept in the database, and when each can go:
//
//   Discord images      every image posted in a channel the Assets board reads ("BoardImage",
//                       kind 'msg'), kept so the From Discord list can show them. Gone once the
//                       message has been gone through and no open suggestion shows it, or after
//                       DISCORD_IMAGE_DAYS anyway. One used as a reference was copied, so it stays.
//   Studio FBX          the FBX "Send to Studio" made ("ModelFile"."studioFbx"), only needed until
//                       the Mac has imported it; a new one is made every time. Gone STUDIO_FBX_DAYS
//                       after the import finished (or failed).
//   .rbxm               saved from Studio and posted to Discord by the bot ("rbxm"). Gone
//                       RBXM_DAYS after it was posted; the copy on Discord is the one people use.
//
// Kept: the .blend files, their previews, edited .blends, card images and references.
// The cleanup runs once a day; Postgres reuses the room for new data (the disk's size on
// Railway doesn't go down by itself).

const { getPrisma } = require('./assets/db');
const B = require('./board/board');

const DISCORD_IMAGE_DAYS = 14;
const STUDIO_FBX_DAYS = 7;
const RBXM_DAYS = 7;
const DAY = 86400000;

const has = async (prisma, table) => (await prisma.$queryRawUnsafe(`SELECT to_regclass($1) IS NOT NULL AS ok`, `"${table}"`))[0].ok;
const num = v => Number(v || 0);

// The Discord images that can go: their message has been gone through and nothing open shows
// them, or they're older than DISCORD_IMAGE_DAYS.
const DISCORD_DONE = `
  SELECT i.id FROM "BoardImage" i WHERE i.kind = 'msg' AND (
    i."createdAt" < $1
    OR EXISTS (
      SELECT 1 FROM "BoardMessage" m, jsonb_array_elements(m.attachments) a
      WHERE a->>'imageId' = i.id AND m."triagedAt" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "BoardSuggestion" s WHERE s.status = 'open' AND s."messageIds" ? m.id))
    OR NOT EXISTS (SELECT 1 FROM "BoardMessage" m, jsonb_array_elements(m.attachments) a WHERE a->>'imageId' = i.id))`;
const FBX_DONE = `"studioFbx" IS NOT NULL AND "studioStatus" IN ('done', 'failed') AND "studioAt" < $1`;
const RBXM_DONE = `rbxm IS NOT NULL AND "rbxmPost"->>'state' = 'posted' AND "rbxmAt" < $1`;

const cutoffs = now => ({
  discord: new Date(now - DISCORD_IMAGE_DAYS * DAY), fbx: new Date(now - STUDIO_FBX_DAYS * DAY), rbxm: new Date(now - RBXM_DAYS * DAY),
});

// What's using the room, in bytes, and how much the cleanup would free now.
async function report(prisma = getPrisma(), now = new Date()) {
  await B.ensureSchema(prisma);
  const c = cutoffs(now);
  const [imgs] = await prisma.$queryRawUnsafe(`SELECT
      COALESCE(SUM(octet_length(data)) FILTER (WHERE kind = 'msg'), 0)::bigint AS discord, COUNT(*) FILTER (WHERE kind = 'msg')::int AS "discordCount",
      COALESCE(SUM(octet_length(data)) FILTER (WHERE kind <> 'msg'), 0)::bigint AS refs, COUNT(*) FILTER (WHERE kind <> 'msg')::int AS "refsCount"
    FROM "BoardImage"`);
  const [discordFree] = await prisma.$queryRawUnsafe(`SELECT COALESCE(SUM(octet_length(data)), 0)::bigint AS bytes, COUNT(*)::int AS n
    FROM "BoardImage" WHERE id IN (${DISCORD_DONE})`, c.discord);
  let models = { blend: 0, previews: 0, edited: 0, fbx: 0, rbxm: 0, count: 0 }, fbxFree = { bytes: 0, n: 0 }, rbxmFree = { bytes: 0, n: 0 };
  if (await has(prisma, 'ModelFile')) {
    // Older databases may not have every column yet; the Models page adds them on first use.
    await require('./models/store').ensureSchema(prisma);
    [models] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS count,
        COALESCE(SUM(octet_length(blend)), 0)::bigint AS blend,
        COALESCE(SUM(COALESCE(octet_length(glb), 0) + COALESCE(octet_length("editedGlb"), 0)), 0)::bigint AS previews,
        COALESCE(SUM(octet_length("editedBlend")), 0)::bigint AS edited,
        COALESCE(SUM(octet_length("studioFbx")), 0)::bigint AS fbx,
        COALESCE(SUM(octet_length(rbxm)), 0)::bigint AS rbxm
      FROM "ModelFile"`);
    [fbxFree] = await prisma.$queryRawUnsafe(`SELECT COALESCE(SUM(octet_length("studioFbx")), 0)::bigint AS bytes, COUNT(*)::int AS n FROM "ModelFile" WHERE ${FBX_DONE}`, c.fbx);
    [rbxmFree] = await prisma.$queryRawUnsafe(`SELECT COALESCE(SUM(octet_length(rbxm)), 0)::bigint AS bytes, COUNT(*)::int AS n FROM "ModelFile" WHERE ${RBXM_DONE}`, c.rbxm);
  }
  let total = null;
  try { total = num((await prisma.$queryRawUnsafe(`SELECT pg_database_size(current_database())::bigint AS n`))[0].n); } catch { /* not every Postgres lets us ask */ }
  const parts = [
    { key: 'discord', label: 'Images from Discord messages', bytes: num(imgs.discord), count: imgs.discordCount, freeable: num(discordFree.bytes), freeableCount: discordFree.n,
      keeps: `Cleared once a message has been gone through, or after ${DISCORD_IMAGE_DAYS} days. Ones you used as references are kept.` },
    { key: 'blend', label: 'Model files (.blend)', bytes: num(models.blend), count: models.count, freeable: 0, keeps: 'Kept: the files you name the parts in.' },
    { key: 'previews', label: 'Model previews', bytes: num(models.previews), freeable: 0, keeps: 'Kept: what the Models page shows.' },
    { key: 'edited', label: 'Edited .blend files', bytes: num(models.edited), freeable: 0, keeps: 'Kept until you remove them on the Models page.' },
    { key: 'fbx', label: 'FBX files sent to Studio', bytes: num(models.fbx), freeable: num(fbxFree.bytes), freeableCount: fbxFree.n,
      keeps: `Cleared ${STUDIO_FBX_DAYS} days after Studio imported them; a new one is made each time you send.` },
    { key: 'rbxm', label: '.rbxm files', bytes: num(models.rbxm), freeable: num(rbxmFree.bytes), freeableCount: rbxmFree.n,
      keeps: `Cleared ${RBXM_DAYS} days after the bot posted them to Discord.` },
    { key: 'refs', label: 'Card images and references', bytes: num(imgs.refs), count: imgs.refsCount, freeable: 0, keeps: 'Kept.' },
  ];
  const files = parts.reduce((n, p) => n + p.bytes, 0);
  return {
    total, files, other: total == null ? null : Math.max(0, total - files), parts,
    freeable: parts.reduce((n, p) => n + p.freeable, 0), lastCleanup: await B.getMeta('storageCleanup', prisma),
  };
}

// Clears what isn't needed any more. Returns what went.
async function cleanup(prisma = getPrisma(), now = new Date(), by = 'daily') {
  await B.ensureSchema(prisma);
  const c = cutoffs(now);
  const before = await report(prisma, now);
  const gone = await prisma.$queryRawUnsafe(`DELETE FROM "BoardImage" WHERE id IN (${DISCORD_DONE}) RETURNING id`, c.discord);
  // The messages' files lose their link to an image that's gone, so the list never shows a broken one.
  if (gone.length) {
    await prisma.$executeRawUnsafe(`UPDATE "BoardMessage" m SET attachments = (
        SELECT COALESCE(jsonb_agg(CASE WHEN a->>'imageId' = ANY($1::text[]) THEN a - 'imageId' - 'imageUrl' ELSE a END), '[]'::jsonb)
        FROM jsonb_array_elements(m.attachments) a)
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(m.attachments) a WHERE a->>'imageId' = ANY($1::text[]))`, gone.map(g => g.id));
  }
  let fbx = 0, rbxm = 0;
  if (await has(prisma, 'ModelFile')) {
    fbx = await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "studioFbx" = NULL WHERE ${FBX_DONE}`, c.fbx);
    rbxm = await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET rbxm = NULL WHERE ${RBXM_DONE}`, c.rbxm);
  }
  const freed = before.parts.find(p => p.key === 'discord').freeable + before.parts.find(p => p.key === 'fbx').freeable + before.parts.find(p => p.key === 'rbxm').freeable;
  const result = { at: now, by, images: gone.length, fbx: num(fbx), rbxm: num(rbxm), freed };
  await B.setMeta('storageCleanup', result, prisma);
  if (freed) console.log(`[Storage] Cleared ${gone.length} Discord image(s), ${result.fbx} Studio FBX(s), ${result.rbxm} .rbxm(s): ${(freed / 1048576).toFixed(1)} MB`);
  return result;
}

// Once a day: checked every hour, run when the last one is a day old.
let timer = null;
function start(prisma = getPrisma()) {
  if (timer) return;
  const tick = async () => {
    try {
      const last = await B.getMeta('storageCleanup', prisma);
      if (!last?.at || Date.now() - new Date(last.at) >= DAY) await cleanup(prisma);
    } catch (err) { console.error('[Storage] Cleanup failed:', err.message); }
  };
  setTimeout(tick, 60 * 1000);
  timer = setInterval(tick, 60 * 60 * 1000);
}

module.exports = { report, cleanup, start, DISCORD_IMAGE_DAYS, STUDIO_FBX_DAYS, RBXM_DAYS };
