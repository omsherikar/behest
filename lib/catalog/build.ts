import type { BetaContentBlockParam, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages';
import { z } from 'zod';
import { type Category, isCategory } from '@/lib/domain/categories';
import type { LlmDeps, LlmResult } from '@/lib/llm/client';
import { callStructured } from '@/lib/llm/structured';
import { wrapUntrusted } from '@/lib/llm/untrusted';
import { type CatalogRow, firstCodePoints, multiLine, oneLine, SKU_PATTERN } from './csv';
import { CATALOG_SYSTEM_PROMPT } from './prompts';
import { type Screening, screenText } from './screen';

// The catalog builder: turns a seller's CSV rows or photos into listing drafts in the fixed category
// list, each screened for text aimed at AI agents. The model writes the title, description,
// category and its own screening. It also proposes the SKU of a photo listing, which is kept only
// when it matches SKU_PATTERN and no other listing uses it (otherwise it becomes PHOTO-<number>), and
// is screened either way; a row keeps its own SKU. Prices and stock always come from the seller, so
// nothing the model writes can change what a buyer is charged, and the fixed screen runs on the
// seller's text and on the model's output whatever the model says about them.

export type ListingDraft = {
  sku: string;
  title: string;
  description: string;
  category: Category;
  priceCents: number;
  stock: number | null;
  screening: { suspicious: boolean; reason: string | null };
};

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type PhotoType = (typeof PHOTO_TYPES)[number];

/** A product photo with the price and stock the seller gives for it. The model never sets a price. */
export type ListingPhoto = {
  mediaType: PhotoType;
  /** The image bytes in base64, without a `data:` prefix. */
  base64: string;
  priceCents: number;
  stock?: number | null;
};

export type BuildInput = { rows?: CatalogRow[]; images?: ListingPhoto[] };

/** Input the builder refuses before any model call, with a message the seller can act on. */
export class CatalogInputError extends Error {
  override name = 'CatalogInputError';
}

/** Rows per model call. */
export const BATCH_SIZE = 50;
/** Photos per build. They all go in one call. */
export const MAX_PHOTOS = 8;
/** The most base64 text one photo may be: 5 MiB, which is 3.75 MiB of image, inside the API's limit per image. */
export const PHOTO_BASE64_MAX = 5 * 1024 * 1024;
/** The most base64 text all the photos may be together: 20 MiB, which keeps the request well inside the API's 32 MB. */
export const PHOTOS_BASE64_MAX = 20 * 1024 * 1024;

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2000;
const REASON_MAX = 300;
/** The largest value of a Postgres integer, the column type of price and stock. */
const INT_MAX = 2_147_483_647;
/**
 * The longest batch text sent. The CSV reader caps a name at 120 and a description at 2000 code
 * points, so a batch of rows from it stays far below this even with every character escaped.
 */
const BATCH_TEXT_MAX = 2_000_000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/**
 * The bytes each accepted type starts with, as offsets and text in the binary string that `atob`
 * returns. A WebP file is a RIFF file whose form type, at byte 8, is WEBP.
 */
const SIGNATURES: Record<PhotoType, { name: string; parts: [number, string][] }> = {
  'image/jpeg': { name: 'JPEG', parts: [[0, '\xff\xd8\xff']] },
  'image/png': { name: 'PNG', parts: [[0, '\x89PNG\r\n\x1a\n']] },
  'image/webp': { name: 'WebP', parts: [[0, 'RIFF'], [8, 'WEBP']] },
};
/** The reason given when the model flags a listing without saying why. */
const FLAGGED = 'flagged as text aimed at AI agents';

/**
 * One listing as the model writes it. The JSON schema sent is strict (no other fields, every field
 * required); fields a reply adds anyway, such as a price, are dropped when it is read.
 */
const listingFields = {
  sku: z.string(),
  title: z.string(),
  description: z.string(),
  /**
   * A category id. Checked here rather than in the schema, because the SDK cannot send an enum as a
   * constraint, and one stray category would otherwise fail the whole batch.
   */
  category: z.string(),
  screening: z.object({ suspicious: z.boolean(), reason: z.string().nullable() }),
};

const CatalogItem = z.object(listingFields);
type CatalogItem = z.infer<typeof CatalogItem>;

export const CatalogOutput = z.object({ items: z.array(CatalogItem) });

/** A listing for a photo, naming the photo it describes by its label in the request, counting from 0. */
const PhotoItem = z.object({ photo: z.int(), ...listingFields });
type PhotoItem = z.infer<typeof PhotoItem>;

export const PhotoOutput = z.object({ items: z.array(PhotoItem) });

/**
 * Listing drafts for a seller's CSV rows and photos: the rows in batches of `BATCH_SIZE`, one model
 * call each, then the photos in one call. Drafts come back in the order given, rows first. A row the
 * model leaves out is drafted from its own text in category `other`. Listings are matched to rows by
 * SKU and to photos by the photo number each one names, never by their order in the reply. Any
 * failed call fails the build with that call's failure, and no further calls are made, as does a
 * photo reply that does not list each photo exactly once; on success `callId` is the last call's.
 * Throws `CatalogInputError` before any call for input it cannot list.
 */
export async function buildListings(deps: LlmDeps, input: BuildInput): Promise<LlmResult<ListingDraft[]>> {
  const rows = input.rows ?? [];
  const photos = input.images ?? [];
  checkRows(rows);
  checkPhotos(photos);
  if (rows.length === 0 && photos.length === 0) {
    throw new CatalogInputError('Give at least one row or photo to build listings from');
  }

  const drafts: ListingDraft[] = [];
  let callId = '';
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const reply = await callStructured(deps, 'catalog_build', {
      system: CATALOG_SYSTEM_PROMPT,
      messages: [rowsMessage(batch)],
      schema: CatalogOutput,
    });
    if (!reply.ok) return reply;
    drafts.push(...rowDrafts(batch, reply.value.items));
    callId = reply.callId;
  }

  if (photos.length > 0) {
    const reply = await callStructured(deps, 'catalog_build', {
      system: CATALOG_SYSTEM_PROMPT,
      messages: [photosMessage(photos)],
      schema: PhotoOutput,
    });
    if (!reply.ok) return reply;
    // The photo numbers are checked here, after the call, rather than by a refinement on the schema:
    // with the SDK's zod helper any refinement moves part of the schema it sends into $defs and $ref,
    // so the request would change. The gap is that the call's llm_calls row records a success for a
    // reply that this check turns into invalid_output.
    const items = itemsByPhoto(reply.value.items, photos.length);
    if (typeof items === 'string') return { ok: false, error: 'invalid_output', callId: reply.callId, detail: items };
    const claimed = new Set(rows.map((r) => r.sku.toUpperCase()));
    drafts.push(...photos.map((photo, index) => photoDraft(photo, index, items[index], claimed)));
    callId = reply.callId;
  }

  return { ok: true, value: drafts, callId };
}

