import { useEffect, useState } from 'react';
import { useLogin, usePrivy, useWallets } from '@privy-io/react-auth';

const MONAD_CHAIN_ID = 10143;
const MONAD_RPC_URL = 'https://testnet-rpc.monad.xyz';
const MONAD_EXPLORER_URL = 'https://testnet.monadscan.com';
const CVA_ADMIN_ADDRESS = '0x911F99f424D47F08a15fcC771e94dcc2f7252B02';
const RWRN01_ADDRESS = '0x7A33e03B10268FFdB50e562721B092BC0Cb793F9';
const MINTER_ROLE = '0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6';
const GRANT_ROLE_SELECTOR = '2f2ff15d';
const HAS_ROLE_SELECTOR = '91d14854';
const MINT_SELECTOR = '40c10f19';
const BALANCE_OF_SELECTOR = '70a08231';

const stripHexPrefix = (value) => value.replace(/^0x/, '');
const encodeAddress = (address) => stripHexPrefix(address).toLowerCase().padStart(64, '0');
const encodeUint256 = (value) => BigInt(value).toString(16).padStart(64, '0');

function parseTokenUnits(value, decimals = 6) {
  const normalized = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error('Enter a valid token amount.');
  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) throw new Error(`RWRN01 supports up to ${decimals} decimal places.`);
  return (BigInt(whole) * (10n ** BigInt(decimals))) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals));
}

async function monadCall(data) {
  const response = await fetch(MONAD_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'eth_call',
      params: [{ to: RWRN01_ADDRESS, data }, 'latest'],
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error?.message || 'Monad RPC request failed.');
  return payload.result;
}

async function waitForReceipt(provider, transactionHash) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [transactionHash] });
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error('Transaction reverted on Monad Testnet.');
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('Transaction is still pending. Check Monadscan for confirmation.');
}

const initialOffers = [
  { id: 'RP-2048', asset: 'US Treasury 2028', symbol: 'UST28', amount: 2400000, duration: 14, rate: 5.42, counterparty: 'Northstar Capital', status: 'Open', quality: 'AAA' },
  { id: 'RP-2047', asset: 'Trade Finance Pool I', symbol: 'TFP-I', amount: 850000, duration: 30, rate: 7.18, counterparty: 'Meridian Trade Co.', status: 'Open', quality: 'A' },
  { id: 'RP-2046', asset: 'Green Bond 2030', symbol: 'GB30', amount: 1750000, duration: 7, rate: 4.86, counterparty: 'Axiom Treasury', status: 'Open', quality: 'AA' },
  { id: 'RP-2045', asset: 'Warehouse Receipt Pool', symbol: 'WRP', amount: 620000, duration: 14, rate: 6.75, counterparty: 'Atlas Commodities', status: 'Matched', quality: 'A+' },
  { id: 'RP-2044', asset: 'Invoice Receivables IV', symbol: 'INV-IV', amount: 1100000, duration: 30, rate: 7.62, counterparty: 'Crestline Partners', status: 'Open', quality: 'A' },
];

const positions = [
  { id: 'RP-2039', asset: 'US Treasury 2027', role: 'Buyer', principal: 1850000, rate: 5.21, maturity: '12 Aug 2026', progress: 58, status: 'Active' },
  { id: 'RP-2036', asset: 'Trade Finance Pool II', role: 'Seller', principal: 940000, rate: 6.95, maturity: '19 Aug 2026', progress: 36, status: 'Active' },
  { id: 'RP-2028', asset: 'Green Bond 2029', role: 'Buyer', principal: 720000, rate: 4.74, maturity: '06 Aug 2026', progress: 82, status: 'Maturing' },
];

const completedPositions = [
  { id: 'RP-1994', asset: 'US Treasury 2026', role: 'Buyer', principal: 2100000, rate: 4.98, maturity: '28 Jul 2026', status: 'Settled' },
  { id: 'RP-1972', asset: 'Invoice Receivables II', role: 'Seller', principal: 480000, rate: 7.24, maturity: '14 Jul 2026', status: 'Settled' },
];

