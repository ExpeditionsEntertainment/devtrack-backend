// Model viewer: upload, conversion, naming, export plan.
// With BLENDER_PATH and MODEL_TEST_BLEND set, the last test runs real Blender.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { PGlite } = require('@electric-sql/pglite');
const store = require('../src/models/store');

async function createDb() {
  const pg = new PGlite();
  await pg.exec(`SET TIME ZONE 'UTC'`);
  return {
    $queryRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).affectedRows ?? 0,
  };
}

const PARTS = ['Arm', 'Arm.001', 'Cube', 'Head', 'Hair', 'Strap', 'Strap.001', 'Junk'].map(name => ({ name, verts: 8 }));
const fakeInspect = async () => ({ glb: Buffer.from('glTF fake'), parts: PARTS, blender: '5.2.3' });
const BLEND = Buffer.concat([Buffer.from('BLENDER-v405'), Buffer.alloc(32)]);
const until = async check => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('timed out'); };

test('a .blend is stored, converted, named and planned for export', async () => {
  const prisma = await createDb();
  await assert.rejects(store.create({ name: 'x.blend', blend: Buffer.from('not a blend') }, prisma, fakeInspect), /not a \.blend/);

  const { id } = await store.create({ name: 'Unit.blend', blend: BLEND, uploadedBy: 'Alex', sourceUrl: 'https://discord.com/x' }, prisma, fakeInspect);
  await until(async () => (await store.get(id, prisma, fakeInspect)).status === 'ready');
  const model = await store.get(id, prisma, fakeInspect);
  assert.equal(model.partCount, 8);
  assert.deepEqual(model.assignments, { Head: 'Head' }, 'a part already called Head starts as Head');
  assert.equal((await store.file(id, 'glb', prisma)).data.toString(), 'glTF fake');
  assert.equal((await store.list(prisma))[0].assigned, 1);

  await assert.rejects(store.setAssignments(id, { Cube: 'Torso', Arm: 'Torso' }, prisma), /Torso is on both/);
  await assert.rejects(store.setAssignments(id, { Nope: 'Torso' }, prisma), /No part/);
  await assert.rejects(store.setAssignments(id, { Cube: 'Tail' }, prisma), /not a category/);

  const saved = await store.setAssignments(id, {
    Cube: 'Head', Head: 'Head Accessory', Hair: 'Head Accessory', Arm: 'Right Arm', 'Arm.001': 'Left Arm',
    Strap: 'Left Arm Accessory', 'Strap.001': 'Left Arm Accessory', Junk: 'drop',
  }, prisma, { Hair: ' Hair! ', Strap: 'Sleeve', 'Strap.001': 'Sleeve' });
  assert.equal(saved.Junk, 'drop');
  assert.deepEqual((await store.get(id, prisma)).labels, { Hair: 'Hair', Strap: 'Sleeve', 'Strap.001': 'Sleeve' }, 'the word for an accessory is kept, cleaned');
  await store.setAssignments(id, saved, prisma); // saving names without words leaves the words alone
  assert.equal((await store.get(id, prisma)).labels.Hair, 'Hair');

  let given = null;
  const out = await store.exportModel(id, 'Alex', prisma, async (blend, plan) => { given = { blend, plan }; return Buffer.from('FBX'); });
  assert.equal(out.name, 'Unit.fbx');
  assert.equal(out.data.toString(), 'FBX');
  assert.deepEqual(given.blend, BLEND);
  assert.equal(given.plan.embed, true, 'textures embedded unless told no');
  assert.equal(given.plan.scale, 0.01, 'scaled to 0.01 unless told no');
  const plain = await store.exportModel(id, 'Alex', prisma, async (blend, plan) => plan, { embedTextures: false, smallScale: false });
  assert.equal(plain.data.embed, false);
  assert.equal(plain.data.scale, 1);
  assert.equal(given.plan.fixFaces, false, 'faces left alone unless asked (Invert Negative Faces defaults to No)');
  const inverted = await store.exportModel(id, 'Alex', prisma, async (blend, plan) => plan, { invertFaces: true });
  assert.equal(inverted.data.fixFaces, true);
  delete given.plan.embed; delete given.plan.scale; delete given.plan.fixFaces; delete given.plan.rigs;
  assert.deepEqual(given.plan.splits, []);
  delete given.plan.splits;
  assert.deepEqual(given.plan.accessories, []);
  delete given.plan.accessories;
  // The house style of a finished unit: ArmRight, "Head Hair", numbered when there's no word, " 2" on a repeat.
  assert.deepEqual(given.plan, {
    rename: {
      Arm: 'ArmRight', 'Arm.001': 'ArmLeft', Cube: 'Head', Head: 'Head Accessory 1', Hair: 'Head Hair',
      Strap: 'ArmLeft Sleeve', 'Strap.001': 'ArmLeft Sleeve 2',
    },
    drop: ['Junk'],
  });
  assert.ok((await store.get(id, prisma)).exportedAt);
});

