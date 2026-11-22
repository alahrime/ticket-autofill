// The admin's changes to the job rules (accept or change a group's job, remove a rule), as one hook. It tracks
// which group's request is running (so only that group's buttons are disabled) and why the last one failed.
// After any change, success or refusal, the job-map lists (with their coverage) are fetched again.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getListJobMapQueryKey, useDeleteJobRule, usePutJobRule } from '@shop/api-client';
import { errorText } from '../lib/format';

/** One group (or rule) as a string: the code and its words. */
export const groupKey = (imCode: string, words: readonly string[]): string => `${imCode}|${words.join(' ')}`;

export type JobRuleChanges = {
  /** The groupKey whose request is running, or null. */
  busy: string | null;
  /** Why the last change failed (the server's text), or null. */
  error: string | null;
  /** The groupKey that change was for. */
  errorKey: string | null;
  clearError(): void;
  /** Saves the rule; true when the server took it. */
  save(imCode: string, words: string[], job: string): Promise<boolean>;
  /** Drops the rule; true when the server answered. */
  remove(imCode: string, words: string[]): Promise<boolean>;
};

export function useJobRuleChanges(): JobRuleChanges {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ key: string; text: string } | null>(null);
  const settled = { mutation: { onSettled: () => client.invalidateQueries({ queryKey: getListJobMapQueryKey() }) } };
  const putM = usePutJobRule(settled);
  const deleteM = useDeleteJobRule(settled);

  async function run(key: string, send: () => Promise<unknown>): Promise<boolean> {
    setFailed(null);
    setBusy(key);
    try {
      await send();
      return true;
    } catch (e) {
      setFailed({ key, text: errorText(e) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  return {
    busy,
    error: failed?.text ?? null,
    errorKey: failed?.key ?? null,
    clearError: () => setFailed(null),
    save: (im_code, words, job) => run(groupKey(im_code, words), () => putM.mutateAsync({ data: { im_code, words, job } })),
    remove: (im_code, words) => run(groupKey(im_code, words), () => deleteM.mutateAsync({ data: { im_code, words } })),
  };
}

/** What the admin typed as words -> upper-case, split on spaces and commas, each once. */
export function parseWords(text: string): string[] {
  return [...new Set(text.toUpperCase().split(/[\s,]+/).filter(Boolean))];
}
