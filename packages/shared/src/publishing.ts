export const publishingScopeNames: Record<string, string> = {
  "server:read": "查看服务器版本和更新状态",
  "server:write": "上传服务器包并安装更新（会重启服务器）",
  "clients:read": "查看客户端安装包和热更新",
  "clients:write": "发布客户端安装包和手机热更新",
};
export type PublishRequest = {
  code: string;
  name: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
  status: string;
};
export type PublishingGrant = {
  credential_type?: "key" | "device";
  id: string;
  name: string;
  username: string;
  scopes: string;
  created_at: number;
  expires_at: number;
  last_used_at: number;
  revoked_at: number | null;
};
export type PublishingAudit = {
  id: string;
  at: number;
  grant_id: string;
  user_id: string;
  action: string;
  target: string;
  outcome: string;
  code: string;
};
export type PublishingInfo = { grants: PublishingGrant[]; audit: PublishingAudit[] };
export type PublishingKey = {
  code: string;
  grantId: string;
  name: string;
  scopes: string[];
  expiresAt: number;
  username: string;
};
