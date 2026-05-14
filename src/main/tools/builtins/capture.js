'use strict';

/**
 * Built-in screen-capture tools.
 *
 * Exposed registry entries:
 *   - astra.capture_primary_screen  (effect: read)
 *   - astra.capture_active_window   (effect: read)
 *
 * Both return { base64, meta: { id, name, width, height } } and update the session
 * image buffer (held in ctx.sessionState) as a side effect, mirroring the pre-registry
 * behavior so the renderer's "Clip ready" status keeps working.
 */

const { desktopCapturer } = require('electron');

async function capturePrimaryScreenThumbnail() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1920, height: 1200 },
  });
  const primary = sources[0];
  if (!primary) throw new Error('No screen source (grant Screen Recording in System Settings)');
  const img = primary.thumbnail;
  if (img.isEmpty()) throw new Error('Empty thumbnail');
  const jpeg = img.toJPEG(82);
  return {
    base64: jpeg.toString('base64'),
    meta: {
      id: primary.id,
      name: primary.name,
      width: img.getSize().width,
      height: img.getSize().height,
    },
  };
}

async function captureActiveWindowThumbnail({ selfNames = ['Astra Dock', 'Glass'] } = {}) {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 1920, height: 1200 },
    fetchWindowIcons: true,
  });
  if (!sources.length) throw new Error('No windows (grant Screen Recording in System Settings)');
  const filtered = sources.filter(
    (s) => !selfNames.some((n) => s.name.includes(n)) && s.name.length > 0,
  );
  const pick = filtered.sort((a, b) => {
    const as = a.thumbnail.getSize();
    const bs = b.thumbnail.getSize();
    return bs.width * bs.height - as.width * as.height;
  })[0] || sources[0];
  const img = pick.thumbnail;
  const jpeg = img.toJPEG(82);
  return {
    base64: jpeg.toString('base64'),
    meta: {
      id: pick.id,
      name: pick.name,
      width: img.getSize().width,
      height: img.getSize().height,
    },
  };
}

/**
 * Register both capture tools on a registry.
 * @param {object} registry  Object returned by createRegistry().
 * @param {object} ctx
 * @param {function} ctx.onCaptured  Callback (base64, meta) → void  to update session state.
 */
function register(registry, ctx = {}) {
  const onCaptured = typeof ctx.onCaptured === 'function' ? ctx.onCaptured : () => {};

  registry.register({
    id: 'astra.capture_primary_screen',
    source: 'builtin',
    effect: 'read',
    description:
      'Capture a JPEG thumbnail of the primary display. Use this when the user asks about anything on their desktop. Returns the image as base64 plus capture metadata.',
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    renderPreview: () => 'Take a screenshot of the entire primary display',
    handler: async () => {
      const r = await capturePrimaryScreenThumbnail();
      onCaptured(r.base64, r.meta);
      return r;
    },
  });

  registry.register({
    id: 'astra.capture_active_window',
    source: 'builtin',
    effect: 'read',
    description:
      'Capture a JPEG thumbnail of the foreground window (largest non-Astra window). Prefer this over a full-screen capture when the user is asking about a specific app.',
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    renderPreview: () => 'Screenshot the foreground window',
    handler: async () => {
      const r = await captureActiveWindowThumbnail();
      onCaptured(r.base64, r.meta);
      return r;
    },
  });
}

module.exports = {
  register,
  capturePrimaryScreenThumbnail,
  captureActiveWindowThumbnail,
};