const assets = [
  { name: 'US Treasury 2028', symbol: 'UST28', value: '2,400,000', quality: 'AAA' },
  { name: 'Green Bond 2030', symbol: 'GB30', value: '1,750,000', quality: 'AA' },
  { name: 'Trade Finance Pool I', symbol: 'TFP-I', value: '850,000', quality: 'A' },
];

const navigation = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'markets', label: 'Markets', icon: 'markets' },
  { id: 'create', label: 'Create Repo', icon: 'plus' },
  { id: 'portfolio', label: 'Portfolio', icon: 'portfolio' },
];

const money = (value) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
}).format(value);

function Icon({ name, size = 18 }) {
  let content;
  switch (name) {
    case 'dashboard':
      content = <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>;
      break;
    case 'markets':
      content = <><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19H2"/></>;
      break;
    case 'plus':
      content = <><path d="M12 5v14"/><path d="M5 12h14"/></>;
      break;
    case 'portfolio':
      content = <><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 12h18"/></>;
      break;
    case 'wallet':
      content = <><path d="M20 7V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h16v10a2 2 0 0 1-2 2H5a3 3 0 0 1-3-3V6"/><path d="M16 14h2"/></>;
      break;
    case 'shield':
      content = <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></>;
      break;
    case 'trend':
      content = <><path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/></>;
      break;
    case 'clock':
      content = <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>;
      break;
    case 'layers':
      content = <><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></>;
      break;
    case 'search':
      content = <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>;
      break;
    case 'filter':
      content = <><path d="M4 6h16"/><path d="M7 12h10"/><path d="M10 18h4"/></>;
      break;
    case 'arrow':
      content = <><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>;
      break;
    case 'check':
      content = <path d="m5 12 4 4L19 6"/>;
      break;
    case 'file':
      content = <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></>;
      break;
    case 'chevron':
      content = <path d="m9 18 6-6-6-6"/>;
      break;
    case 'external':
      content = <><path d="M15 3h6v6"/><path d="m10 14 11-11"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></>;
      break;
    default:
      content = <circle cx="12" cy="12" r="9"/>;
  }
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{content}</svg>;
}

function Brand({ onClick }) {
  return (
    <button className="brand" onClick={onClick} aria-label="RWCAR home">
      <span className="brand-mark"><span>R</span></span>
      <span className="brand-name">RWCAR</span>
    </button>
  );
}

function VerifiedBadge({ compact = false }) {
  return (
    <span className={`verified-badge ${compact ? 'compact' : ''}`}>
      <span className="verified-dot"><Icon name="check" size={11}/></span>
      {!compact && 'Privy Authenticated'}
    </span>
  );
}

