import { AppShell } from '@/components/shell/app-shell';

// Every seller page sits in the app shell. Each page still checks the persona itself.

export default function SellerLayout({ children }: LayoutProps<'/seller'>) {
  return <AppShell persona="seller">{children}</AppShell>;
}
