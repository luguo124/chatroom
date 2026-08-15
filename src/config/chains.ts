// Monad 测试网配置（Chain ID: 10143）
// 文档: https://docs.monad.xyz/developer-essentials

export const MONAD_TESTNET = {
  chainId: '0x279f', // 10143 十六进制
  chainIdNumber: 10143,
  chainName: 'Monad Testnet',
  nativeCurrency: {
    name: 'MON',
    symbol: 'MON',
    decimals: 18,
  },
  rpcUrls: ['https://testnet-rpc.monad.xyz'],
  blockExplorerUrls: ['https://testnet.monadscan.com/'],
} as const;

// Monad 主网配置（MVP 暂不使用，留作参考）
export const MONAD_MAINNET = {
  chainId: '0x8f', // 143 十六进制（143 = 0x8f）
  chainIdNumber: 143,
  chainName: 'Monad',
  nativeCurrency: {
    name: 'MON',
    symbol: 'MON',
    decimals: 18,
  },
  rpcUrls: ['https://rpc.monad.xyz'],
  blockExplorerUrls: ['https://monadscan.com/'],
} as const;
