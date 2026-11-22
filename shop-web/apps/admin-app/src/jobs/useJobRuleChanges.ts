// The admin's changes to the job rules (accept or change a group's job, remove a rule), as one hook. Every
// request is keyed by the key of the card that sent it (not by what it posts: a proposal's words can differ
// from the group's), so that card, and only that card, is busy while it runs and shows its refusal. Several
// cards may be in flight at once. After any change, success or refusal, the group lists, the coverage and the
// rule list are fetched again.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getListJobMapQueryKey, getListJobRulesQueryKey, useDeleteJobRule, usePutJobRule } from '@shop/api-client';
import { errorText } from '../lib/format';

/** One group (or rule) as a string: the code and its words. */
export const groupKey = (imCode: string, words: readonly string[]): string => `${imCode}|${words.join(' ')}`;

export type JobRuleChanges = {
  /** This card has a request running. */
  isBusy(cardKey: string): boolean;
  /** Why this card's last change failed (the server's text), or null. */
  errorOf(cardKey: string): string | null;
  /** Saves the rule for the card; true when the server took it. */
  save(cardKey: string, imCode: string, words: string[], job: string): Promise<boolean>;
  /** Drops the rule for the card; true when the server answered. */
  remove(cardKey: string, imCode: string, words: string[]): Promise<boolean>;
};

export function useJobRuleChanges(): JobRuleChanges {
  const client = useQueryClient();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const settled = {
    mutation: {
      onSettled: async () => {
        await Promise.all([
          client.invalidateQueries({ queryKey: getListJobMapQueryKey() }),
          client.invalidateQueries({ queryKey: getListJobRulesQueryKey() }),
        ]);
      },
    },
  };
  const putM = usePutJobRule(settled);
  const deleteM = useDeleteJobRule(settled);

  async function run(key: string, send: () => Promise<unknown>): Promise<boolean> {
    setErrors((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== key)));
    setBusy((b) => new Set(b).add(key));
    try {
      await send();
      return true;
    } catch (e) {
      setErrors((x) => ({ ...x, [key]: errorText(e) }));
      return false;
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(key);
        return next;
      });
    }
  }

  return {
    isBusy: (key) => busy.has(key),
    errorOf: (key) => errors[key] ?? null,
    save: (key, im_code, words, job) => run(key, () => putM.mutateAsync({ data: { im_code, words, job } })),
    remove: (key, im_code, words) => run(key, () => deleteM.mutateAsync({ data: { im_code, words } })),
  };
}

/** What the admin typed as words -> upper-case, split on spaces and commas, each once. */
export function parseWords(text: string): string[] {
  return [...new Set(text.toUpperCase().split(/[\s,]+/).filter(Boolean))];
}
