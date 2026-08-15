/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_TURN_USERNAME: string;
  readonly VITE_TURN_CREDENTIAL: string;
  readonly VITE_MONAD_RPC_URL: string;
  readonly VITE_CONTRACT_ADDRESS: string;
  readonly VITE_ALCHEMY_BUNDLER_URL: string;
  readonly VITE_ALCHEMY_PAYMASTER_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
