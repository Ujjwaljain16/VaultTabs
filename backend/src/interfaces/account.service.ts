// Interface for account management operations

export interface IAccountService {
    getAccountInfo(userId: string): Promise<any>;
    updateRetention(userId: string, retention: number): Promise<void>;
    deleteAccount(userId: string, passwordPlaintext: string): Promise<void>;
    listDevicesWithStats(userId: string): Promise<any[]>;
}
