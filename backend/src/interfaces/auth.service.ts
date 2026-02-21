import { User } from './models.js';

export interface RegisterResult {
    user: Omit<User, 'password_hash'>;
    token: string;
}

export interface LoginResult {
    user: Omit<User, 'password_hash' | 'encrypted_master_key' | 'master_key_iv' | 'salt'>;
    token: string;
    crypto: {
        encrypted_master_key: string;
        master_key_iv: string;
        salt: string;
    };
}

export interface IAuthService {
    register(data: Omit<User, 'id' | 'created_at' | 'password_hash'> & { password_plaintext: string }): Promise<RegisterResult>;
    login(email: string, password_plaintext: string): Promise<LoginResult>;
    getMe(userId: string): Promise<LoginResult>;
    getRecoveryMaterial(email: string): Promise<any>;
}
