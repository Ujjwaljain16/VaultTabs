import { expect, test } from '@playwright/test';
import { ExtBrowser, PASSWORD, uniqueEmail, type Popup } from '../support/browsers';
import { closeDb, devices, dumpAllText } from '../support/db';
import { restartBackend } from '../support/servers';

test.describe.configure({ mode: 'serial' });

let a: ExtBrowser;
let b: ExtBrowser;
let pa: Popup;
let pb: Popup;
const email = uniqueEmail('accounts');
let recoveryCode = '';

test.beforeAll(async () => {
  await restartBackend();
  a = await ExtBrowser.launch('Personal Chrome');
  b = await ExtBrowser.launch('Brave personal');
});

test.afterAll(async () => {
  await a?.destroy();
  await b?.destroy();
  await closeDb();
});

test('register form validates email, password length and confirmation', async () => {
  pa = await a.popup();
  await expect(pa.locator('#screen-auth')).toBeVisible();

  await pa.fillRegister({ email: 'not-an-email', password: PASSWORD });
  await expect(pa.locator('#reg-error')).toHaveText('Enter a valid email address.');

  await pa.fillRegister({ email, password: 'short' });
  await expect(pa.locator('#reg-error')).toHaveText('Use at least 10 characters.');
  await expect(pa.locator('#reg-strength-label')).toContainText('Too short');

  await pa.fillRegister({ email, password: PASSWORD, confirm: `${PASSWORD}!` });
  await expect(pa.locator('#reg-error')).toHaveText('Passwords do not match.');
  await expect(pa.locator('#screen-auth')).toBeVisible();
});

test('recovery code screen is gated by the checkbox and shown only once', async () => {
  await pa.fillRegister({ email, password: PASSWORD, deviceName: 'Personal Chrome' });
  await expect(pa.locator('#screen-recovery')).toBeVisible({ timeout: 30_000 });
  recoveryCode = (await pa.locator('#recovery-code-text').textContent())!.trim();
  expect(recoveryCode).toMatch(/^VAULT(-[A-Z0-9]{4}){5}$/);

  const proceed = pa.locator('#btn-recovery-continue');
  await expect(proceed).toBeDisabled();
  await pa.page.check('#recovery-saved-check');
  await expect(proceed).toBeEnabled();
  await pa.page.uncheck('#recovery-saved-check');
  await expect(proceed).toBeDisabled();
  await pa.page.check('#recovery-saved-check');
  await proceed.click();

  await expect(pa.locator('#screen-main')).toBeVisible();
  await expect(pa.locator('#info-device')).toHaveText('Personal Chrome');
  await expect(pa.locator('#recovery-code-text')).toHaveText('');

  // Re-opening the popup goes straight to the vault; the code is never shown again or stored.
  await pa.reload();
  await expect(pa.locator('#screen-main')).toBeVisible();
  await expect(pa.locator('#screen-recovery')).toBeHidden();
  expect(JSON.stringify(await a.storage())).not.toContain(recoveryCode);
  expect(await dumpAllText()).not.toContain(recoveryCode);
});

test('wrong password and unknown email fail with the same message (no enumeration)', async () => {
  pb = await b.popup();
  await pb.fillLogin(email, 'definitely the wrong password');
  const wrongPassword = pb.locator('#login-error');
  await expect(wrongPassword).toBeVisible({ timeout: 30_000 });
  const wrongText = await wrongPassword.textContent();

  await pb.fillLogin(uniqueEmail('nobody'), 'definitely the wrong password');
  await expect(pb.locator('#btn-login')).toBeEnabled({ timeout: 30_000 });
  await expect(pb.locator('#login-error')).toBeVisible();
  expect(await pb.locator('#login-error').textContent()).toBe(wrongText);
  expect(wrongText).not.toMatch(/not found|no account|unknown/i);
});

test('login in a second browser with a custom device name', async () => {
  await pb.login(email, 'Brave personal');
  await expect(pb.locator('#info-device')).toHaveText('Brave personal');
  await expect(pb.locator('#user-email-display')).toHaveText(email);
  expect((await devices(email)).map(d => d.device_name).sort()).toEqual([
    'Brave personal',
    'Personal Chrome',
  ]);
});

test('registering an existing email is refused', async () => {
  const pc = await b.popup();
  await pc.view('settings');
  await pc.page.click('#btn-logout');
  await expect(pc.locator('#screen-auth')).toBeVisible();
  await pc.fillRegister({ email, password: PASSWORD });
  await expect(pc.locator('#reg-error')).toContainText('already exists', { timeout: 30_000 });
  await pc.page.close();
});

test('logout then login again reuses the same device', async () => {
  const before = await devices(email);
  await pb.reload();
  await expect(pb.locator('#screen-auth')).toBeVisible();
  // The device-name field is pre-filled with the default name; the user types theirs again.
  await pb.login(email, 'Brave personal');
  expect(await devices(email)).toEqual(before);
});

test('logging in again without retyping the name keeps the device and its name', async () => {
  const before = await devices(email);
  await pb.view('settings');
  await pb.page.click('#btn-logout');
  await expect(pb.locator('#screen-auth')).toBeVisible();
  // The user opens the popup again later: the form is fresh and the device name field holds the
  // auto-generated default, which the user does not touch.
  await pb.reload();
  await expect(pb.locator('#login-device-name')).toHaveValue(/^Chrome on /);
  await pb.page.fill('#login-email', email);
  await pb.page.fill('#login-password', PASSWORD);
  await pb.page.click('#btn-login');
  await expect(pb.locator('#screen-main')).toBeVisible({ timeout: 30_000 });
  await expect(pb.locator('#info-device')).toHaveText('Brave personal');
  expect(await devices(email)).toEqual(before);
});

test('rename this device from the popup', async () => {
  await pb.page.click('#stat-device-box');
  await pb.page.fill('#rename-input', 'Brave work');
  await pb.page.click('#btn-save-rename');
  await expect(pb.locator('#rename-overlay')).toBeHidden();
  await expect(pb.locator('#info-device')).toHaveText('Brave work');
  expect((await devices(email)).map(d => d.device_name).sort()).toEqual(['Brave work', 'Personal Chrome']);
  await pb.page.click('#stat-device-box');
  await pb.page.fill('#rename-input', 'Brave personal');
  await pb.page.click('#btn-save-rename');
  await expect(pb.locator('#info-device')).toHaveText('Brave personal');
});

test('a missing vault key locks the popup until the password is entered', async () => {
  await b.inExtensionPage(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('vaulttabs');
        open.onsuccess = () => {
          const tx = open.result.transaction('crypto-keys', 'readwrite');
          tx.objectStore('crypto-keys').delete('master_key');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
      }),
  );
  await pb.reload();
  await expect(pb.locator('#screen-relogin')).toBeVisible();
  await expect(pb.locator('#relogin-desc')).toContainText('vault key is missing');
  await expect(pb.locator('#relogin-email-display')).toHaveText(email);

  await pb.page.fill('#relogin-password', 'wrong password again');
  await pb.page.click('#btn-relogin');
  await expect(pb.locator('#relogin-error')).toBeVisible({ timeout: 30_000 });

  const before = await devices(email);
  await pb.page.fill('#relogin-password', PASSWORD);
  await pb.page.click('#btn-relogin');
  await expect(pb.locator('#screen-main')).toBeVisible({ timeout: 30_000 });
  await expect(pb.locator('#info-device')).toHaveText('Brave personal');
  expect(await devices(email)).toEqual(before);
});