function shortenAddress(address) {
  if (!address) return 'Privy Account';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function WalletControl({ auth }) {
  if (auth.authenticated) {
    return (
      <div className="wallet-connected">
        <VerifiedBadge compact />
        <button className="wallet-address" onClick={auth.logout} title="Log out of Privy">
          <span className="wallet-identicon" />
          {shortenAddress(auth.address)}
        </button>
      </div>
    );
  }
  return <button className="button primary small" disabled={!auth.ready} onClick={auth.login}><Icon name="wallet" size={16}/> {auth.ready ? 'Connect Wallet' : 'Initializing…'}</button>;
}

function PublicHeader({ goTo, auth }) {
  return (
    <header className="public-header">
      <Brand onClick={() => goTo('landing')} />
      <div className="public-actions">
        <span className="network-pill"><i /> Cleanverse</span>
        <WalletControl auth={auth} />
      </div>
    </header>
  );
}

function Landing({ goTo, auth }) {
  return (
    <div className="landing">
      <PublicHeader goTo={goTo} auth={auth}/>
      <main className="hero">
        <div className="hero-glow" />
        <div className="eyebrow"><span /> The compliant liquidity layer for RWAs</div>
        <h1>Institutional RWA<br/><em>Repo Market</em></h1>
        <p>Verified real-world assets. Trusted short-term liquidity.<br className="desktop-break"/> Built for institutions, secured by Cleanverse.</p>
        <div className="hero-actions">
          <button className="button primary hero-button" onClick={() => goTo('dashboard')}>Launch App <Icon name="arrow" size={17}/></button>
          <button className="button secondary hero-button" onClick={() => goTo('markets')}>View Markets</button>
        </div>
        <div className="trust-row" aria-label="Protocol assurances">
          <div><span className="trust-icon"><Icon name="shield"/></span><p><strong>Verified identity</strong><small>Cleanverse CVI</small></p></div>
          <span className="trust-divider" />
          <div><span className="trust-icon"><Icon name="layers"/></span><p><strong>Verified assets</strong><small>Cleanverse CVA</small></p></div>
          <span className="trust-divider" />
          <div><span className="trust-icon"><Icon name="file"/></span><p><strong>Auditable settlement</strong><small>On-chain records</small></p></div>
        </div>
      </main>
      <footer className="landing-footer">
        <span>Institutional infrastructure for the tokenized economy</span>
        <span>Built on <strong>Cleanverse</strong></span>
      </footer>
    </div>
  );
}

function Topbar({ page, goTo, auth }) {
  return (
    <header className="topbar">
      <Brand onClick={() => goTo('landing')} />
      <nav className="topnav" aria-label="Main navigation">
        {navigation.map((item) => (
          <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => goTo(item.id)}>{item.label}</button>
        ))}
      </nav>
      <div className="topbar-actions">
        {auth.authenticated && <VerifiedBadge/>}
        <WalletControl auth={auth}/>
      </div>
    </header>
  );
}

