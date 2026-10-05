export type Principal = {
  kind: "admin" | "user";
  id: string;
  sessionHash?: string;
  expiresAt?: number;
};
