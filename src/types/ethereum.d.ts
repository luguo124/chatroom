// MetaMask 注入的 window.ethereum 类型定义

export interface EthereumProvider {
  isMetaMask?: boolean;
  isRabby?: boolean;
  isCoinbaseWallet?: boolean;
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  providers?: EthereumProvider[];
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export {};
