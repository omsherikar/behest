import { EmptyState } from '@/components/ui/empty-state';

/** What the catalog and orders pages show before the seller's shop is onboarded. */
export function NotOnboarded() {
  return (
    <EmptyState
      message="Your shop is not onboarded yet. List your products from a CSV file or photos, and they show up here."
      action={{ href: '/seller', label: 'Onboard your shop' }}
    />
  );
}