function Sidebar({ page, goTo }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-label">Workspace</div>
      <nav className="side-nav">
        {navigation.map((item) => (
          <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => goTo(item.id)}>
            <Icon name={item.icon}/><span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="compliance-card">
        <span className="compliance-icon"><Icon name="shield" size={19}/></span>
        <div><strong>Compliance active</strong><small>CCP monitoring enabled</small></div>
        <span className="live-dot" />
      </div>
      <div className="sidebar-foot"><span>Network</span><strong><i/> Monad Testnet</strong></div>
    </aside>
  );
}

function PageHeading({ eyebrow, title, description, action }) {
  return (
    <div className="page-heading">
      <div><span className="section-eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div>
      {action}
    </div>
  );
}

function MetricCard({ label, value, note, icon, trend }) {
  return (
    <article className="metric-card">
      <div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon name={icon}/></span></div>
      <strong>{value}</strong>
      <div className="metric-note">{trend && <span className="positive">↗ {trend}</span>} {note}</div>
    </article>
  );
}

function StatusBadge({ status }) {
  return <span className={`status ${status.toLowerCase().replace(' ', '-')}`}><i />{status}</span>;
}

function CvaAdminPanel({ authenticated, login, wallets }) {
  const [hasMinterRole, setHasMinterRole] = useState(false);
  const [balance, setBalance] = useState('0');
  const [mintAmount, setMintAmount] = useState('100');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const adminWallet = wallets.find((wallet) => wallet.address?.toLowerCase() === CVA_ADMIN_ADDRESS.toLowerCase());

  const refresh = async () => {
    try {
      const [roleResult, balanceResult] = await Promise.all([
        monadCall(`0x${HAS_ROLE_SELECTOR}${stripHexPrefix(MINTER_ROLE)}${encodeAddress(CVA_ADMIN_ADDRESS)}`),
        monadCall(`0x${BALANCE_OF_SELECTOR}${encodeAddress(CVA_ADMIN_ADDRESS)}`),
      ]);
      setHasMinterRole(BigInt(roleResult) === 1n);
      const rawBalance = BigInt(balanceResult);
      const whole = rawBalance / 1_000_000n;
      const fraction = (rawBalance % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
      setBalance(fraction ? `${whole}.${fraction}` : whole.toString());
    } catch (refreshError) {
      setError(refreshError.message || 'Unable to read CVA status.');
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const getAdminProvider = async () => {
    setError('');
    setNotice('');
    if (!authenticated) {
      login();
      return null;
    }
    if (!adminWallet) throw new Error(`Connect the Admin wallet ${shortenAddress(CVA_ADMIN_ADDRESS)} to continue.`);
    await adminWallet.switchChain(MONAD_CHAIN_ID);
    return adminWallet.getEthereumProvider();
  };

  const grantMinterRole = async () => {
    setBusy('grant');
    try {
      const provider = await getAdminProvider();
      if (!provider) return;
      const data = `0x${GRANT_ROLE_SELECTOR}${stripHexPrefix(MINTER_ROLE)}${encodeAddress(CVA_ADMIN_ADDRESS)}`;
      const transactionHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: CVA_ADMIN_ADDRESS, to: RWRN01_ADDRESS, data }],
      });
      setNotice('Grant submitted. Waiting for Monad confirmation…');
      await waitForReceipt(provider, transactionHash);
      setNotice('MINTER_ROLE granted successfully.');
      await refresh();
    } catch (grantError) {
      setError(grantError.message || 'MINTER_ROLE grant failed.');
    } finally {
      setBusy('');
    }
  };

  const mint = async () => {
    setBusy('mint');
    try {
      const units = parseTokenUnits(mintAmount);
      if (units <= 0n) throw new Error('Mint amount must be greater than zero.');
      const provider = await getAdminProvider();
      if (!provider) return;
      const data = `0x${MINT_SELECTOR}${encodeAddress(CVA_ADMIN_ADDRESS)}${encodeUint256(units)}`;
      const transactionHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: CVA_ADMIN_ADDRESS, to: RWRN01_ADDRESS, data }],
      });
      setNotice('Mint submitted. Waiting for Monad confirmation…');
      await waitForReceipt(provider, transactionHash);
      setNotice(`${mintAmount} RWRN01 minted to the Admin wallet.`);
      await refresh();
    } catch (mintError) {
      setError(mintError.message || 'CVA mint failed.');
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="card cva-admin-card">
      <div className="cva-admin-heading">
        <div>
          <span className="section-eyebrow">CVA issuance</span>
          <h3>RWCAR Receivable Note I</h3>
          <p><span className="status issued"><i /> ISSUED</span> RWRN01 · Monad Testnet · 6 decimals</p>
        </div>
        <a href={`${MONAD_EXPLORER_URL}/address/${RWRN01_ADDRESS}`} target="_blank" rel="noreferrer" className="button secondary small">View contract <Icon name="external" size={14}/></a>
      </div>
      <div className="cva-admin-grid">
        <div className="cva-stat"><span>Admin wallet</span><strong>{shortenAddress(CVA_ADMIN_ADDRESS)}</strong><small>{adminWallet ? 'Connected through Privy' : 'Connect this wallet to sign'}</small></div>
        <div className="cva-stat"><span>Mint authorization</span><strong className={hasMinterRole ? 'success-text' : 'gold-text'}>{hasMinterRole ? 'MINTER_ROLE active' : 'Grant required'}</strong><small>Verified directly from the CVA contract</small></div>
        <div className="cva-stat"><span>Admin balance</span><strong>{balance} RWRN01</strong><small>Live Monad Testnet balance</small></div>
      </div>
      <div className="cva-actions">
        <button className="button secondary" onClick={grantMinterRole} disabled={busy || hasMinterRole}>{busy === 'grant' ? 'Confirming…' : hasMinterRole ? 'Role Granted' : '1. Grant MINTER_ROLE'}</button>
        <label className="mint-amount"><span>Amount</span><input value={mintAmount} onChange={(event) => setMintAmount(event.target.value)} inputMode="decimal"/><b>RWRN01</b></label>
        <button className="button primary" onClick={mint} disabled={busy || !hasMinterRole}>{busy === 'mint' ? 'Confirming…' : '2. Mint CVA'}</button>
        <button className="icon-button refresh-button" onClick={refresh} disabled={busy} aria-label="Refresh CVA status">↻</button>
      </div>
      {notice && <p className="cva-notice success"><Icon name="check" size={14}/>{notice}</p>}
      {error && <p className="cva-notice error">{error}</p>}
    </section>
  );
}