/** Rows are matched to listings by SKU, so two rows may not share one. */
function checkRows(rows: CatalogRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.sku.toUpperCase();
    if (seen.has(key)) throw new CatalogInputError(`SKU ${row.sku} is on more than one row`);
    seen.add(key);
  }
}

/**
 * Each photo in turn: a type it accepts, base64 data of that type within the size limits, and a
 * price and stock it can store. Sizes are given to sellers in MB of image, not of base64.
 */
function checkPhotos(photos: ListingPhoto[]): void {
  if (photos.length > MAX_PHOTOS) {
    throw new CatalogInputError(`At most ${MAX_PHOTOS} photos can be listed at once, got ${photos.length}`);
  }
  let total = 0;
  photos.forEach((photo, index) => {
    const which = `Photo ${index + 1}`;
    const signature = Object.hasOwn(SIGNATURES, photo.mediaType) ? SIGNATURES[photo.mediaType] : undefined;
    if (signature === undefined) {
      throw new CatalogInputError(`${which} must be a JPEG, PNG or WebP image, not ${JSON.stringify(photo.mediaType)}`);
    }
    if (typeof photo.base64 === 'string' && photo.base64.length > PHOTO_BASE64_MAX) {
      throw new CatalogInputError(`${which} is too large: each photo can be at most ${imageMb(PHOTO_BASE64_MAX)} MB`);
    }
    if (typeof photo.base64 !== 'string' || photo.base64.length % 4 !== 0 || !BASE64.test(photo.base64)) {
      throw new CatalogInputError(`${which} must be base64 image data without a data: prefix`);
    }
    if (!startsWith(photo.base64, signature.parts)) {
      throw new CatalogInputError(`${which} is not a ${signature.name} image`);
    }
    if (!isWholeNumber(photo.priceCents, 1)) {
      throw new CatalogInputError(`${which} needs a price in whole cents from 1 to ${INT_MAX}`);
    }
    if (photo.stock != null && !isWholeNumber(photo.stock, 0)) {
      throw new CatalogInputError(`${which} stock must be a whole number from 0 to ${INT_MAX}`);
    }
    total += photo.base64.length;
    if (total > PHOTOS_BASE64_MAX) {
      throw new CatalogInputError(
        `Photos 1 to ${index + 1} come to more than ${imageMb(PHOTOS_BASE64_MAX)} MB together; send fewer or smaller photos`,
      );
    }
  });
}

