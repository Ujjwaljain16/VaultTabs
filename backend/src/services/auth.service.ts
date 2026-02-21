import { IAuthService, RegisterResult, LoginResult } from '../interfaces/auth.service.js';
import { IUserRepository } from '../interfaces/user.repository.js';
import { hashPassword, verifyPassword } from '../crypto/serverCrypto.js';
import { User } from '../interfaces/models.js';

export class AuthService implements IAuthService {
    constructor(
        private userRepository: IUserRepository,
        private jwtSecret: string,
        private jwtSigner: (payload: any, options?: any) => string
    ) { }

    async register(data: Omit<User, 'id' | 'created_at' | 'password_hash'> & { password_plaintext: string }): Promise<RegisterResult> {
        const existing = await this.userRepository.findByEmail(data.email);
        if (existing) {
            throw new Error('Email already registered');
        }

        const passwordHash = await hashPassword(data.password_plaintext);

        let recoveryHashDb = undefined;
        if (data.recovery_key_hash) {
            recoveryHashDb = await hashPassword(data.recovery_key_hash);
        }

        const user = await this.userRepository.create({
            ...data,
            snapshot_retention: 50,
            password_hash: passwordHash,
            // Overwrite the raw hash from the frontend with our scrypt hash
            recovery_key_hash: recoveryHashDb,
        });

        const token = this.jwtSigner({ userId: user.id, email: user.email });

        const { password_hash, ...userResult } = user;
        return { user: userResult, token };
    }

    async login(email: string, password_plaintext: string): Promise<LoginResult> {
        const user = await this.userRepository.findByEmail(email);
        const invalidError = new Error('Invalid credentials');

        if (!user) {
            // Artificial delay is handled in the route for now, or could move here
            throw invalidError;
        }

        const isValid = await verifyPassword(password_plaintext, user.password_hash);
        if (!isValid) {
            throw invalidError;
        }

        const token = this.jwtSigner({ userId: user.id, email: user.email });

        return {
            user: {
                id: user.id,
                email: user.email,
                created_at: user.created_at,
                snapshot_retention: user.snapshot_retention || 50,
            },
            token,
            crypto: {
                encrypted_master_key: user.encrypted_master_key,
                master_key_iv: user.master_key_iv,
                salt: user.salt,
            }
        };
    }

    async getMe(userId: string): Promise<LoginResult> {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new Error('User not found');
        }

        return {
            user: {
                id: user.id,
                email: user.email,
                snapshot_retention: user.snapshot_retention || 50,
                created_at: user.created_at,
            },
            token: '', // Not needed for getMe usually
            crypto: {
                encrypted_master_key: user.encrypted_master_key,
                master_key_iv: user.master_key_iv,
                salt: user.salt,
            }
        };
    }

    async getRecoveryMaterial(email: string): Promise<any> {
        const user = await this.userRepository.findByEmail(email);
        if (!user || !user.recovery_encrypted_master_key) {
            throw new Error('Recovery material not found');
        }

        return {
            email: user.email,
            recovery_encrypted_master_key: user.recovery_encrypted_master_key,
            recovery_key_iv: user.recovery_key_iv,
            recovery_key_salt: user.recovery_key_salt,
            recovery_key_hash: user.recovery_key_hash,
        };
    }
}
