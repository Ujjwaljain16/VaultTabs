/**
 * Shared API request/response types.
 */

import { User, Device, Snapshot, RestoreRequest } from './models.js';

export interface RegisterPayload {
    email: string;
    password: string;
    encrypted_master_key: string;
    master_key_iv: string;
    salt: string;
    recovery_encrypted_master_key?: string;
    recovery_key_iv?: string;
    recovery_key_salt?: string;
    recovery_key_hash?: string;
}

export interface AuthResponse {
    message: string;
    token: string;
    user: Omit<User, 'password_hash' | 'encrypted_master_key' | 'master_key_iv' | 'salt' | 'snapshot_retention'>;
    crypto?: {
        encrypted_master_key: string;
        master_key_iv: string;
        salt: string;
    };
}

export interface LoginResponse extends AuthResponse { }

export interface DeviceResponse {
    device: Device;
}

export interface SnapshotWithDevice extends Snapshot {
    device_name: string;
    last_seen: string | Date;
}

export interface SnapshotsResponse {
    snapshots: SnapshotWithDevice[];
}

export interface SnapshotResponse {
    snapshot: Snapshot;
}

export interface SnapshotHistoryResponse {
    snapshots: SnapshotWithDevice[];
}

export interface RestoreRequestResponse {
    message: string;
    request_id: string;
    status: string;
    expires_at: string | Date;
}

export interface RestoreStatusResponse {
    request: RestoreRequest;
}

export interface AccountInfoResponse {
    account: {
        id: string;
        email: string;
        snapshot_retention: number;
        has_recovery_key: boolean;
        created_at: string | Date;
    };
    stats: {
        device_count: number;
        snapshot_count: number;
        last_sync_at: string | Date | null;
    };
}

export interface AccountDevice extends Device {
    snapshot_count: number;
    last_snapshot_at: string | Date | null;
}

export interface AccountDevicesResponse {
    devices: AccountDevice[];
}
export interface UploadSnapshotPayload {
    device_id: string;
    captured_at: string | Date;
    iv: string;
    encrypted_blob: string;
}

export interface InitiateRestorePayload {
    target_device_id: string;
    snapshot_id: string;
    target_url?: string;
}

export interface PendingRestoreResponse {
    pending: boolean;
    request?: RestoreRequest & { snapshot_iv: string; encrypted_blob: string };
}

export interface CompleteRestorePayload {
    status: 'completed' | 'failed';
    error_msg?: string;
}
