'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { type ChangeEvent, type FormEvent, type ReactNode, useRef, useState } from 'react';
import { buttonClass } from '@/components/ui/button';
import { plural } from '@/lib/domain/words';
import { onboardOutcome, type OnboardOutcome } from '@/lib/seller-pages/onboard-outcome';
import {
  CSV_MB,
  CSV_ROW_LIMIT,
  csvSizeProblem,
  imageMb,
  MAX_PHOTOS,
  onboardRequest,
  PHOTO_LONG_EDGE,
  PHOTO_MB,
  PHOTOS_MB,
  type PhotoEntry,
} from '@/lib/seller-pages/onboard-request';
import { downsizePhoto } from './downsize';

// The seller onboards their shop: its name and payout email, a catalog CSV, product photos with a
// price each, or both. Photos are downsized here before upload. Once Behest answers, the page reloads
// its data, which swaps the form for the shop's summary; this component stays in place across that
// reload, so the result of the upload (how many listings, which CSV rows were refused) stays above it.

type Photo = PhotoEntry & { key: number; fileName: string };
type Csv = { fileName: string; text: string };

const primaryButton = buttonClass('primary');
const textInput =
  'mt-2 w-full rounded-xl border border-line-strong bg-pp-surface px-3 py-2 text-pp-ink placeholder:text-pp-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue disabled:opacity-60';
const fileInput =
  'mt-2 block w-full text-sm text-pp-muted file:mr-3 file:rounded-full file:border file:border-pp-blue file:bg-pp-surface file:px-4 file:py-2 file:font-semibold file:text-pp-blue hover:file:bg-pp-highlight disabled:opacity-60';
const linkButton =
  'text-sm font-semibold text-pp-blue hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue disabled:opacity-60';

/** MB of image held by `chars` characters of base64, to two places. */
const mb = (chars: number) => imageMb(chars).toFixed(2);

