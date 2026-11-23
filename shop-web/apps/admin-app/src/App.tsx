// The admin app's shell: the header (back to the tickets board, the app's pages) and the page for
// location.pathname. /bills, /jobs and /bills/<no>/print are served by the shop server to a signed-in admin only.
// The print page is bare (no header): it is what goes to the printer.
import { BillHistory } from './bills/BillHistory';
import { JobMapping } from './jobs/JobMapping';
import { useDocumentTitle } from './lib/useDocumentTitle';
import { usePathname } from './lib/useQueryState';
import { BillPrint } from './print/BillPrint';

const PAGES = [
  { path: '/bills', title: 'Bill history', Page: BillHistory },
  { path: '/jobs', title: 'Job mapping', Page: JobMapping },
] as const;

function NotFound() {
  return (
    <p>
      There is no such page here. <a href="/bills">Go to Bill history</a>.
    </p>
  );
}

function Shell({ path }: { path: string }) {
  const page = PAGES.find((p) => p.path === path);
  const title = page?.title ?? 'Page not found';
  useDocumentTitle(title);
  const Page = page?.Page ?? NotFound;

  return (
    <>
      <header className="top">
        <a className="back" href="/admin">
          Back to tickets
        </a>
        <nav aria-label="Admin app">
          <ul>
            {PAGES.map((p) => (
              <li key={p.path}>
                <a href={p.path} aria-current={p.path === path ? 'page' : undefined}>
                  {p.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main>
        <h1>{title}</h1>
        <Page />
      </main>
    </>
  );
}

const PRINT = /^\/bills\/(\d{1,7})\/print$/;

export function App() {
  const path = usePathname();
  const print = PRINT.exec(path);
  return print ? <BillPrint no={print[1]} /> : <Shell path={path} />;
}
