import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdater } from '../lib/update.js';

const version = '0.10.10';
const filename = 'deepsounds-dsh-' + version + '.tgz';
const url = 'https://github.com/Linguage/deepsounds/releases/download/v' + version + '/' + filename;
const release = { tag_name: 'v' + version, assets: [{ name: filename, state: 'uploaded', browser_download_url: url }] };

test('manual updates compare versions and install only the selected GitHub asset through DSH', async () => {
  let installed = '0.10.9';
  const installs = [];
  const manager = {
    listBundles: async () => [{ name: 'deepsounds-dsh', version: installed, installed: true, enabled: true }],
    async installBundle(spec, options) {
      installs.push({ spec, options });
      installed = version;
      return { bundle: 'deepsounds-dsh', version, application: 'restart-required' };
    },
  };
  const updater = createUpdater({ current: installed, getManager: () => manager, fetcher: async (source, options) => {
    assert.equal(source, 'https://api.github.com/repos/Linguage/deepsounds/releases/latest');
    assert.equal(options.redirect, 'error');
    return Response.json(release);
  } });
  assert.equal((await updater.check()).available, true);
  assert.deepEqual(installs, []);
  await assert.rejects(updater.install('0.10.11'), { status: 409 });
  assert.deepEqual(await updater.install(version), { version, restart: true });
  assert.deepEqual(installs, [{ spec: url, options: { enabled: true } }]);
  const check = await updater.check();
  assert.equal(check.installed, version);
  assert.equal(check.available, false);
  await assert.rejects(updater.install(version), { status: 409 });
});

test('a release without the exact uploaded DSH asset offers no install URL', async () => {
  const updater = createUpdater({ current: '0.10.9', fetcher: async () => Response.json({
    ...release, assets: [{ ...release.assets[0], browser_download_url: 'https://example.com/' + filename }],
  }) });
  const check = await updater.check();
  assert.equal(check.available, true);
  assert.equal(check.downloadUrl, null);
  assert.equal(check.canInstall, false);
  await assert.rejects(updater.install(version), { status: 503 });
});