test('a part already named in the house style starts named', async () => {
  const prisma = await createDb();
  const inspect = async () => ({ glb: Buffer.from('glTF'), parts: ['ArmRight', 'legleft', 'Torso', 'Hat'].map(name => ({ name, verts: 8 })), blender: '5.2.3' });
  const { id } = await store.create({ name: 'Cid.blend', blend: BLEND }, prisma, inspect);
  await until(async () => (await store.get(id, prisma, inspect)).status === 'ready');
  assert.deepEqual((await store.get(id, prisma)).assignments, { ArmRight: 'Right Arm', legleft: 'Left Leg', Torso: 'Torso' });
});

test('a weapon is uploaded, attached, positioned and goes into the FBX with what the Mac needs', async () => {
  const prisma = await createDb();
  const { id: unit } = await store.create({ name: 'Cid.blend', blend: BLEND }, prisma, fakeInspect);
  const FBX = Buffer.concat([Buffer.from('Kaydara FBX Binary  '), Buffer.alloc(16)]);
  const swordInspect = async (data, format) => {
    assert.equal(format, 'fbx', 'an FBX is opened as one');
    return { glb: Buffer.from('glTF sword'), parts: [{ name: 'Sword', verts: 40 }, { name: 'Empty', verts: 0 }, { name: 'Sheath', verts: 12 }], blender: '5.2.3' };
  };
  const { id: sword } = await store.create({ name: 'Cid_Sword.fbx', blend: FBX, kind: 'accessory' }, prisma, swordInspect);
  await until(async () => (await store.get(unit, prisma, fakeInspect)).status === 'ready' && (await store.get(sword, prisma, swordInspect)).status === 'ready');
  assert.equal((await store.get(sword, prisma)).kind, 'accessory');
  await assert.rejects(store.exportModel(sword, 'Alex', prisma, async () => Buffer.from('x')), /already an FBX/);

  await assert.rejects(store.addAccessory(sword, { accessoryId: sword }, prisma), /opened from a \.blend/);
  await assert.rejects(store.addAccessory(unit, { accessoryId: sword, spot: 'tail' }, prisma), /spot must be/);
  const acc = await store.addAccessory(unit, { accessoryId: sword }, prisma);
  assert.equal(acc.name, 'Cid Sword', 'named after the file');
  assert.equal(acc.spot, 'right-hand');
  assert.equal(acc.limb, 'Right Arm');
  assert.deepEqual((await store.get(sword, prisma)).attachedTo.map(a => a.name), ['Cid.blend']);

  await assert.rejects(store.exportModel(unit, 'Alex', prisma, async () => Buffer.from('x')), /Position Cid Sword/);
  await assert.rejects(store.updateAccessory(unit, acc.id, { placement: { matrix: [1, 2], handle: [0, 0, 0] } }, prisma), /16 numbers/);
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, -1, 0, 1];
  await store.setAssignments(sword, { Sheath: 'drop' }, prisma);
  const moved = await store.updateAccessory(unit, acc.id, { name: 'Cid Sword', spot: 'left-hand', placement: { matrix, handle: [0.5, -1, 0] } }, prisma);
  assert.equal(moved.limb, 'Left Arm');

  let given = null;
  const out = await store.exportModel(unit, 'Alex', prisma, async (blend, plan) => { given = plan; return Buffer.from('FBX'); });
  assert.equal(given.accessories.length, 1);
  const [a] = given.accessories;
  assert.equal(a.prefix, 'A1');
  assert.equal(a.format, 'fbx');
  assert.deepEqual(a.data, FBX);
  assert.deepEqual(a.meshes, ['Sword'], 'empty meshes and parts left out of the accessory stay out');
  assert.deepEqual(a.matrix, matrix);
  assert.deepEqual(out.accessories, [{ name: 'Cid Sword', spot: 'left-hand', limb: 'Left Arm', handle: 'A1 Handle', meshes: { 'A1 Sword': 'Sword' }, doubleSided: false }]);
  assert.deepEqual(out.doubleSided, []);

  // Double sided: a unit part by its final name (a dropped one doesn't count), and every mesh of a marked accessory.
  await assert.rejects(store.setAssignments(unit, { Arm: 'Right Arm', Junk: 'drop' }, prisma, undefined, ['Nope']), /No part/);
  await store.setAssignments(unit, { Arm: 'Right Arm', Junk: 'drop' }, prisma, undefined, ['Arm', 'Hair', 'Junk']);
  assert.deepEqual((await store.get(unit, prisma)).doubleSided, ['Arm', 'Hair', 'Junk']);
  await store.setAssignments(unit, { Arm: 'Right Arm', Junk: 'drop' }, prisma); // saving names alone leaves it as it was
  assert.deepEqual((await store.get(unit, prisma)).doubleSided, ['Arm', 'Hair', 'Junk']);
  assert.equal((await store.updateAccessory(unit, acc.id, { doubleSided: true }, prisma)).doubleSided, true);
  const studio = await store.sendToStudio(unit, 'Alex', prisma, async () => Buffer.from('FBX'));
  assert.deepEqual(studio.options.accessories.map(x => x.meshes), out.accessories.map(x => x.meshes), 'the Mac gets the accessories with the job');
  assert.deepEqual(studio.options.doubleSided, ['ArmRight', 'Hair', 'A1 Sword']);

  await store.removeAccessory(unit, acc.id, prisma);
  assert.deepEqual((await store.get(unit, prisma)).accessories, []);
});

