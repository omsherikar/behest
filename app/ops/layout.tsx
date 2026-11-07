import { AppShell } from '@/components/shell/app-shell';

// Every operator page sits in the app shell. Each page still checks the persona itself.

export default function OperatorLayout({ children }: LayoutProps<'/ops'>) {
  return <AppShell persona="operator">{children}</AppShell>;
}
