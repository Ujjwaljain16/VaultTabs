
import sql from '../src/db/client.js';

async function verify() {
    try {
        const snaps = await sql`SELECT encrypted_blob FROM snapshots LIMIT 1`;
        if (snaps.length > 0) {
            console.log('--- Zero-Knowledge Audit: DB Content Verification ---');
            console.log('Sample Encrypted Blob (first 50 chars):');
            console.log(snaps[0].encrypted_blob.substring(0, 50) + '...');

            // Check if it looks like JSON or plaintext
            const isPlaintext = snaps[0].encrypted_blob.includes('"url"') || snaps[0].encrypted_blob.includes('"title"');
            console.log('Contains plaintext keywords ("url", "title"):', isPlaintext);

            if (!isPlaintext) {
                console.log('Verification: SUCCESS - Data is correctly encrypted.');
            } else {
                console.error('Verification: FAILURE - Plaintext data leaked into snapshots table!');
            }
        } else {
            console.log('No snapshots found to verify.');
        }
    } catch (err) {
        console.error('Database query failed:', (err as Error).message);
    } finally {
        await sql.end();
    }
}

verify();
