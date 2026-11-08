import type { MetadataRoute } from 'next';
import { personaSections } from '@/lib/session';

// What crawlers, AI crawlers included, may read: the public pages, such as the home page, the
// security page, /llms.txt and the public key set, and the seller catalogs open to outside shopping
// agents. The persona pages are left out, since they send a visitor without a persona back to the
// home page, and so is the rest of the API, whose routes serve the app, sellers and PayPal.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/api/sellers/'],
      disallow: ['/api/', ...personaSections().map((section) => `/${section}`)],
    },
  };
}
