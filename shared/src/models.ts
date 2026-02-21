/**
 * Common domain models shared across VaultTabs components.
 */

export interface User {
    id: string;
    email: string;
    password_hash: string;
    encrypted_master_key: string;
    master_key_iv: string;
    salt: string;
    recovery_encrypted_master_key?: string;
    recovery_key_iv?: string;
    recovery_key_salt?: string;
    recovery_key_hash?: string;
    snapshot_retention?: number;
    created_at: Date | string;
}

export interface Device {
    id: string;
    user_id: string;
    device_name: string;
    last_seen: Date | string;
    created_at: Date | string;
}

export interface Snapshot {
    id: string;
    user_id: string;
    device_id: string;
    captured_at: Date | string;
    iv: string;
    encrypted_blob: string;
    created_at: Date | string;
}

export interface RestoreRequest {
    id: string;
    user_id: string;
    source_device_id: string;
    target_device_id: string;
    snapshot_id: string;
    status: 'pending' | 'completed' | 'failed' | 'expired';
    error_msg?: string;
    created_at: Date | string;
    expires_at: Date | string;
}

export interface TabSnapshot {
    id: number;
    url: string;
    title: string;
    favIconUrl?: string;
    windowId: number;
    index: number;
    active: boolean;
    pinned: boolean;
}
