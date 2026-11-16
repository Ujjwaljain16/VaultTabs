/** Helpers that drive the real PWA (web dashboard) UI. */

import { expect, type Locator, type Page } from '@playwright/test';
import { PASSWORD } from './browsers';
import { PWA_URL } from './env';

export async function pwaRegister(
  page: Page,
  email: string,
  remember: boolean,
  password = PASSWORD,
): Promise<string> {
  await page.goto(`${PWA_URL}/register`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.fill('#confirm', password);
  await page.getByLabel('Remember this browser').setChecked(remember);
  await page.getByRole('button', { name: /CREATE ACCOUNT/ }).click();
  const code = page.locator('output[aria-label="Recovery code"]');
  await expect(code).toBeVisible({ timeout: 30_000 });
  const text = (await code.textContent())!.trim();
  const proceed = page.getByRole('button', { name: /Open my vault/ });
  await expect(proceed).toBeDisabled();
  await page.getByLabel('I saved my recovery code somewhere safe.').check();
  await proceed.click();
  await expect(page).toHaveURL(/\/dashboard/);
  return text;
}

export async function pwaLogin(
  page: Page,
  email: string,
  remember: boolean,
  password = PASSWORD,
): Promise<void> {
  await page.goto(`${PWA_URL}/login`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.getByRole('checkbox').setChecked(remember);
  await page.getByRole('button', { name: /SIGN IN & UNLOCK/ }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
}

/** The page's alert (Next's route announcer also has role=alert and is excluded). */
export function pwaAlert(scope: Page | Locator) {
  return scope.locator('[role="alert"]:not(#__next-route-announcer__)');
}

/**
 * In-app navigation (keeps the in-memory key; a full page load would lock a vault that is not
 * remembered, by design).
 */
export async function pwaNav(page: Page, to: 'Tabs' | 'Devices' | 'Settings'): Promise<void> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: to, exact: true }).click();
  const path = { Tabs: '/dashboard', Devices: '/devices', Settings: '/settings' }[to];
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

/** Dashboard device card (a <section aria-label=device name>). */
export function pwaDeviceCard(page: Page, deviceName: string) {
  return page.getByRole('region', { name: deviceName, exact: true });
}

/** Expands a device card on the dashboard, refreshing until it is there. */
export async function pwaOpenDevice(page: Page, deviceName: string) {
  const card = pwaDeviceCard(page, deviceName);
  await expect(async () => {
    if (!(await card.isVisible())) {
      await page.getByRole('button', { name: 'Refresh' }).click();
    }
    await expect(card).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  const header = card.locator('button[aria-expanded]');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  return card;
}
