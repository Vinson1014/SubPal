import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createPlayback } from '../../content/system/capabilities/playback.js';

const source = await readFile(new URL('../../netflix-page-script.js', import.meta.url), 'utf8');
const selectionSource = await readFile(new URL('../../shared/secondary-track-selection.js', import.meta.url), 'utf8');

// 真實 classic page producer；僅替換 Netflix player 與訊息 transport，不替換 dispatcher。
export function createPrivatePlaybackPage({ context, tracks, startingTrack, afterSet = async () => {} }) {
  const listeners = new Map();
  const responses = new Map();
  const mutations = [];
  let current = startingTrack;
  let requestId = 0;
  const player = {
    getMovieId: () => context.videoId,
    getCurrentTime: () => 1000,
    getDuration: () => 600000,
    getTimedTextTrack: () => current,
    getTimedTextTrackList: () => tracks,
    async setTimedTextTrack(track) {
      mutations.push(track.trackId);
      current = track;
      await afterSet(track, value => { current = value; });
    }
  };
  const api = {
    getOpenPlaybackSessions: () => [{ sessionId: context.sessionId }],
    getVideoIdBySessionId: () => context.videoId,
    videoPlayer: { getVideoPlayerBySessionId: () => player }
  };
  const location = { href: `https://www.netflix.com/watch/${context.videoId}`, origin: 'https://www.netflix.com' };
  const window = {
    netflix: { appContext: { state: { playerApp: { getAPI: () => api } } } },
    location,
    history: { pushState() {}, replaceState() {} },
    addEventListener(type, listener) {
      const handlers = listeners.get(type) || new Set();
      handlers.add(listener);
      listeners.set(type, handlers);
    },
    dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); },
    postMessage(message) { responses.get(message.requestId)?.(structuredClone(message.response)); }
  };
  const sandbox = vm.createContext({
    window, location, history: window.history, structuredClone, URL, URLSearchParams,
    document: { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } },
    console: { log() {}, error() {} },
    XMLHttpRequest: class { open() {} send() {} },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    setTimeout(callback) { callback(); return 0; }, clearTimeout() {}
  });
  vm.runInContext(source, sandbox, {
    filename: 'netflix-page-script.js',
    async importModuleDynamically(specifier) {
      assert.equal(specifier, './shared/secondary-track-selection.js');
      const module = new vm.SourceTextModule(selectionSource, { context: sandbox });
      await module.link(() => { throw new Error('Unexpected dependency'); });
      await module.evaluate();
      return module;
    }
  });
  const playback = createPlayback({
    getCurrentContext: () => ({ ...context, state: 'ready' }),
    adapter: { async request({ variant, payload, expected }) {
      const id = `producer-${++requestId}`;
      const result = new Promise(resolve => { responses.set(id, resolve); });
      window.dispatchEvent({ type: 'message', source: window, origin: location.origin, data: {
        source: 'subpal-content-script', target: 'subpal-page-script', envelope: {
          protocolVersion: 1, requestId: id, kind: 'playback', context: expected,
          payload: { variant, payload }
        }
      } });
      try { return await result; } finally { responses.delete(id); }
    } }
  });
  return {
    mutations,
    current: () => current,
    perform: (variant, payload = {}, expected = context) => playback.perform({ variant, payload, expected })
  };
}