function Dashboard({ goTo, auth, wallets }) {
  return (
    <div className="page-view">
      <PageHeading
        eyebrow="Overview"
        title="Good morning, Alexander"
        description="Monitor your repo activity and liquidity positions."
        action={<button className="button primary" onClick={() => goTo('create')}><Icon name="plus" size={16}/> Create Repo</button>}
      />
      <section className="metric-grid">
        <MetricCard label="Total Value Locked" value="$28.64M" note="from last month" trend="8.4%" icon="layers"/>
        <MetricCard label="Active Repos" value="24" note="3 mature this week" icon="portfolio"/>
        <MetricCard label="Weighted Avg. Rate" value="5.82%" note="30-day annualized" icon="trend"/>
        <MetricCard label="Available Liquidity" value="$12.40M" note="across verified offers" icon="markets"/>
      </section>
      <CvaAdminPanel authenticated={auth.authenticated} login={auth.login} wallets={wallets}/>
      <section className="content-grid dashboard-grid">
        <div className="card positions-card">
          <div className="card-header"><div><h3>Active repo positions</h3><p>Your current borrowing and lending activity</p></div><button className="text-button" onClick={() => goTo('portfolio')}>View portfolio <Icon name="chevron" size={15}/></button></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Reference / Asset</th><th>Side</th><th>Principal</th><th>Rate</th><th>Maturity</th><th>Status</th></tr></thead>
              <tbody>{positions.map((position) => <tr key={position.id}>
                <td><div className="asset-cell"><span className="asset-monogram">{position.asset.slice(0, 2).toUpperCase()}</span><div><strong>{position.asset}</strong><small>{position.id}</small></div></div></td>
                <td><span className={`side ${position.role.toLowerCase()}`}>{position.role}</span></td>
                <td className="number">{money(position.principal)}</td><td className="number gold-text">{position.rate}%</td><td>{position.maturity}</td><td><StatusBadge status={position.status}/></td>
              </tr>)}</tbody>
            </table>
          </div>
        </div>
        <aside className="card activity-card">
          <div className="card-header"><div><h3>Protocol activity</h3><p>Recent verified events</p></div></div>
          <div className="activity-list">
            <Activity icon="check" title="Settlement completed" meta="RP-2021 · $1.25M" time="8 min"/>
            <Activity icon="shield" title="Compliance approved" meta="RP-2043 · CCP verified" time="26 min"/>
            <Activity icon="markets" title="New offer matched" meta="RP-2040 · 5.68%" time="1 hr"/>
            <Activity icon="file" title="Audit record issued" meta="RP-2018 · Final report" time="3 hr"/>
          </div>
          <div className="audit-link"><span><Icon name="shield" size={16}/> Audit trail synchronized</span><button aria-label="Open audit trail"><Icon name="external" size={14}/></button></div>
        </aside>
      </section>
    </div>
  );
}

function Activity({ icon, title, meta, time }) {
  return <div className="activity-item"><span className="activity-symbol"><Icon name={icon} size={15}/></span><div><strong>{title}</strong><small>{meta}</small></div><time>{time}</time></div>;
}

