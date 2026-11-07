import { AppShell } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/ui/page-header';
import { PersonaPicker } from './persona-picker';

export default function Home() {
  return (
    <AppShell>
      <div className="w-full max-w-2xl sm:pt-6">
        <PageHeader
          title="Pick who you are for this demo"
          purpose="Behest attaches signed proof of what a person authorized to every purchase their AI agent makes on PayPal."
        />
        <PersonaPicker />
      </div>
    </AppShell>
  );
}