export function Onboarding({ slug, onboarded, children }: { slug: string; onboarded: boolean; children: ReactNode }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [payoutEmail, setPayoutEmail] = useState('');
  const [csv, setCsv] = useState<Csv | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [photoNote, setPhotoNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<'resizing' | 'sending' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<OnboardOutcome | null>(null);
  const csvInput = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);

  if (onboarded) {
    return (
      <>
        {outcome && <OutcomePanel outcome={outcome} />}
        {children}
      </>
    );
  }

  async function chooseCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    setError(null);
    if (!file) {
      setCsv(null);
      return;
    }
    const tooLarge = csvSizeProblem(file.name, file.size);
    if (tooLarge) {
      removeCsv();
      setError(tooLarge);
      return;
    }
    try {
      setCsv({ fileName: file.name, text: await file.text() });
    } catch {
      setCsv(null);
      setError(`${file.name} could not be read. Choose the file again.`);
    }
  }

  function removeCsv() {
    setCsv(null);
    if (csvInput.current) csvInput.current.value = '';
  }

  async function addPhotos(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    // Cleared so the same photo can be chosen again after it is removed.
    input.value = '';
    if (files.length === 0) return;

    const chosen = files.slice(0, Math.max(0, MAX_PHOTOS - photos.length));
    const notes: string[] = [];
    const left = files.length - chosen.length;
    if (left > 0) {
      notes.push(`Only ${MAX_PHOTOS} photos can be listed at once, so ${plural(left, 'photo')} ${left === 1 ? 'was' : 'were'} left out.`);
    }
    setBusy('resizing');
    setError(null);
    const added: Photo[] = [];
    for (const file of chosen) {
      try {
        const { mediaType, base64 } = await downsizePhoto(file, PHOTO_LONG_EDGE);
        nextKey.current += 1;
        added.push({ key: nextKey.current, fileName: file.name, mediaType, base64, price: '', stock: '' });
      } catch {
        notes.push(`${file.name} could not be opened as a photo. Use a JPEG, PNG or WebP image.`);
      }
    }
    setPhotos((current) => [...current, ...added].slice(0, MAX_PHOTOS));
    setPhotoNote(notes.length > 0 ? notes.join(' ') : null);
    setBusy(null);
  }

  function editPhoto(key: number, field: 'price' | 'stock', value: string) {
    setPhotos((current) => current.map((photo) => (photo.key === key ? { ...photo, [field]: value } : photo)));
  }

  function removePhoto(key: number) {
    setPhotos((current) => current.filter((photo) => photo.key !== key));
    setPhotoNote(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOutcome(null);
    const built = onboardRequest({ name, slug, payoutEmail, csvText: csv?.text ?? null, photos });
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setBusy('sending');
    setError(null);
    let status: number | null = null;
    let body: unknown = null;
    try {
      const response = await fetch('/api/sellers/onboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.body),
      });
      status = response.status;
      body = await response.json().catch(() => null);
    } catch {
      // No answer came back; the outcome for a null status says so.
    }
    const result = onboardOutcome(status, body);
    setOutcome(result);
    setBusy(null);
    // Shows the shop's summary in place of the form once the shop exists.
    if (result.ok || result.refresh) router.refresh();
  }

  const photoTotal = photos.reduce((sum, photo) => sum + photo.base64.length, 0);
  const disabled = busy !== null;

  return (
    <form onSubmit={submit} className="mt-8 flex flex-col gap-8">
      <fieldset className="flex flex-col gap-5" disabled={disabled}>
        <legend className="text-lg font-semibold text-pp-navy">Shop details</legend>
        <div>
          <label htmlFor="shop-name" className="block text-sm font-semibold text-pp-navy">
            Shop name
          </label>
          <input
            id="shop-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={120}
            autoComplete="organization"
            placeholder="Ravi's Spice Co."
            className={textInput}
          />
        </div>
        <div>
          <label htmlFor="shop-slug" className="block text-sm font-semibold text-pp-navy">
            Shop slug
          </label>
          <input
            id="shop-slug"
            value={slug}
            readOnly
            aria-describedby="shop-slug-hint"
            className={`${textInput} bg-pp-canvas font-mono text-sm`}
          />
          <p id="shop-slug-hint" className="mt-1 text-sm text-pp-muted">
            Buyers name your shop by this in their mandates. It is fixed for this demo&apos;s seller.
          </p>
        </div>
        <div>
          <label htmlFor="payout-email" className="block text-sm font-semibold text-pp-navy">
            PayPal payout email
          </label>
          <input
            id="payout-email"
            type="email"
            value={payoutEmail}
            onChange={(event) => setPayoutEmail(event.target.value)}
            required
            maxLength={254}
            autoComplete="email"
            placeholder="payouts@example.com"
            aria-describedby="payout-email-hint"
            className={textInput}
          />
          <p id="payout-email-hint" className="mt-1 text-sm text-pp-muted">
            Behest pays you for each order you accept into this PayPal account.
          </p>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2" disabled={disabled}>
        <legend className="text-lg font-semibold text-pp-navy">Catalog CSV</legend>
        <p id="csv-hint" className="text-sm text-pp-muted">
          One product per row, up to {CSV_ROW_LIMIT} rows and {CSV_MB} MB. Name and price columns are needed; sku,
          description, stock and category are read when present.
        </p>
        <input
          ref={csvInput}
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => void chooseCsv(event)}
          aria-label="Catalog CSV file"
          aria-describedby="csv-hint"
          className={fileInput}
        />
        {csv && (
          <button type="button" onClick={removeCsv} className={`self-start ${linkButton}`}>
            Remove {csv.fileName}
          </button>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2" disabled={disabled}>
        <legend className="text-lg font-semibold text-pp-navy">Product photos</legend>
        <p id="photos-hint" className="text-sm text-pp-muted">
          Up to {MAX_PHOTOS} photos, one product each, with the price you sell it for. Your browser resizes each photo to
          at most {PHOTO_LONG_EDGE} px on its long edge and saves it as a JPEG. After resizing, a photo can be about{' '}
          {PHOTO_MB} MB and all of them {PHOTOS_MB} MB together.
        </p>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          onChange={(event) => void addPhotos(event)}
          disabled={photos.length >= MAX_PHOTOS}
          aria-label="Product photos"
          aria-describedby="photos-hint"
          className={fileInput}
        />
        {busy === 'resizing' && (
          <p role="status" className="text-sm text-pp-muted">
            Resizing your photos...
          </p>
        )}
        {photoNote && (
          <p role="status" className="text-sm text-pp-warning">
            {photoNote}
          </p>
        )}
        {photos.length > 0 && (
          <>
            <ul className="mt-2 flex flex-col gap-3">
              {photos.map((photo, index) => (
                <li key={photo.key} className="rounded-xl border border-pp-border bg-pp-surface p-3">
                  <div className="flex items-start gap-3">
                    <Image
                      src={`data:${photo.mediaType};base64,${photo.base64}`}
                      alt={`Photo ${index + 1}`}
                      width={64}
                      height={64}
                      unoptimized
                      className="size-16 shrink-0 rounded-lg border border-pp-border object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-pp-navy">Photo {index + 1}</p>
                      <p className="truncate text-sm text-pp-muted">{photo.fileName}</p>
                      <p className="text-sm text-pp-muted">{mb(photo.base64.length)} MB after resizing</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removePhoto(photo.key)}
                      aria-label={`Remove photo ${index + 1}`}
                      className={linkButton}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <label className="block text-sm font-semibold text-pp-navy">
                      Price in dollars
                      <input
                        value={photo.price}
                        onChange={(event) => editPhoto(photo.key, 'price', event.target.value)}
                        aria-label={`Photo ${index + 1} price in dollars`}
                        inputMode="decimal"
                        placeholder="4.50"
                        maxLength={16}
                        className={`${textInput} font-normal`}
                      />
                    </label>
                    <label className="block text-sm font-semibold text-pp-navy">
                      Stock, if you count it
                      <input
                        value={photo.stock}
                        onChange={(event) => editPhoto(photo.key, 'stock', event.target.value)}
                        aria-label={`Photo ${index + 1} stock, if you count it`}
                        inputMode="numeric"
                        placeholder="12"
                        maxLength={10}
                        className={`${textInput} font-normal`}
                      />
                    </label>
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-sm text-pp-muted">
              {plural(photos.length, 'photo')}, {mb(photoTotal)} of {PHOTOS_MB} MB.
            </p>
          </>
        )}
      </fieldset>

      <div>
        <button type="submit" disabled={disabled} className={primaryButton}>
          {busy === 'sending' ? 'Building your catalog...' : 'Onboard my shop'}
        </button>
        {busy === 'sending' && (
          <p role="status" className="mt-2 text-sm text-pp-muted">
            Behest is writing your listings, screening each one for text aimed at AI agents and checking market
            prices. This can take a minute.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-4 text-sm text-pp-danger">
            {error}
          </p>
        )}
        {outcome && <OutcomePanel outcome={outcome} />}
      </div>
    </form>
  );
}

/** How the upload went: the listings made and the rows refused, or why nothing was saved. */
function OutcomePanel({ outcome }: { outcome: OnboardOutcome }) {
  if (!outcome.ok) {
    return (
      <p role="alert" className="mt-6 rounded-xl border border-pp-danger bg-pp-surface p-4 text-sm text-pp-danger">
        {outcome.message}
      </p>
    );
  }
  return (
    <section role="status" aria-labelledby="outcome-heading" className="mt-6 rounded-xl border border-pp-success bg-pp-surface p-5">
      <h2 id="outcome-heading" className="font-semibold text-pp-success">
        {outcome.headline}
      </h2>
      {outcome.flaggedNote && <p className="mt-2 text-sm text-pp-warning">{outcome.flaggedNote}</p>}
      {outcome.rejected.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-semibold text-pp-navy">
            {plural(outcome.rejected.length, 'row')} of your CSV could not be listed:
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-pp-muted">
            {outcome.rejected.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