test('a weapon in the unit\'s own file: its parts are picked, it is positioned, and it goes into the FBX like any weapon', async () => {
  const prisma = await createDb();
  const parts = ['Body', 'Arm', 'Blade', 'Pole', 'Tassel', 'Empty'].map(name => ({ name, verts: name === 'Empty' ? 0 : 8 }));
  const inspect = async () => ({ glb: Buffer.from('glTF'), parts, blender: '5.2.3' });
  const { id: unit } = await store.create({ name: 'Whitebeard.blend', blend: BLEND }, prisma, inspect);
  await until(async () => (await store.get(unit, prisma, inspect)).status === 'ready');

  const glaive = await store.addAccessory(unit, { accessoryId: unit }, prisma);
  assert.deepEqual([glaive.name, glaive.inFile, glaive.parts, glaive.spot, glaive.limb], ['Weapon', true, [], 'right-hand', 'Right Arm']);
  const second = await store.addAccessory(unit, { accessoryId: unit }, prisma);
  assert.equal(second.name, 'Weapon 2', 'a second one gets its own name');
  assert.deepEqual((await store.get(unit, prisma)).attachedTo, [], 'a unit is not "on" itself');

  // Its parts are picked like any category; a part on a weapon that doesn't exist (any more) is left unnamed.
  const W = store.WEAPON + glaive.id;
  await store.setAssignments(unit, { Body: 'Torso', Arm: 'Right Arm', Blade: W, Pole: W, Tassel: 'weapon:gone', Empty: W }, prisma, undefined, ['Blade', 'Body']);
  let model = await store.get(unit, prisma);
  assert.equal(model.assignments.Tassel, undefined);
  assert.deepEqual(model.accessories.find(a => a.id === glaive.id).parts, ['Blade', 'Pole', 'Empty'], 'in the file\'s order');

  await assert.rejects(store.exportModel(unit, 'Alex', prisma, async () => Buffer.from('x')), /Position Weapon on the unit first/);
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.3, 1, 0, 1];
  await store.updateAccessory(unit, glaive.id, { name: 'Glaive', placement: { matrix, handle: [0.3, 1, 0] } }, prisma);
  await assert.rejects(store.exportModel(unit, 'Alex', prisma, async () => Buffer.from('x')), /Weapon 2 has no parts yet/);
  await store.removeAccessory(unit, second.id, prisma);

  let given = null;
  const out = await store.exportModel(unit, 'Alex', prisma, async (blend, plan) => { given = plan; return Buffer.from('FBX'); });
  assert.deepEqual(given.rename, { Body: 'Torso', Arm: 'ArmRight' }, 'its parts are not body parts');
  assert.deepEqual(given.drop, []);
  assert.deepEqual(given.accessories, [{ prefix: 'A1', inFile: true, meshes: ['Blade', 'Pole'], matrix, handle: [0.3, 1, 0] }],
    'no file to bring in, and an empty part stays out');
  assert.deepEqual(out.accessories, [{ name: 'Glaive', spot: 'right-hand', limb: 'Right Arm', handle: 'A1 Handle', meshes: { 'A1 Blade': 'Blade', 'A1 Pole': 'Pole' }, doubleSided: false }],
    'the Mac gets it like any weapon');
  assert.deepEqual(out.doubleSided, ['A1 Blade', 'Torso'], 'a weapon part by its name in the FBX');
  const hashBefore = (await store.get(unit, prisma)).configHash;
  await store.setAssignments(unit, { Body: 'Torso', Arm: 'Right Arm', Blade: W }, prisma);
  assert.notEqual((await store.get(unit, prisma)).configHash, hashBefore, 'a rigged .blend made before a part left the weapon is not used');

  // Taken apart: its parts go back to not named.
  await store.removeAccessory(unit, glaive.id, prisma);
  model = await store.get(unit, prisma);
  assert.deepEqual(model.assignments, { Body: 'Torso', Arm: 'Right Arm' });
  assert.deepEqual(model.accessories, []);
});

