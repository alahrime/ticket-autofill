import { useEffect } from 'react';

/** Sets the tab's title while the page is shown. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} - Shop admin`;
  }, [title]);
}
