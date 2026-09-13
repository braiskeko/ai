import { promises as fs } from "fs";
import path from "path";
import type Sharp from "sharp";
import { config } from "./config";
import { HttpError } from "./storage";

/**
 * Image uploads (coin logos, comment attachments, avatars).
 *
 * The browser sends images as base64 data URLs inside the JSON body (the client
 * already downsizes them with a canvas). We decode, sanity-check and re-encode
 * everything through sharp so only normalised WebP files ever reach disk:
 * arbitrary bytes disguised with an image mime type are rejected, EXIF data is
 * dropped and animated GIFs collapse to their first frame (sharp's default).
 *
 * Files live under `config.uploadsDir` and are served by express.static at
 * `/uploads/...` (see routes.ts).
 */

export type UploadKind = "coins" | "comments" | "avatars" | "banners";

type SharpFactory = typeof Sharp;
let sharpFactory: SharpFactory | null | undefined;

/**
 * sharp ships native binaries that some shared hosts cannot install. Load it lazily and,
 * when it is missing, fall back to storing the (already client-resized) image as-is.
 */
async function loadSharp(): Promise<SharpFactory | null> {
  if (sharpFactory !== undefined) return sharpFactory;
  try {
    const mod = (await import("sharp")) as unknown as { default?: SharpFactory } & SharpFactory;
    sharpFactory = mod.default ?? mod;
  } catch (err) {
    console.warn(`[uploads] sharp unavailable (${(err as Error).message}); storing images unprocessed`);
    sharpFactory = null;
  }
  return sharpFactory;
}

/** Extension for an image data URL's mime type. */
function rawExtension(dataUrl: string): string {
  const mime = /^data:image\/(png|jpe?g|webp|gif)/i.exec(dataUrl)?.[1]?.toLowerCase() ?? "png";
  return mime === "jpeg" || mime === "jpg" ? "jpg" : mime;
}

export const UPLOAD_KINDS: readonly UploadKind[] = ["coins", "comments", "avatars", "banners"];

/** Absolute upload root; `config.uploadsDir` may be relative to the working directory. */
export const UPLOADS_ROOT = path.resolve(config.uploadsDir);

/** Decoded size limit; the schemas already cap the base64 payload around 2 MB. */
const MAX_DECODED_BYTES = 2 * 1024 * 1024;

/** Formats sharp may report for input we accept (mirrors the data-URL regex in the schemas). */
const ALLOWED_FORMATS = new Set(["png", "jpeg", "webp", "gif"]);

const WEBP_QUALITY = 82;

const DATA_URL_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/;

/** File names come from nanoid / CAs / user ids; refuse anything that could escape the directory. */
const SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** Create the upload root and one sub-directory per kind (idempotent). Called at boot. */
export async function ensureUploadDirs(): Promise<void> {
  await Promise.all(UPLOAD_KINDS.map((kind) => fs.mkdir(path.join(UPLOADS_ROOT, kind), { recursive: true })));
}

/** Absolute path on disk for an upload, given its kind and base name. */
export function uploadPath(kind: UploadKind, name: string, ext = "webp"): string {
  return path.join(UPLOADS_ROOT, kind, `${name}.${ext}`);
}

/** Public URL for an upload, as stored in `imageUrl` fields. */
export function uploadUrl(kind: UploadKind, name: string, ext = "webp"): string {
  return `/uploads/${kind}/${name}.${ext}`;
}

/** Decode the base64 payload of an image data URL. Throws HttpError 400 when malformed or too large. */
function decodeDataUrl(dataUrl: string): Buffer {
  const match = typeof dataUrl === "string" ? DATA_URL_RE.exec(dataUrl) : null;
  if (!match) throw new HttpError(400, "Upload an image (PNG, JPEG, WebP or GIF)");
  const buffer = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  if (buffer.length === 0) throw new HttpError(400, "The uploaded image is empty");
  if (buffer.length > MAX_DECODED_BYTES) throw new HttpError(400, "Image is too large (max 2 MB)");
  return buffer;
}

/**
 * Decode `dataUrl`, resize it and store it as `${uploadsDir}/${kind}/${name}.webp`.
 *
 *  - coins / avatars: square `size`×`size` crop (cover)
 *  - comments: fit within `size` px wide, never enlarged
 *
 * Returns the public URL (`/uploads/<kind>/<name>.webp`). Throws HttpError 400 for
 * non-images, corrupt data or oversized payloads.
 */
export async function saveImage(dataUrl: string, kind: UploadKind, name: string, size: number): Promise<string> {
  if (!UPLOAD_KINDS.includes(kind)) throw new HttpError(400, "Unknown upload kind");
  if (!SAFE_NAME_RE.test(name)) throw new HttpError(400, "Invalid upload name");
  if (!Number.isInteger(size) || size <= 0 || size > 4096) throw new HttpError(400, "Invalid image size");

  const input = decodeDataUrl(dataUrl);

  const sharp = await loadSharp();
  if (!sharp) {
    // No image processing available: keep the bytes the browser sent (it already resized them).
    const ext = rawExtension(dataUrl);
    const target = uploadPath(kind, name, ext);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, input);
    return uploadUrl(kind, name, ext);
  }

  // `animated: false` (the default) keeps only the first frame of GIFs / animated WebP.
  // `failOn: "none"` tolerates the minor encoder quirks (odd CRCs, missing ancillary chunks) found
  // in canvas/toDataURL output and minimal test PNGs; corrupt headers and truncated pixel streams
  // still fail in metadata()/toFile() below and become a 400.
  const image = sharp(input, { animated: false, failOn: "none" });

  let format: string | undefined;
  try {
    ({ format } = await image.metadata());
  } catch {
    throw new HttpError(400, "That file is not a valid image");
  }
  if (!format || !ALLOWED_FORMATS.has(format)) {
    throw new HttpError(400, "Unsupported image format (use PNG, JPEG, WebP or GIF)");
  }

  const pipeline =
    kind === "comments"
      ? image.rotate().resize({ width: size, withoutEnlargement: true })
      : image.rotate().resize(size, size, { fit: "cover", position: "centre" });

  const target = uploadPath(kind, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await pipeline.webp({ quality: WEBP_QUALITY }).toFile(target);
  } catch (err) {
    // sharp only fails here on corrupt pixel data (headers were fine) or on a disk problem.
    // Filesystem errors carry a Node errno code (ENOSPC, EACCES...); libvips decode errors do not.
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === "string" && /^E[A-Z]+$/.test(code)) throw err;
    throw new HttpError(400, "That image could not be processed");
  }

  return uploadUrl(kind, name);
}

/** Best-effort removal of an upload (e.g. when the record it belonged to was never created). */
export async function deleteImage(url: string): Promise<void> {
  const match = /^\/uploads\/(coins|comments|avatars)\/([A-Za-z0-9_-]+)\.(webp|png|jpg|gif)$/.exec(url);
  if (!match) return;
  try {
    await fs.unlink(uploadPath(match[1] as UploadKind, match[2], match[3]));
  } catch {
    // already gone or never written
  }
}