test('bending parts: a cape gets bones, a rigged .blend can be downloaded, edited and used while it still matches', async () => {
  const prisma = await createDb();
  const { id } = await store.create({ name: 'Cid.blend', blend: BLEND }, prisma, fakeInspect);
  await until(async () => (await store.get(id, prisma, fakeInspect)).status === 'ready');
  const names = { Cube: 'Torso', Hair: 'Torso Accessory', Strap: 'Head Accessory' };
  const cape = { kind: 'cape', bones: 4, smooth: 0.6, chains: [{ root: [0, 3, 0.5], tip: [0, 0.5, 0.9] }, { root: [0.5, 3, 0.5], tip: [0.6, 0.5, 0.9] }] };

  await assert.rejects(store.setAssignments(id, names, prisma, undefined, undefined, { Nope: cape }), /No part/);
  await assert.rejects(store.setAssignments(id, names, prisma, undefined, undefined, { Hair: { ...cape, bones: 9 } }), /1 to 8 bones/);
  await assert.rejects(store.setAssignments(id, names, prisma, undefined, undefined, { Hair: { ...cape, chains: [{ root: [0, 1, 0], tip: [0, 1, 0] }] } }), /same point/);
  await assert.rejects(store.setAssignments(id, names, prisma, undefined, undefined, { Hair: { ...cape, kind: 'tail' } }), /kind must be/);
  // Joints moved to curve a chain: one per joint between the bones, none on top of the next.
  const curl = [[0, 2.4, 0.7], [0.4, 1.8, 0.9], [0.3, 1.1, 1.2]];
  await assert.rejects(store.setAssignments(id, names, prisma, undefined, undefined, { Hair: { ...cape, chains: [{ ...cape.chains[0], mid: curl.slice(1) }] } }), /mid needs 3 points/);
  await assert.rejects(store.setAssignments(id, names, prisma, undefined, undefined, { Hair: { ...cape, chains: [{ ...cape.chains[0], mid: [cape.chains[0].root, ...curl.slice(1)] }] } }), /same point/);
  await store.setAssignments(id, names, prisma, undefined, undefined, { Hair: { ...cape, chains: [{ ...cape.chains[0], mid: curl }] } });
  assert.deepEqual((await store.get(id, prisma)).rigs.Hair.chains[0].mid, curl);
  // A rig on a body part (Cube is Torso) is kept but not made: the body stays R6.
  await store.setAssignments(id, names, prisma, { Hair: 'Cape' }, undefined, { Hair: cape, Cube: { ...cape, chains: cape.chains.slice(0, 1) } });
  assert.equal(Object.keys((await store.get(id, prisma)).rigs).length, 2);

  let given = null;
  const out = await store.exportModel(id, 'Alex', prisma, async (blend, p) => { given = p; return Buffer.from('FBX'); });
  assert.equal(given.rigs.length, 1, 'only the accessory part is rigged');
  const [r] = given.rigs;
  assert.equal(r.mesh, 'Torso Cape');
  assert.deepEqual(r.names, ['Torso Cape A1', 'Torso Cape A2', 'Torso Cape A3', 'Torso Cape A4', 'Torso Cape B1', 'Torso Cape B2', 'Torso Cape B3', 'Torso Cape B4']);
  assert.deepEqual(out.rigged, [{ mesh: 'Torso Cape', bones: r.names }]);
  const studio = await store.sendToStudio(id, 'Alex', prisma, async () => Buffer.from('FBX'));
  assert.deepEqual(studio.options.rigged, out.rigged, 'the Mac learns which meshes bend');
  await store.claimStudio(prisma);
  await store.reportStudio(id, { status: 'done', result: {} }, prisma);

  // Download: the same plan, saved as a .blend, marked with what it was made from.
  const model = await store.get(id, prisma);
  let saved = null;
  const dl = await store.rigBlend(id, prisma, async (blend, p) => { saved = p; return Buffer.from('BLENDER rigged'); });
  assert.equal(dl.name, 'Cid_rigged.blend');
  assert.equal(saved.configHash, model.configHash);
  assert.equal(saved.rigs.length, 1);

  // Upload it back, edited: used for the FBX while it matches, with nothing left for Blender to add.
  const EDITED = Buffer.concat([Buffer.from('BLENDER-edited'), Buffer.alloc(16)]);
  await assert.rejects(store.uploadEdited(id, Buffer.from('nope'), 'Alex', prisma), /not a \.blend/);
  const editedInspect = async () => ({ glb: Buffer.from('glTF edited'), parts: PARTS, config: model.configHash, skinned: ['Torso Cape', 'Head Accessory 1'], armatures: 2, bones: 11 });
  await store.uploadEdited(id, EDITED, 'Alex', prisma, editedInspect);
  await until(async () => (await store.get(id, prisma, editedInspect)).edited?.status === 'ready');
  const withEdit = await store.get(id, prisma);
  assert.equal(withEdit.edited.matches, true);
  assert.equal(withEdit.edited.info.bones, 11);
  assert.equal((await store.file(id, 'editedGlb', prisma)).data.toString(), 'glTF edited');
  let fromEdit = null;
  const e = await store.exportModel(id, 'Alex', prisma, async (blend, p) => { fromEdit = { blend, p }; return Buffer.from('FBX'); });
  assert.deepEqual(fromEdit.blend, EDITED, 'made from the edited file');
  assert.deepEqual(fromEdit.p.rigs, []);
  assert.deepEqual(fromEdit.p.rename, {});
  assert.deepEqual(e.rigged, [{ mesh: 'Torso Cape' }, { mesh: 'Head Accessory 1' }], 'every skinned mesh in it, added bones and all');

  // A change on the page makes the edited file out of date: it's refused rather than quietly used.
  await store.setAssignments(id, { ...names, Junk: 'drop' }, prisma);
  assert.equal((await store.get(id, prisma)).edited.matches, false);
  await assert.rejects(store.exportModel(id, 'Alex', prisma, async () => Buffer.from('FBX')), /changed since the rigged \.blend/);
  await store.removeEdited(id, prisma);
  assert.equal((await store.get(id, prisma)).edited, null);
  const back = await store.exportModel(id, 'Alex', prisma, async (blend, p) => p);
  assert.equal(back.data.rigs.length, 1, 'back to the automatic rig');
});

