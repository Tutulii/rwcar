import React from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider } from '@privy-io/react-auth';
import App from './AppLive.jsx';
import './styles.css';

const privyAppId = import.meta.env.VITE_PRIVY_APP_ID;

const monadTestnet = {
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://testnet-rpc.monad.xyz'] },
  },
  blockExplorers: {
    default: { name: 'Monadscan', url: 'https://testnet.monadscan.com' },
  },
  testnet: true,
};

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {privyAppId ? (
      <PrivyProvider
        appId={privyAppId}
        config={{
          appearance: {
            theme: '#0B1220',
            accentColor: '#D4AF37',
            loginMessage: 'Secure institutional access to the RWA repo market.',
          },
          supportedChains: [monadTestnet],
          defaultChain: monadTestnet,
          embeddedWallets: {
            ethereum: {
              createOnLogin: 'users-without-wallets',
            },
          },
        }}
      >
        <App />
      </PrivyProvider>
    ) : (
      <div className="configuration-error">
        <strong>Privy configuration missing</strong>
        <span>Add VITE_PRIVY_APP_ID to the project environment.</span>
      </div>
    )}
  </React.StrictMode>,
);
