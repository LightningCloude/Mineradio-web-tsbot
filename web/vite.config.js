import { defineConfig, loadEnv } from 'vite';

function normalizePort(value, fallback) {
  const cleaned = (value || '').trim().replace(/^:/, '');
  const parsed = Number.parseInt(cleaned, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeServerHost(value, fallback) {
  const host = (value || fallback).trim();
  return host || fallback;
}

function normalizeProxyTargetHost(value, fallback) {
  const host = (value || fallback)
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:.+$/, '');
  if (!host || host === '0.0.0.0') {
    return fallback;
  }
  return host;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function parseBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes((value || '').trim().toLowerCase());
}

function parseAllowedHosts(value) {
  const hosts = (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return hosts.length ? hosts : undefined;
}

function parseHostnameFromUrl(value) {
  const raw = (value || '').trim();
  if (!raw) return undefined;
  try {
    return new URL(raw).hostname || undefined;
  } catch {
    return undefined;
  }
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };

  const apiProxyTarget = trimTrailingSlash(
    (env.TSBOT_WEB_API_PROXY_TARGET || '').trim() ||
      `http://${normalizeProxyTargetHost(env.TSBOT_HOST, '127.0.0.1')}:${normalizePort(env.TSBOT_PORT, 8009)}`,
  );

  const preserveApiPrefix = parseBoolean(
    env.TSBOT_WEB_PROXY_PRESERVE_API_PREFIX,
  );
  const apiProxy = {
    target: apiProxyTarget,
    changeOrigin: true,
  };
  if (!preserveApiPrefix) {
    apiProxy.rewrite = (path) => path.replace(/^\/api/, '');
  }

  const wsProxy = {
    target: apiProxyTarget.replace(/^http/, 'ws'),
    ws: true,
  };

  const adminProxy = {
    target: apiProxyTarget,
    changeOrigin: true,
  };

  const coverProxy = {
    target: trimTrailingSlash(
      (env.TSBOT_WEB_COVER_PROXY_TARGET || 'https://y.gtimg.cn').trim(),
    ),
    changeOrigin: true,
    headers: {
      Referer: 'https://y.qq.com/',
    },
    rewrite: (path) => path.replace(/^\/cover\//, '/music/photo_new/'),
  };

  const qqAudioProxy = {
    target: 'http://aqqmusic.tc.qq.com',
    changeOrigin: true,
    headers: {
      Referer: 'https://y.qq.com/',
    },
    rewrite: (path) => path.replace(/^\/audio\/qq/, ''),
  };

  const allowedHostsSet = new Set(parseAllowedHosts(env.TSBOT_WEB_ALLOWED_HOSTS) || []);
  const publicHostname = parseHostnameFromUrl(env.VITE_WEB_PUBLIC_URL);
  if (publicHostname) {
    allowedHostsSet.add(publicHostname);
  }
  const allowedHosts = allowedHostsSet.size ? Array.from(allowedHostsSet) : undefined;

  return {
    server: {
      host: normalizeServerHost(env.VITE_DEV_HOST, '127.0.0.1'),
      port: normalizePort(env.VITE_DEV_PORT, 5173),
      allowedHosts,
      proxy: {
        '/api': apiProxy,
        '/admin': adminProxy,
        '/ws': wsProxy,
        '/cover': coverProxy,
        '/audio/qq': qqAudioProxy,
      },
    },
    preview: {
      host: normalizeServerHost(env.TSBOT_WEB_HOST, '127.0.0.1'),
      port: normalizePort(env.TSBOT_WEB_PORT, 8080),
      allowedHosts,
      proxy: {
        '/api': apiProxy,
        '/admin': adminProxy,
        '/ws': wsProxy,
        '/cover': coverProxy,
        '/audio/qq': qqAudioProxy,
      },
    },
  };
});
