import hardhatNodeTestRunner from '@nomicfoundation/hardhat-node-test-runner';
import hardhatViem from '@nomicfoundation/hardhat-viem';
import hardhatViemAssertions from '@nomicfoundation/hardhat-viem-assertions';
import { defineConfig } from 'hardhat/config';

export default defineConfig({
  plugins: [hardhatNodeTestRunner, hardhatViem, hardhatViemAssertions],
  solidity: {
    profiles: {
      default: {
        version: '0.8.24',
      },
      production: {
        version: '0.8.24',
        settings: {
          optimizer: { enabled: true, runs: 500 },
          viaIR: true,
        },
      },
    },
  },
});
