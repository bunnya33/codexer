export type WeixinStatus = {
  available: boolean;
  bound: boolean;
  botId?: string;
  connected: boolean;
  activated: boolean;
  notifications: boolean;
  replies: boolean;
  lastError: string | null;
  pendingNotifications: number;
};

export type WeixinLogin = {
  loginId: string;
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'need_verifycode' | 'verify_code_blocked';
  qrImage?: string;
  expiresAt: number;
};