function Markets({ offers, accepted, onAccept }) {
  const [search, setSearch] = useState('');
  const [duration, setDuration] = useState('All durations');
  const filtered = offers.filter((offer) => {
    const matchesSearch = `${offer.asset} ${offer.symbol} ${offer.counterparty}`.toLowerCase().includes(search.toLowerCase());
    const matchesDuration = duration === 'All durations' || offer.duration === Number(duration.split(' ')[0]);
    return matchesSearch && matchesDuration;
  });
  return (
    <div className="page-view">
      <PageHeading eyebrow="Primary market" title="Repo Markets" description="Discover institutional repo opportunities backed by verified real-world assets." action={<div className="market-summary"><span><i/> Market open</span><strong>$12.4M available</strong></div>}/>
      <div className="card markets-card">
        <div className="market-tools">
          <label className="search-box"><Icon name="search" size={17}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by asset or counterparty"/></label>
          <div className="filters">
            <label className="select-wrap"><Icon name="clock" size={15}/><select value={duration} onChange={(e) => setDuration(e.target.value)}><option>All durations</option><option>7 days</option><option>14 days</option><option>30 days</option></select></label>
            <label className="select-wrap"><Icon name="filter" size={15}/><select defaultValue="All ratings"><option>All ratings</option><option>AAA</option><option>AA</option><option>A</option></select></label>
          </div>
        </div>
        <div className="results-meta"><span>{filtered.length} verified offers</span><span>Rates annualized · Values in USDC</span></div>
        <div className="table-wrap market-table">
          <table>
            <thead><tr><th>Verified Asset</th><th>Amount</th><th>Duration</th><th>Repo Rate</th><th>Counterparty</th><th>Status</th><th></th></tr></thead>
            <tbody>{filtered.map((offer) => {
              const isAccepted = accepted.includes(offer.id);
              return <tr key={offer.id}>
                <td><div className="asset-cell"><span className="asset-monogram large">{offer.symbol.slice(0, 2)}</span><div><strong>{offer.asset} <span className="inline-check">✓</span></strong><small>{offer.symbol} · {offer.quality} rated</small></div></div></td>
                <td className="number">{money(offer.amount)}</td><td>{offer.duration} days</td><td className="rate-cell">{offer.rate.toFixed(2)}%</td>
                <td><div className="counterparty"><strong>{offer.counterparty}</strong><small><span>✓</span> CVI verified</small></div></td>
                <td><StatusBadge status={isAccepted ? 'Matched' : offer.status}/></td>
                <td><button className={`table-action ${isAccepted || offer.status === 'Matched' ? 'disabled' : ''}`} disabled={isAccepted || offer.status === 'Matched'} onClick={() => onAccept(offer)}>{isAccepted || offer.status === 'Matched' ? 'Matched' : 'Review'}</button></td>
              </tr>;
            })}</tbody>
          </table>
          {!filtered.length && <div className="empty-state"><Icon name="search" size={24}/><strong>No matching offers</strong><p>Try adjusting your search or filters.</p></div>}
        </div>
      </div>
      <div className="compliance-strip"><span className="compliance-strip-icon"><Icon name="shield" size={18}/></span><div><strong>Every offer is verified before listing</strong><p>Cleanverse validates identity, asset provenance, and transaction compliance before a trade can proceed.</p></div><span className="strip-tags"><b>CVI</b><b>CVA</b><b>CCP</b></span></div>
    </div>
  );
}

