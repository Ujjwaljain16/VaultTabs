/**
 * "Never sync" domain rules. An entry such as `bank.com` matches that host and all of its
 * subdomains (`www.bank.com`, `login.eu.bank.com`), but not `notbank.com`.
 */

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Normalizes user input (a bare domain, `*.domain`, or a full URL) to a lower-case ASCII
 * hostname, or returns null if it is not a valid host.
 */
export function normalizeDomainInput(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.+$/, '');

  let host: string;
  try {
    // URL parsing handles schemes, ports, paths and IDN → punycode.
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
  if (!host || host.length > 253) return null;
  if (host.startsWith('[')) return host; // IPv6 literal, already validated by URL
  const labels = host.split('.');
  if (!labels.every(l => LABEL.test(l))) return null;
  return host;
}

export function hostMatchesDomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === domain || host.endsWith(`.${domain}`);
}

export function isExcludedUrl(url: string, domains: readonly string[]): boolean {
  if (domains.length === 0) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return true;
  }
  return domains.some(d => hostMatchesDomain(host, d));
}
