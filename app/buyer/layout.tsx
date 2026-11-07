import { AppShell } from '@/components/shell/app-shell';

// Every buyer page sits in the app shell. Each page still checks the persona itself.

export default function BuyerLayout({ children }: LayoutProps<'/buyer'>) {
  return <AppShell persona="buyer">{children}</AppShell>;
}