function CreateRepo({ onCreate }) {
  const [assetIndex, setAssetIndex] = useState(0);
  const [amount, setAmount] = useState('1,000,000');
  const [duration, setDuration] = useState(14);
  const [rate, setRate] = useState('5.75');
  const selected = assets[assetIndex];
  const cleanAmount = Number(amount.replace(/,/g, '')) || 0;
  const interest = cleanAmount * (Number(rate) / 100) * (duration / 365);

  const submit = (event) => {
    event.preventDefault();
    onCreate({
      id: `RP-${2050 + Math.floor(Math.random() * 40)}`,
      asset: selected.name,
      symbol: selected.symbol,
      amount: cleanAmount,
      duration,
      rate: Number(rate),
      counterparty: 'Your Institution',
      status: 'Open',
      quality: selected.quality,
    });
  };

  return (
    <div className="page-view create-view">
      <PageHeading eyebrow="New transaction" title="Create Repo Offer" description="Raise short-term liquidity against a verified tokenized asset."/>
      <form className="create-grid" onSubmit={submit}>
        <section className="card form-card">
          <div className="form-section-title"><span>01</span><div><h3>Transaction details</h3><p>Define the asset and commercial terms.</p></div></div>
          <div className="field">
            <label htmlFor="asset">Tokenized asset</label>
            <div className="custom-select"><span className="asset-monogram large">{selected.symbol.slice(0, 2)}</span><select id="asset" value={assetIndex} onChange={(e) => setAssetIndex(Number(e.target.value))}>{assets.map((asset, index) => <option key={asset.symbol} value={index}>{asset.name} ({asset.symbol})</option>)}</select><span className="select-verified"><Icon name="check" size={12}/> CVA</span></div>
            <div className="asset-balance"><span>Available collateral</span><strong>${selected.value} USDC</strong></div>
          </div>
          <div className="field-row">
            <div className="field"><label htmlFor="amount">Principal amount</label><div className="input-affix"><span>$</span><input id="amount" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9,]/g, ''))}/><b>USDC</b></div></div>
            <div className="field"><label htmlFor="rate">Desired repo rate</label><div className="input-affix"><input id="rate" type="number" step="0.01" min="0" value={rate} onChange={(e) => setRate(e.target.value)}/><b>% APR</b></div><small className="field-hint">Market avg. 5.82%</small></div>
          </div>
          <div className="field"><label>Repo duration</label><div className="duration-picker">{[7, 14, 30].map((days) => <button type="button" key={days} className={duration === days ? 'active' : ''} onClick={() => setDuration(days)}><strong>{days}</strong><span>days</span></button>)}</div></div>
          <div className="settlement-summary"><div><span>Repurchase amount</span><strong>{money(cleanAmount + interest)}</strong></div><div><span>Estimated interest</span><strong className="gold-text">{money(interest)}</strong></div><div><span>Protocol fee</span><strong>{money(cleanAmount * 0.0015)}</strong></div></div>
        </section>
        <aside className="create-aside">
          <section className="card verification-panel">
            <div className="panel-heading"><span className="shield-large"><Icon name="shield" size={22}/></span><div><h3>Verification status</h3><p>Powered by Cleanverse</p></div></div>
            <div className="verification-list">
              <VerificationItem title="Identity verified" detail="CVI · Institutional Tier" tag="CVI"/>
              <VerificationItem title="Asset verified" detail={`${selected.symbol} · ${selected.quality} rated`} tag="CVA"/>
              <VerificationItem title="Compliance passed" detail="Travel Rule · AML screening" tag="CCP"/>
            </div>
            <div className="all-clear"><span><Icon name="check" size={14}/></span><p><strong>All checks passed</strong><small>Eligible to create this offer</small></p></div>
          </section>
          <section className="card execution-panel">
            <h3>Execution summary</h3>
            <dl><div><dt>Asset</dt><dd>{selected.symbol}</dd></div><div><dt>Principal</dt><dd>{money(cleanAmount)}</dd></div><div><dt>Term</dt><dd>{duration} days</dd></div><div><dt>Repo rate</dt><dd>{Number(rate || 0).toFixed(2)}%</dd></div></dl>
            <button type="submit" className="button primary full" disabled={!cleanAmount || !Number(rate)}>Create Offer <Icon name="arrow" size={17}/></button>
            <p className="legal-note"><Icon name="shield" size={13}/> Submission triggers final CCP validation.</p>
          </section>
        </aside>
      </form>
    </div>
  );
}

function VerificationItem({ title, detail, tag }) {
  return <div className="verification-item"><span className="check-circle"><Icon name="check" size={13}/></span><div><strong>{title}</strong><small>{detail}</small></div><b>{tag}</b></div>;
}

