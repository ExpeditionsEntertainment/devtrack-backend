// Getting Blender onto the server: blender.org first, then its mirrors; only a file with the right checksum is kept.
// The internet is a stand-in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fetchArchive } = require('../src/models/blender');

const REAL = Buffer.from('pretend this is the Blender archive');
const SHA = crypto.createHash('sha256').update(REAL).digest('hex');
const answer = (status, data = '') => ({ ok: status === 200, status, body: new Response(data).body, text: async () => String(data) });
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-blender-test-')), 'blender.tar.xz');

test.beforeEach(() => { process.env.BLENDER_SHA256 = SHA; delete process.env.BLENDER_URL; });
test.after(() => { delete process.env.BLENDER_SHA256; });

test('blender.org turning the server away: the next mirror is used', async () => {
  const asked = [];
  const get = async url => { asked.push(new URL(url).host); return url.includes('download.blender.org') ? answer(403) : answer(200, REAL); };
  const file = tmp();
  assert.equal(await fetchArchive(file, get), 'mirrors.ocf.berkeley.edu');
  assert.deepEqual(asked, ['download.blender.org', 'mirrors.ocf.berkeley.edu']);
  assert.deepEqual(fs.readFileSync(file), REAL);
});

test('a file with the wrong checksum is thrown away and the next place tried', async () => {
  const get = async url => (url.includes('download.blender.org') ? answer(200, 'something else') : answer(200, REAL));
  const file = tmp();
  assert.equal(await fetchArchive(file, get), 'mirrors.ocf.berkeley.edu');
  assert.deepEqual(fs.readFileSync(file), REAL);
});

test('BLENDER_URL is tried first; when nothing works it says what each place answered', async () => {
  process.env.BLENDER_URL = 'https://files.example.com/blender.tar.xz';
  const first = [];
  assert.equal(await fetchArchive(tmp(), async url => { first.push(url); return answer(200, REAL); }), 'files.example.com');
  assert.deepEqual(first, ['https://files.example.com/blender.tar.xz']);

  const file = tmp();
  await assert.rejects(fetchArchive(file, async () => answer(403)), err => {
    assert.match(err.message, /Could not download Blender .*files\.example\.com: HTTP 403; download\.blender\.org: HTTP 403; mirrors\.ocf\.berkeley\.edu: HTTP 403/);
    return true;
  });
  assert.equal(fs.existsSync(file), false, 'nothing half-downloaded is left behind');
});