test('a part holding both sides (both arms in one mesh) is split into its left and right, keeps what it was named, and can be joined back', async () => {
  const prisma = await createDb();
  // Blender, as a stand-in: Arms and Pads have a left and a right; a split part comes back as "<part> 1", "<part> 2".
  const seen = [];
  const inspect = async (blend, format, splits = []) => {
    seen.push(splits);
    await new Promise(r => setTimeout(r, 150)); // Blender takes a moment
    let parts = [{ name: 'Body', verts: 8, sides: false }, { name: 'Arms', verts: 16, sides: true }, { name: 'Pads', verts: 16, sides: true }, { name: 'Mystery', verts: 8 }];
    const made = {};
    for (const s of splits) {
      const p = parts.find(x => x.name === s);
      if (!p) continue;
      if (!p.sides) { made[s] = [s]; continue; }
      const pieces = [1, 2].map(i => ({ name: `${s} ${i}`, verts: 8, sides: false, from: s }));
      parts = parts.flatMap(x => (x === p ? pieces : [x]));
      made[s] = pieces.map(x => x.name);
    }
    return { glb: Buffer.from('glTF'), parts, blender: '5.2.3', splits: made };
  };
  const { id } = await store.create({ name: 'Whitebeard.blend', blend: BLEND }, prisma, inspect);
  const ready = async () => until(async () => (await store.get(id, prisma, inspect)).status === 'ready');
  await ready();
  await store.setAssignments(id, { Body: 'Torso', Arms: 'Left Arm', Pads: 'Torso Accessory' }, prisma, { Pads: 'Pad' }, ['Pads', 'Body']);

  await assert.rejects(store.split(id, 'Body', prisma, inspect), /no separate left and right/);
  await assert.rejects(store.split(id, 'Nope', prisma, inspect), /No part/);
  assert.equal((await store.split(id, 'Arms', prisma, inspect)).status, 'converting');
  await assert.rejects(store.split(id, 'Pads', prisma, inspect), /not ready yet/, 'one at a time');
  await ready();
  let m = await store.get(id, prisma);
  assert.deepEqual(m.parts.map(p => p.name), ['Body', 'Arms 1', 'Arms 2', 'Pads', 'Mystery']);
  assert.equal(m.parts.find(p => p.name === 'Arms 2').from, 'Arms');
  assert.deepEqual(m.assignments, { Body: 'Torso', Pads: 'Torso Accessory' }, 'a body part does not pass to both sides (there is one Left Arm)');
  assert.deepEqual(m.splits, ['Arms']);

  await store.split(id, 'Pads', prisma, inspect);
  await ready();
  m = await store.get(id, prisma);
  assert.deepEqual(seen.at(-1), ['Arms', 'Pads'], 'Blender cuts every split part, in order, each time');
  assert.deepEqual([m.assignments['Pads 1'], m.assignments['Pads 2']], ['Torso Accessory', 'Torso Accessory'], 'an accessory passes to each side');
  assert.deepEqual([m.labels['Pads 1'], m.labels['Pads 2']], ['Pad', 'Pad']);
  assert.deepEqual(m.doubleSided.sort(), ['Body', 'Pads 1', 'Pads 2']);

  // The pieces are what's exported: the same splits go to Blender, then the names.
  await store.setAssignments(id, { ...m.assignments, 'Arms 1': 'Right Arm', 'Arms 2': 'Left Arm' }, prisma);
  let given = null;
  await store.exportModel(id, 'Alex', prisma, async (blend, plan) => { given = plan; return Buffer.from('FBX'); });
  assert.deepEqual(given.splits, ['Arms', 'Pads']);
  assert.deepEqual(given.rename, { Body: 'Torso', 'Arms 1': 'ArmRight', 'Arms 2': 'ArmLeft', 'Pads 1': 'Torso Pad', 'Pads 2': 'Torso Pad 2' });

  // Joined back: the part returns, not named; its sides' names go.
  await assert.rejects(store.joinBack(id, 'Body', prisma, inspect), /was not split/);
  await store.joinBack(id, 'Arms', prisma, inspect);
  await ready();
  m = await store.get(id, prisma);
  assert.deepEqual(m.splits, ['Pads']);
  assert.ok(m.parts.some(p => p.name === 'Arms') && !m.parts.some(p => p.name.startsWith('Arms ')));
  assert.equal(m.assignments.Arms, undefined);
  assert.equal(m.assignments['Pads 1'], 'Torso Accessory', 'the other split stays as it was');

  // A part Blender finds has nothing on one side after all (older models don't say) isn't kept as split.
  await store.split(id, 'Mystery', prisma, inspect);
  await ready();
  assert.deepEqual((await store.get(id, prisma)).splits, ['Pads']);
});

