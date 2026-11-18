/**
 * QR rendering for the panel's sign-in card.
 *
 * The encoder is the vendored `qrcode-generator` (MIT, Kazuhiko Arase) in
 * ./vendor: the plugin ships zero npm dependencies, and a QR encoder is small
 * enough to vendor rather than add a build step for. Only the SVG projection is
 * used — the browser receives an image, never markup.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** Vendored encoder: `qrcode(typeNumber, errorCorrectionLevel)`. */
const qrcode = require('./vendor/qrcode-generator.cjs');

/** Quiet-zone modules around the symbol, in cells. */
const MARGIN_CELLS = 2;

/**
 * Render one URL/string as a self-contained SVG QR image.
 *
 * Type number 0 makes the encoder pick the smallest symbol that fits, so a
 * sign-in link of any supported length renders without the caller choosing a
 * version. Error correction level M tolerates a smudged screen camera.
 *
 * @param {string} text payload to encode (a sign-in URL here)
 * @param {{ cellSize?: number }} [options]
 * @returns {string} an `<svg>` document as a string
 */
export function qrSvg(text, { cellSize = 4 } = {}) {
  const value = typeof text === 'string' ? text : '';
  if (value === '') throw new Error('qrSvg: empty payload');
  const code = qrcode(0, 'M');
  code.addData(value);
  code.make();
  const size = Math.max(2, Math.min(12, Number(cellSize) || 4));
  return code.createSvgTag({ cellSize: size, margin: MARGIN_CELLS, scalable: true });
}

/**
 * Wrap an SVG string in a data URL the browser can put in `<img src>`.
 *
 * base64 keeps the payload free of characters that a URL parser would rewrite,
 * and the browser never needs to interpret the markup as HTML.
 * @param {string} svg
 * @returns {string}
 */
export function svgDataUrl(svg) {
  return 'data:image/svg+xml;base64,' + Buffer.from(String(svg), 'utf8').toString('base64');
}
