
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import https from 'https';

const API_BASE = 'https://localhost:3000/api/v1';

// Bypass SSL verification for local mkcert certs
const axiosInstance = axios.create({
    httpsAgent: new https.Agent({
        rejectUnauthorized: false
    })
});

async function runTest() {
    console.log('--- Starting Multi-Device Sync Test ---');
    const email = `test-${Date.now()}@example.com`;
    const password = 'Password123!';

    try {
        // 1. Register User
        console.log('1. Registering user...');
        const regRes = await axiosInstance.post(`${API_BASE}/auth/register`, {
            email,
            password,
            encrypted_master_key: 'enc_mk',
            master_key_iv: 'iv_mk',
            salt: 'salt_mk'
        });
        const token = regRes.data.token;
        console.log('   User registered. Token acquired.');

        // 2. Register Device A
        console.log('2. Registering Device A...');
        const devARes = await axiosInstance.post(`${API_BASE}/devices/register`, {
            device_name: 'Chrome on Windows'
        }, { headers: { Authorization: `Bearer ${token}` } });
        const deviceAId = devARes.data.device.id;
        console.log(`   Device A registered: ${deviceAId}`);

        // 3. Register Device B
        console.log('3. Registering Device B...');
        const devBRes = await axiosInstance.post(`${API_BASE}/devices/register`, {
            device_name: 'Firefox on Linux'
        }, { headers: { Authorization: `Bearer ${token}` } });
        const deviceBId = devBRes.data.device.id;
        console.log(`   Device B registered: ${deviceBId}`);

        // 4. Sync Snapshot from Device A
        console.log('4. Syncing snapshot from Device A...');
        await axiosInstance.post(`${API_BASE}/snapshots`, {
            device_id: deviceAId,
            captured_at: new Date().toISOString(),
            iv: 'iv_a',
            encrypted_blob: 'blob_a'
        }, { headers: { Authorization: `Bearer ${token}` } });

        // 5. Sync Snapshot from Device B
        console.log('5. Syncing snapshot from Device B...');
        await axiosInstance.post(`${API_BASE}/snapshots`, {
            device_id: deviceBId,
            captured_at: new Date().toISOString(),
            iv: 'iv_b',
            encrypted_blob: 'blob_b'
        }, { headers: { Authorization: `Bearer ${token}` } });

        // 6. Verify Latest Snapshots
        console.log('6. Verifying latest snapshots...');
        const snapshotsRes = await axiosInstance.get(`${API_BASE}/snapshots/latest`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const snapshots = snapshotsRes.data.snapshots;
        console.log(`   Found ${snapshots.length} latest snapshots.`);
        if (snapshots.length !== 2) throw new Error('Expected 2 snapshots');

        // 7. Initiate Restore from Device B targeting Device A
        console.log('7. Initiating restore from B to A...');
        const restoreRes = await axiosInstance.post(`${API_BASE}/restore`, {
            target_device_id: deviceAId,
            snapshot_id: snapshots.find((s: any) => s.device_id === deviceBId).id
        }, { headers: { Authorization: `Bearer ${token}` } });
        const requestId = restoreRes.data.request_id;
        console.log(`   Restore request created: ${requestId}`);

        // 8. Poll for Restore Request as Device A
        console.log('8. Polling for restore request as Device A...');
        const pendingRes = await axiosInstance.get(`${API_BASE}/restore/pending?device_id=${deviceAId}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (pendingRes.data.pending) {
            console.log('   Device A received the restore request! Test PASSED.');
        } else {
            throw new Error('Device A did not see pending restore request');
        }

    } catch (err: any) {
        console.error('Test FAILED:', err.response?.data || err.message);
        process.exit(1);
    }
}

runTest();
