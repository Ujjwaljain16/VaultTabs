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

export interface Checkpoint {
    id: string;
    user_id: string;
    workspace_id: string;
    version: number;
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
    snapshot_id: string; // Keep for legacy / restore flow compatibility
    status: 'pending' | 'completed' | 'failed' | 'expired';
    error_msg?: string;
    created_at: Date | string;
    expires_at: Date | string;
}

export interface Workspace {
    id: string;
    user_id: string;
    name: string;
    description?: string;
    version: number; // Monotonic counter for state reconstruction
    active_checkpoint_id?: string;
    created_at: Date | string;
    updated_at: Date | string;
}

export type OperationType =
    | 'ADD_TAB'
    | 'REMOVE_TAB'
    | 'UPDATE_TAB'
    | 'MOVE_TAB'
    | 'PIN_TAB'
    | 'FOCUS_TAB'
    | 'WINDOW_CREATE'
    | 'WINDOW_REMOVE'
    | 'BATCH_UPDATE';

export interface OpLogEntry {
    id: string; // Unique UUID for idempotency
    user_id: string;
    device_id: string;
    workspace_id: string;
    sequence_id: number; // Monotonic per workspace
    base_version: number; // Version this op was applied on
    operation: OperationType;
    payload_iv: string;
    encrypted_payload: string; // Encrypted tab/window state change
    timestamp: Date | string;
}

export interface TabSnapshot {
    id: number; // Browser internal ID
    stableId: string; // Content-based or persistent ID for better tracking
    url: string;
    title: string;
    favIconUrl?: string;
    windowId: number;
    index: number;
    active: boolean;
    pinned: boolean;
    groupId?: number;
}

