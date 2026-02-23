/**
 * utils/fingerprint.ts
 *
 * Generates a stable browser fingerprint based on hardware and software traits.
 * This is used as a secondary device identifier if local storage is wiped.
 */

export async function getBrowserFingerprint(): Promise<string> {
    const components = [
        navigator.userAgent,
        navigator.language,
        new Date().getTimezoneOffset().toString(),
        screen.width.toString(),
        screen.height.toString(),
        screen.colorDepth.toString(),
        navigator.hardwareConcurrency?.toString() || 'unknown',
        // We could add more like fonts or canvas but this is enough for the user's personal browsers
    ];

    const raw = components.join('|');
    const encoder = new TextEncoder();
    const data = encoder.encode(raw);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
