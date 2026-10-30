export declare const DEMO_PORTS: { web: number; api: number; ats: number };
export declare function startDemo(opts?: {
  dataDir?: string;
  headless?: boolean;
  ports?: { web: number; api: number; ats: number };
  quiet?: boolean;
}): Promise<{ url: string; stop: () => Promise<void> }>;
