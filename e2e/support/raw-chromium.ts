/**
 * A Chromium process with the extension loaded but WITHOUT Playwright attached.
 *
 * Playwright (like any DevTools client) attaches to the extension's service worker, and Chromium
 * never idle-terminates a worker that DevTools is attached to. To observe real MV3 lifetime
 * behaviour (the worker is stopped after ~30 s without events), this launches the browser
 * directly and only reads the target list over the DevTools HTTP endpoint (/json/list), which
 * does not attach to anything.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { chromium } from '@playwright/test';
import { EXTENSION_DIR, EXTENSION_ID, HEADED } from './env';

export interface Target {
  type: string;
  url: string;
  title: string;
}

export class RawChromium {
  private constructor(
    private readonly proc: ChildProcess,
    private readonly port: number,
  ) {}

  static async launch(userDataDir: string, port: number): Promise<RawChromium> {
    const proc = spawn(
      chromium.executablePath(),
      [
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${port}`,
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-search-engine-choice-screen',
        ...(HEADED ? [] : ['--headless=new']),
        // Linux CI runners (Ubuntu 24 AppArmor) block the setuid/user-namespace sandbox; Playwright
        // passes these itself, but this process is launched without Playwright.
        ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const raw = new RawChromium(proc, port);
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await raw.targets();
        return raw;
      } catch {
        if (Date.now() > deadline || proc.exitCode !== null) {
          proc.kill();
          throw new Error(`raw chromium did not start (exit ${proc.exitCode}):
${stderr}`);
        }
        await new Promise(r => setTimeout(r, 250));
      }
    }
  }

  async targets(): Promise<Target[]> {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    return (await res.json()) as Target[];
  }

  async workerRunning(): Promise<boolean> {
    return (await this.targets()).some(
      t => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`),
    );
  }

  async pageUrls(): Promise<string[]> {
    return (await this.targets()).filter(t => t.type === 'page').map(t => t.url);
  }

  /**
   * Stops the extension's service worker exactly like Chromium's idle timeout does, by pressing
   * "Stop" on chrome://serviceworker-internals. Only that page target is attached, never the
   * worker itself.
   */
  async stopWorker(): Promise<void> {
    // /json/new takes the URL verbatim (not percent-decoded).
    const res = await fetch(`http://127.0.0.1:${this.port}/json/new?chrome://serviceworker-internals/`, {
      method: 'PUT',
    });
    const target = (await res.json()) as { id: string; webSocketDebuggerUrl: string };
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const expression = `new Promise((resolve, reject) => {
      const started = Date.now();
      // Each registration block lists "Scope: chrome-extension://<id>/" and its own "Stop" control;
      // other (component) extensions are listed too, so pick the Stop inside OUR block.
      const find = () => {
        for (const el of document.querySelectorAll('*')) {
          if (el.children.length || el.textContent.trim() !== 'Stop' || !el.offsetParent) continue;
          let block = el.parentElement;
          while (block && !block.textContent.includes('Scope:')) block = block.parentElement;
          if (block && block.textContent.split('Scope:').length === 2 && block.textContent.includes('${EXTENSION_ID}')) return el;
        }
        return null;
      };
      const tick = () => {
        const text = document.body.innerText;
        const button = find();
        if (button) {
          button.click();
          // Report what the page says about OUR worker shortly after.
          setTimeout(() => {
            // The page re-renders after a stop: look our registration block up again.
            const block = [...document.querySelectorAll('*')].find(
              el => el.textContent.split('Scope:').length === 2 && el.textContent.includes('${EXTENSION_ID}') && el.textContent.includes('Running Status'),
            );
            resolve((/Running Status:\\s*(\\w+)/.exec(block ? block.innerText : '') || [])[1] || 'unknown: ' + (block ? block.innerText.slice(0, 600) : 'no block'));
          }, 1500);
        }
        else if (Date.now() - started > 10000) reject(new Error('Stop button not found on ' + location.href + ': ' + text.slice(0, 400)));
        else setTimeout(tick, 200);
      };
      tick();
    })`;
    const reply = await new Promise<{ result?: { exceptionDetails?: unknown; result?: { value?: string } } }>(
      resolve => {
        ws.onmessage = e => resolve(JSON.parse(String(e.data)) as never);
        ws.send(
          JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true } }),
        );
      },
    );
    ws.close();
    await fetch(`http://127.0.0.1:${this.port}/json/close/${target.id}`);
    if (reply.result?.exceptionDetails) throw new Error(`stopWorker failed: ${JSON.stringify(reply)}`);
    const status = reply.result?.result?.value;
    if (status !== 'STOPPED') throw new Error(`service worker did not stop (status ${status})`);
  }

  async close(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    const exited = new Promise(resolve => this.proc.once('exit', resolve));
    this.proc.kill();
    await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
  }
}
