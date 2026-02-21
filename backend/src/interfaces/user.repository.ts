import { User } from './models.js';

export interface IUserRepository {
    findByEmail(email: string): Promise<User | undefined>;
    findById(id: string): Promise<User | undefined>;
    create(user: Omit<User, 'id' | 'created_at'>): Promise<User>;
    updateRetention(id: string, retention: number): Promise<void>;
    delete(id: string): Promise<void>;
    getStats(id: string): Promise<any>;
    updateSecurityParams(email: string, params: {
        password_hash: string;
        encrypted_master_key: string;
        master_key_iv: string;
        salt: string;
    }): Promise<void>;
}