function Portfolio() {
  const [tab, setTab] = useState('Active');
  const rows = tab === 'Active' ? positions : completedPositions;
  return (
    <div className="page-view">
      <PageHeading eyebrow="Positions" title="Institutional Portfolio" description="Monitor collateral, exposure, and settlement activity across your repo book." action={<button className="button secondary"><Icon name="file" size={16}/> Export report</button>}/>
      <section className="metric-grid portfolio-metrics">
        <MetricCard label="Gross Exposure" value="$3.51M" note="across 3 active positions" icon="layers"/>
        <MetricCard label="Collateral Value" value="$3.88M" note="110.5% coverage ratio" icon="shield"/>
        <MetricCard label="Accrued Yield" value="$8,426" note="current settlement cycle" icon="trend"/>
        <MetricCard label="Next Maturity" value="3 days" note="RP-2028 · $720K" icon="clock"/>
      </section>
      <section className="card portfolio-card">
        <div className="portfolio-tabs"><div>{['Active', 'Settled'].map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item} positions <span>{item === 'Active' ? 3 : 2}</span></button>)}</div><span>Last synchronized 2 min ago</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Position</th><th>Side</th><th>Principal</th><th>Rate</th><th>Maturity</th>{tab === 'Active' && <th>Term progress</th>}<th>Status</th><th></th></tr></thead>
            <tbody>{rows.map((position) => <tr key={position.id}>
              <td><div className="asset-cell"><span className="asset-monogram">{position.asset.slice(0,2).toUpperCase()}</span><div><strong>{position.asset}</strong><small>{position.id}</small></div></div></td>
              <td><span className={`side ${position.role.toLowerCase()}`}>{position.role}</span></td><td className="number">{money(position.principal)}</td><td className="number gold-text">{position.rate}%</td><td>{position.maturity}</td>
              {tab === 'Active' && <td><div className="progress-cell"><div><span style={{width: `${position.progress}%`}}/></div><small>{position.progress}%</small></div></td>}
              <td><StatusBadge status={position.status}/></td><td><button className="icon-button" aria-label={`View ${position.id}`}><Icon name="chevron" size={15}/></button></td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>
      <div className="portfolio-footnote"><Icon name="shield" size={15}/><span>Position data is reconciled with Clean Payment Rails and the Cleanverse Audit Trail.</span><button>View audit log <Icon name="external" size={13}/></button></div>
    </div>
  );
}

function Toast({ message, onClose }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 3800);
    return () => clearTimeout(timer);
  }, [onClose]);
  return <div className="toast"><span><Icon name="check" size={14}/></span><div><strong>Transaction updated</strong><p>{message}</p></div><button onClick={onClose}>×</button></div>;
}

function App() {
  const { ready, authenticated, user, logout } = usePrivy();
  const { login } = useLogin();
  const { wallets } = useWallets();
  const validPages = ['landing', ...navigation.map((item) => item.id)];
  const initialPage = window.location.hash.replace('#/', '') || 'landing';
  const [page, setPage] = useState(validPages.includes(initialPage) ? initialPage : 'landing');
  const [offers, setOffers] = useState(initialOffers);
  const [accepted, setAccepted] = useState([]);
  const [toast, setToast] = useState('');

  const linkedWallet = user?.linkedAccounts?.find((account) => account.type === 'wallet' || account.type === 'smart_wallet');
  const address = wallets[0]?.address || user?.wallet?.address || linkedWallet?.address || '';
  const auth = { ready, authenticated, address, login, logout };

  const goTo = (next) => {
    setPage(next);
    window.location.hash = `/${next}`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    const update = () => {
      const next = window.location.hash.replace('#/', '') || 'landing';
      if (validPages.includes(next)) setPage(next);
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  const acceptOffer = (offer) => {
    if (!authenticated) {
      login();
      return;
    }
    setAccepted((current) => [...current, offer.id]);
    setToast(`${offer.id} has passed pre-trade checks and is ready for settlement.`);
  };

  const createOffer = (offer) => {
    if (!authenticated) {
      login();
      return;
    }
    setOffers((current) => [offer, ...current]);
    setToast(`${offer.id} is now live in the verified repo market.`);
    goTo('markets');
  };

  let currentView = <Portfolio/>;
  if (page === 'dashboard') currentView = <Dashboard goTo={goTo} auth={auth} wallets={wallets}/>;
  if (page === 'markets') currentView = <Markets offers={offers} accepted={accepted} onAccept={acceptOffer}/>;
  if (page === 'create') currentView = <CreateRepo onCreate={createOffer}/>;

  if (page === 'landing') return <Landing goTo={goTo} auth={auth}/>;

  return (
    <div className="app-shell">
      <Topbar page={page} goTo={goTo} auth={auth}/>
      <Sidebar page={page} goTo={goTo}/>
      <main className="main-content">{currentView}</main>
      {toast && <Toast message={toast} onClose={() => setToast('')}/>} 
    </div>
  );
}

export default App;
