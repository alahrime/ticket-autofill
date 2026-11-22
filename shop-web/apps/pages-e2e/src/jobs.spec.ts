// The React admin app's Job mapping (/jobs), against the made-up InvoMax lines global-setup.ts writes: LABOR lines
// (REPLACE FRONT PADS, REPLACE REAR BRAKE PADS) and a PADS part line (BRAKE PAD SET). Nothing here touches the real shop.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { scrollsSideways, signIn } from './shop';

async function noViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations).toEqual([]);
}

/** The percent of lines in the coverage text. */
async function linesPercent(page: Page): Promise<number> {
  const text = (await page.getByText(/^Mapped: \d+% of lines/).textContent()) ?? '';
  return Number(/(\d+)% of lines/.exec(text)?.[1]);
}

test('Job mapping: accept 2 proposed groups, coverage goes up, no axe violations', async ({ page }) => {
  await signIn(page.context().request, 'admin', 'Owner Test');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/admin');
  await page.getByRole('link', { name: 'Job mapping' }).click();
  await expect(page).toHaveURL(/\/jobs$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Job mapping' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to tickets' })).toHaveAttribute('href', '/admin');

  const before = await linesPercent(page);
  const accepts = page.getByRole('button', { name: 'Accept', exact: true });
  await expect(accepts.first()).toBeVisible();
  const groups = page.getByRole('group').filter({ has: page.getByRole('button', { name: 'Accept', exact: true }) });
  expect(await groups.count()).toBeGreaterThanOrEqual(2);
  await noViolations(page);

  // a Change form open, with its job picker: still no violations
  await groups.first().getByRole('button', { name: 'Change' }).click();
  const form = page.getByRole('form', { name: /^Change the job for/ });
  await expect(form.getByLabel(/^Job \(/)).toBeVisible();
  await noViolations(page);
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);

  // the groups with a proposal have an Accept that works; the one without (PADS) has it off
  const proposed = page.getByRole('button', { name: 'Accept', exact: true, disabled: false });
  await expect(proposed).toHaveCount(2);
  for (let left = 1; left >= 0; left--) {
    await proposed.first().click();
    await expect(proposed).toHaveCount(left);
  }
  await expect.poll(() => linesPercent(page)).toBeGreaterThan(before);

  // the mapped ones are listed, each removable
  await page.getByRole('checkbox', { name: 'Show mapped' }).check();
  await expect(page).toHaveURL(/[?&]mapped=1/);
  const removes = page.getByRole('button', { name: 'Remove' });
  await expect(removes).toHaveCount(2);
  await noViolations(page);

  // a phone's width: nothing scrolls sideways
  await page.setViewportSize({ width: 375, height: 800 });
  await page.reload();
  await expect(removes.first()).toBeVisible();
  expect(await scrollsSideways(page)).toBe(false);
  await noViolations(page);
  await page.getByRole('checkbox', { name: 'Show mapped' }).uncheck();
  await expect(page.getByRole('button', { name: 'Accept', exact: true }).first()).toBeVisible();
  expect(await scrollsSideways(page)).toBe(false);
  await noViolations(page);

  // remove one: it is unmapped again
  await page.getByRole('checkbox', { name: 'Show mapped' }).check();
  await removes.first().click();
  await expect(removes).toHaveCount(1);
});

test('signed out, /jobs goes to the admin sign-in', async ({ page }) => {
  await page.goto('/jobs');
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});
