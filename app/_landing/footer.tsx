import { PersonaPicker } from '../persona-picker';
import { DOCS, SOURCE_URL, sourceLink } from './links';
import { Section } from './section';

// The close of the home page: the three personas that start the demo, then the footer with the
// docs, the source and the one fact about money.

export function TryIt() {
  return (
    <Section
      id="try"
      index={6}
      name="Try it"
      statement={['Pick a role.', 'Run the demo.']}
      lead="No sign-up. Each role opens its own pages, and everything runs against the PayPal sandbox."
    >
      <PersonaPicker />
    </Section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="container-page grid gap-10 py-14 sm:grid-cols-[minmax(0,1fr)_auto] lg:py-16">
        <div>
          <p className="font-mono text-[1.0625rem] font-semibold tracking-[-0.03em] text-text">behest</p>
          <p className="mt-3 max-w-[40ch] text-body text-muted">Signed proof of what you authorized, on every purchase your AI agent makes.</p>
          <p className="mt-6 text-meta text-muted">PayPal sandbox only; no real money moves.</p>
        </div>
        <div className="flex flex-wrap gap-x-16 gap-y-8 text-body">
          <div>
            <p className="text-meta text-muted">Docs</p>
            <ul className="mt-3 grid gap-2">
              {DOCS.map(({ label, path }) => {
                const href = sourceLink(path);
                return (
                  <li key={path}>
                    {href ? (
                      <a href={href} className="text-text hover:underline hover:underline-offset-4">
                        {label}
                      </a>
                    ) : (
                      <span className="text-text">
                        {label} <code className="ml-1 font-mono text-meta text-muted">{path}</code>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          <div>
            <p className="text-meta text-muted">Source</p>
            <p className="mt-3">
              {SOURCE_URL ? (
                <a href={SOURCE_URL} className="text-text hover:underline hover:underline-offset-4">
                  GitHub
                </a>
              ) : (
                <span className="text-text">In the repository, private for now</span>
              )}
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
