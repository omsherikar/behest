import { dollarsToCents, formatUsd } from '@/lib/domain/money';

// The body the seller onboarding page sends to POST /api/sellers/onboard, built from what the seller
// entered. It refuses, with a message the seller can act on, anything the server would refuse for
// the same reason, so the seller hears about a missing price before a long upload rather than after.
// The photo limits are the catalog builder's (lib/catalog/build.ts), repeated here because this runs
// in the browser, which must not load the builder; a test keeps the two in step.

/** Photos one onboarding can list. */
export const MAX_PHOTOS = 8;
/** The longest edge, in pixels, a photo is downsized to before upload. */
export const PHOTO_LONG_EDGE = 1568;
/** The most base64 text one photo may be: 5 MiB, which is 3.75 MiB of image. */
export const PHOTO_BASE64_MAX = 5 * 1024 * 1024;
/** The most base64 text all the photos may be together: 20 MiB, which is 15 MiB of image. */
export const PHOTOS_BASE64_MAX = 20 * 1024 * 1024;

/** The MiB of image that `chars` characters of base64 hold, which sellers know as MB. */
export function imageMb(chars: number): number {
  return (chars * 3) / 4 / (1024 * 1024);
}

/** The per-photo limit in MB of image, as sellers are told it. */
export const PHOTO_MB = imageMb(PHOTO_BASE64_MAX);
/** The limit for all photos together in MB of image. */
export const PHOTOS_MB = imageMb(PHOTOS_BASE64_MAX);

/** The largest value of a Postgres integer, the column type of price and stock. */
const INT_MAX = 2_147_483_647;

export type PhotoType = 'image/jpeg' | 'image/png' | 'image/webp';

/** A photo as the form holds it: the image already downsized, and the price and stock as typed. */
export type PhotoEntry = { mediaType: PhotoType; base64: string; price: string; stock: string };

export type OnboardForm = {
  name: string;
  slug: string;
  payoutEmail: string;
  /** The chosen CSV file's text, or null when no file was chosen. */
  csvText: string | null;
  photos: PhotoEntry[];
};

export type OnboardPhoto = { mediaType: PhotoType; base64: string; priceCents: number; stock?: number };

export type OnboardRequest = {
  name: string;
  slug: string;
  payoutEmail: string;
  csvText?: string;
  images?: OnboardPhoto[];
};

type Built = { ok: true; body: OnboardRequest } | { ok: false; message: string };

/**
 * The request body for the seller's form, or the first thing the seller must fix. The name and
 * payout email are trimmed; the slug and the CSV go as they are, for the server to check. Photos
 * are counted from 1, as the page shows them.
 */
export function onboardRequest(form: OnboardForm): Built {
  const name = form.name.trim();
  if (name === '') return refuse("Enter your shop's name.");
  const payoutEmail = form.payoutEmail.trim();
  if (payoutEmail === '') return refuse('Enter the PayPal email your payouts go to.');
  if (form.csvText === null && form.photos.length === 0) return refuse('Add a catalog CSV, product photos or both.');
  if (form.csvText !== null && form.csvText.trim() === '') return refuse('Your CSV file is empty.');
  if (form.photos.length > MAX_PHOTOS) return refuse(`Add at most ${MAX_PHOTOS} photos at a time.`);

  const images: OnboardPhoto[] = [];
  let total = 0;
  for (const [index, entry] of form.photos.entries()) {
    const photo = readPhoto(entry, index + 1);
    if (typeof photo === 'string') return refuse(photo);
    total += entry.base64.length;
    if (total > PHOTOS_BASE64_MAX) {
      return refuse(`Your photos come to more than ${PHOTOS_MB} MB together. Remove some and try again.`);
    }
    images.push(photo);
  }

  const body: OnboardRequest = { name, slug: form.slug.trim(), payoutEmail };
  if (form.csvText !== null) body.csvText = form.csvText;
  if (images.length > 0) body.images = images;
  return { ok: true, body };
}

/** One photo as the server takes it, or what is wrong with it. */
function readPhoto(entry: PhotoEntry, number: number): OnboardPhoto | string {
  const priceCents = dollarsToCents(entry.price);
  if (priceCents === null || priceCents <= 0) return `Give photo ${number} a price in dollars, such as 4.50.`;
  if (priceCents > INT_MAX) return `Photo ${number}'s price can be at most ${formatUsd(INT_MAX)}.`;

  const stockText = entry.stock.trim();
  const stock = stockText === '' ? undefined : Number(stockText);
  if (stock !== undefined && (!/^\d+$/.test(stockText) || stock > INT_MAX)) {
    return `Photo ${number}'s stock must be a whole number. Leave it blank if you don't count stock.`;
  }

  if (entry.base64.length > PHOTO_BASE64_MAX) {
    return `Photo ${number} is larger than ${PHOTO_MB} MB even after resizing. Use a smaller photo.`;
  }
  return { mediaType: entry.mediaType, base64: entry.base64, priceCents, ...(stock === undefined ? {} : { stock }) };
}

function refuse(message: string): Built {
  return { ok: false, message };
}