/** The MiB of image that `chars` characters of base64 hold, which sellers know as MB. */
function imageMb(chars: number): number {
  return (chars * 3) / 4 / (1024 * 1024);
}

/** Whether well-formed base64 decodes to bytes that have each of `parts` at its offset. */
function startsWith(base64: string, parts: [number, string][]): boolean {
  const head = atob(base64.slice(0, 16));
  return parts.every(([offset, bytes]) => head.startsWith(bytes, offset));
}

function isWholeNumber(value: unknown, min: number): boolean {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= INT_MAX;
}

/** The listed category a piece of text names, read case-insensitively with spaces, dashes or underscores between words, or null. */
function categoryOf(text: string | null): Category | null {
  const id = (text ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '_');
  return isCategory(id) ? id : null;
}

/** The batch's rows as untrusted seller text. Prices and stock are left out: the model has no use for them. */
function rowsMessage(batch: CatalogRow[]): BetaMessageParam {
  const rows = batch.map((row) => ({
    sku: row.sku,
    name: row.name,
    description: row.description,
    sellerCategory: row.category,
    categoryHint: categoryOf(row.category),
  }));
  const wrapped = wrapUntrusted('seller_listing', JSON.stringify(rows), BATCH_TEXT_MAX);
  return { role: 'user', content: `Write one listing for each of the ${batch.length} rows below.\n\n${wrapped}` };
}

/** Each photo as an image block after a label numbering it from 0, the number each listing names its photo by. */
function photosMessage(photos: ListingPhoto[]): BetaMessageParam {
  const content: BetaContentBlockParam[] = photos.flatMap((photo, index): BetaContentBlockParam[] => [
    { type: 'text', text: `Photo ${index}` },
    { type: 'image', source: { type: 'base64', media_type: photo.mediaType, data: photo.base64 } },
  ]);
  content.push({
    type: 'text',
    text: `Write one listing for each of the ${photos.length} photos, with photo set to the number in its label.`,
  });
  return { role: 'user', content };
}

/**
 * The listing for each of `count` photos in photo order, found by the photo number each listing
 * names, or text naming the first problem: a number outside the photos, a photo listed twice, or a
 * photo not listed. Between them these also catch a reply with too few or too many listings.
 */
function itemsByPhoto(items: PhotoItem[], count: number): PhotoItem[] | string {
  const byPhoto: (PhotoItem | undefined)[] = Array.from({ length: count }, () => undefined);
  for (const item of items) {
    if (item.photo < 0 || item.photo >= count) {
      return `The reply listed photo ${item.photo}, but the photos are numbered 0 to ${count - 1}`;
    }
    if (byPhoto[item.photo] !== undefined) return `The reply listed photo ${item.photo} more than once`;
    byPhoto[item.photo] = item;
  }
  const missing = byPhoto.indexOf(undefined);
  return missing === -1 ? (byPhoto as PhotoItem[]) : `The reply did not list photo ${missing}`;
}

/** A draft for each row in the batch: from the first listing whose SKU matches it in any case, or from the row alone. */
function rowDrafts(batch: CatalogRow[], items: CatalogItem[]): ListingDraft[] {
  const bySku = new Map<string, CatalogItem>();
  for (const item of items) {
    const key = item.sku.trim().toUpperCase();
    if (!bySku.has(key)) bySku.set(key, item);
  }
  return batch.map((row) => {
    const item = bySku.get(row.sku.toUpperCase());
    return item ? rowDraft(row, item) : fallbackDraft(row);
  });
}