test('a conversion that fails says why', async () => {
  const prisma = await createDb();
  const { id } = await store.create({ name: 'Bad.blend', blend: BLEND }, prisma, async () => { throw new Error('Blender said no'); });
  await until(async () => (await store.get(id, prisma, () => new Promise(() => {}))).status === 'failed');
  assert.match((await store.get(id, prisma)).error, /Blender said no/);
});

test('real Blender: convert and export', { skip: !(process.env.BLENDER_PATH && process.env.MODEL_TEST_BLEND) }, async () => {
  const blender = require('../src/models/blender');
  const blend = fs.readFileSync(process.env.MODEL_TEST_BLEND);
  const { glb, parts } = await blender.inspect(blend);
  assert.equal(glb.subarray(0, 4).toString(), 'glTF');
  assert.ok(parts.length > 1);
  const [first, second] = parts;
  const fbx = await blender.exportFbx(blend, { rename: { [first.name]: 'Head', [second.name]: 'Head Accessory 1' }, drop: [], embed: true, scale: 0.01, accessories: [] });
  assert.match(fbx.subarray(0, 20).toString('latin1'), /Kaydara FBX Binary/);
  assert.ok(fbx.includes(Buffer.from('Head Accessory 1')));
});

test('bending parts: anchor/loosen paint is checked, kept, and gives the rig a Base bone', async () => {
  const prisma = await createDb();
  const { id } = await store.create({ name: 'Cid.blend', blend: BLEND }, prisma, fakeInspect);
  await until(async () => (await store.get(id, prisma, fakeInspect)).status === 'ready');
  const names = { Cube: 'Torso', Hair: 'Torso Accessory' };
  const tail = { kind: 'custom', bones: 3, smooth: 0.6, chains: [{ root: [0, 3, 0.5], tip: [0, 0.5, 0.9] }] };
  const paint = [{ p: [0, 2.9, 0.5], r: 0.4, to: 0, s: 1 }, { p: [0, 0.6, 0.9], r: 0.3, to: 2, s: 0.35 }];

  for (const bad of [{ p: [0, 1], r: 1, to: 0, s: 1 }, { p: [0, 1, 0], r: 0, to: 0, s: 1 }, { p: [0, 1, 0], r: 1, to: 3, s: 1 }, { p: [0, 1, 0], r: 1, to: 0, s: 2 }]) {
    await assert.rejects(store.setAssignments(id, names, prisma, undefined, undefined, { Hair: { ...tail, paint: [bad] } }), /each paint dab/);
  }
  await assert.rejects(store.setAssignments(id, names, prisma, undefined, undefined, { Hair: { ...tail, paint: Array(2001).fill(paint[0]) } }), /at most 2000/);

  await store.setAssignments(id, names, prisma, { Hair: 'Tail' }, undefined, { Hair: { ...tail, paint } });
  assert.deepEqual((await store.get(id, prisma)).rigs.Hair.paint, paint);
  let given = null;
  const out = await store.exportModel(id, 'Alex', prisma, async (blend, p) => { given = p; return Buffer.from('FBX'); });
  assert.deepEqual(given.rigs[0].paint, paint, 'Blender gets the paint');
  assert.deepEqual(given.rigs[0].names, ['Torso Tail A1', 'Torso Tail A2', 'Torso Tail A3', 'Torso Tail Base']);
  assert.deepEqual(out.rigged, [{ mesh: 'Torso Tail', bones: given.rigs[0].names }]);

  // No paint (or all of it cleared): no Base bone.
  await store.setAssignments(id, names, prisma, { Hair: 'Tail' }, undefined, { Hair: { ...tail, paint: [] } });
  assert.equal((await store.get(id, prisma)).rigs.Hair.paint, undefined);
  await store.exportModel(id, 'Alex', prisma, async (blend, p) => { given = p; return Buffer.from('FBX'); });
  assert.deepEqual(given.rigs[0].names, ['Torso Tail A1', 'Torso Tail A2', 'Torso Tail A3']);
});
