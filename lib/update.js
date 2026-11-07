import manifest from '../package.json' with { type: 'json' };
import { MusicError } from './netease.js';

const REPO = 'Linguage/deepsounds';
const GITHUB = 'https://github.com/' + REPO;
const STABLE = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/;

function newer(candidate, current) {
  if (!STABLE.test(current)) return false;
  const left = candidate.split('.').map(Number);
  const right = current.split('.').map(Number);
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

export function createUpdater({ fetcher = globalThis.fetch, getManager = () => null, current = manifest.version } = {}) {
  let installing = false;

  async function latest() {
    let release;
    try {
      const response = await fetcher('https://api.github.com/repos/' + REPO + '/releases/latest', {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'deepsounds-dsh' },
        redirect: 'error', signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('GitHub Release request failed');
      release = await response.json();
    } catch {
      throw new MusicError(502, '暂时无法检查 GitHub 更新，请检查网络后重试。');
    }
    const version = /^v(.+)$/.exec(release?.tag_name)?.[1];
    if (release?.draft || release?.prerelease || !STABLE.test(version)) {
      throw new MusicError(502, 'GitHub 未返回可识别的正式版本。');
    }
    const tag = 'v' + version;
    const filename = manifest.name + '-' + version + '.tgz';
    const url = GITHUB + '/releases/download/' + tag + '/' + filename;
    const downloadable = Array.isArray(release.assets) && release.assets.some(asset =>
      asset?.name === filename && asset.state === 'uploaded' && asset.browser_download_url === url);
    return { version, releaseUrl: GITHUB + '/releases/tag/' + tag, downloadUrl: downloadable ? url : null };
  }

  async function installedBundle(manager) {
    const bundles = await manager?.listBundles?.();
    return bundles?.find(bundle => bundle.name === manifest.name && bundle.installed);
  }

  return {
    async check() {
      const release = await latest();
      const manager = getManager();
      const bundle = await installedBundle(manager);
      const installed = STABLE.test(bundle?.version) ? bundle.version : current;
      return { ...release, current, installed: newer(installed, current) ? installed : current,
        available: newer(release.version, installed) && newer(release.version, current),
        canInstall: bundle?.enabled === true && typeof manager?.installBundle === 'function' };
    },

    async install(version) {
      if (!STABLE.test(version)) throw new MusicError(400, '无效的更新版本。');
      if (installing) throw new MusicError(409, '已有更新正在安装。');
      const manager = getManager();
      if (typeof manager?.installBundle !== 'function') {
        throw new MusicError(503, '当前 DSH 无法从面板安装，请下载后在插件管理中安装。');
      }
      installing = true;
      try {
        const release = await latest();
        const bundle = await installedBundle(manager);
        if (bundle?.enabled !== true || release.version !== version || !release.downloadUrl ||
            !newer(version, bundle.version ?? current) || !newer(version, current)) {
          throw new MusicError(409, '可安装版本已变化，请重新检查更新。');
        }
        const result = await manager.installBundle(release.downloadUrl, { enabled: true });
        if (result.bundle !== manifest.name || result.version !== version ||
            !['applied', 'restart-required'].includes(result.application)) {
          const error = result.error?.code === 'incompatible-version' ? '新版与当前 DSH 版本不兼容。' :
            'DSH 未能完成安装。可在插件管理中查看结果，或下载安装包手动更新。';
          throw new MusicError(502, error);
        }
        return { version, restart: result.application === 'restart-required' };
      } finally {
        installing = false;
      }
    },
  };
}