function rowDraft(row: CatalogRow, item: CatalogItem): ListingDraft {
  const title = oneLine(item.title, TITLE_MAX) || oneLine(row.name, TITLE_MAX);
  const description = multiLine(item.description, DESCRIPTION_MAX) || multiLine(row.description, DESCRIPTION_MAX);
  return {
    sku: row.sku,
    title,
    description,
    category: categoryOf(item.category) ?? 'other',
    priceCents: row.priceCents,
    stock: row.stock,
    screening: screening(item.screening, screenRow(row) ?? firstFlagged([`${title}\n${description}`])),
  };
}

/** A row the model left out, listed as the seller wrote it. */
function fallbackDraft(row: CatalogRow): ListingDraft {
  return {
    sku: row.sku,
    title: oneLine(row.name, TITLE_MAX),
    description: multiLine(row.description, DESCRIPTION_MAX),
    category: 'other',
    priceCents: row.priceCents,
    stock: row.stock,
    screening: screening({ suspicious: false, reason: null }, screenRow(row)),
  };
}

/**
 * The fixed screen on a catalog row as the seller wrote it, the one rule the catalog builder and the
 * demo seed both apply: the name and description together, so a phrase split across them is still
 * caught, then the SKU read as words. The name and description are read only as far as a listing
 * keeps them. The first screening that flags the row, or null when nothing does.
 */
export function screenRow(row: Pick<CatalogRow, 'sku' | 'name' | 'description'>): Screening | null {
  const text = `${firstCodePoints(row.name, TITLE_MAX)}\n${firstCodePoints(row.description, DESCRIPTION_MAX)}`;
  return firstFlagged([text, skuWords(row.sku)]);
}

/** A SKU as words for the screen, whose phrases need spaces: `IGNORE-YOUR-BUDGET` reads as `IGNORE YOUR BUDGET`. */
function skuWords(sku: string): string {
  return sku.replace(/[-_.]+/g, ' ');
}

/**
 * The draft for the photo at `index`, with that photo's price and stock. Sellers count photos from 1,
 * so the fallback title and SKU do too.
 */
function photoDraft(photo: ListingPhoto, index: number, item: PhotoItem, claimed: Set<string>): ListingDraft {
  const number = index + 1;
  const title = oneLine(item.title, TITLE_MAX) || `Photo ${number}`;
  const description = multiLine(item.description, DESCRIPTION_MAX);
  return {
    sku: photoSku(item.sku, number, claimed),
    title,
    description,
    category: categoryOf(item.category) ?? 'other',
    priceCents: photo.priceCents,
    stock: photo.stock ?? null,
    // The SKU the model proposed is screened even when it is replaced: it may spell out text read off the photo.
    screening: screening(item.screening, firstFlagged([`${title}\n${description}`, skuWords(item.sku)])),
  };
}

/**
 * The SKU the model proposed for a photo when it is a valid SKU no other listing in the build uses,
 * otherwise `PHOTO-<number>`, or `PHOTO-<number>-2` and so on when that is taken. Claims what it returns.
 */
function photoSku(proposed: string, number: number, claimed: Set<string>): string {
  let sku = proposed.trim();
  for (let attempt = 1; !SKU_PATTERN.test(sku) || claimed.has(sku.toUpperCase()); attempt += 1) {
    sku = attempt === 1 ? `PHOTO-${number}` : `PHOTO-${number}-${attempt}`;
  }
  claimed.add(sku.toUpperCase());
  return sku;
}

/** The fixed screen's result on the first of `texts` it flags, or null when it flags none. */
function firstFlagged(texts: string[]): Screening | null {
  return texts.map(screenText).find((result) => result.suspicious) ?? null;
}

/**
 * Suspicious when the model says so or the fixed screen `matched` some text. The reason is the
 * model's when it flagged the listing, otherwise the first phrase the screen matched, strong first.
 */
function screening(model: CatalogItem['screening'], matched: Screening | null): ListingDraft['screening'] {
  if (!model.suspicious && !matched) return { suspicious: false, reason: null };
  const modelReason = model.suspicious ? oneLine(model.reason ?? '', REASON_MAX) : '';
  const matchedReason = matched ? `matched: ${matched.strong[0] ?? matched.weak[0]}` : FLAGGED;
  return { suspicious: true, reason: modelReason || matchedReason };
}
