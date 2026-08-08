import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLogin, usePrivy, useWallets } from '@privy-io/react-auth';
import { apiRequest } from './lib/api.js';
import { TRUSTED_V2_MANIFEST } from './config/trusted-v2-manifest.js';
import {
  MONAD_CHAIN_ID,
  ZERO_ADDRESS,
  encodeAcceptOwnership,
  encodeApproval,
  encodeMarketCall,
  formatUnits,
  parseUnits,
  readRuntimeCodeHash,
  readOwnership,
  readRepoState,
  readTransactionStatus,
  sendTransaction,
} from './lib/chain.js';
import {
  assertV2Instruction as assertTrustedV2Instruction,
  compareApiConfigToManifest,
  isNonZeroAddress,
  pinTrustedV2Config,
  validateApprovalInstructions,
  verifyManifestRuntimeCode,
} from './lib/v2-security.js';
import {
  pendingForWallet,
  pendingRecordId,
  removePendingExecution,
  upsertPendingExecution,
} from './lib/v2-pending.js';
import {
  AuctionsPage,
  ExecutionStatus,
  MarginPage,
  ProtocolSwitch,
  V2CreateOffer,
  V2Markets,
  V2Portfolio,
  V2Unavailable,
  VaultPage,
} from './V2Protocol.jsx';

const DEPLOYED_CONTRACTS = {
  assetRegistry: '0x38a859695c32eea74b51c0f098039e15e616d5d6',
  repoMarket: '0x90535a7176a3b2c251c834b28e11e245622ee808',
};
const OFFER_VALIDITY_SECONDS = 60 * 60;

function requireFreshV2Quote(result) {
  const expiresAt = Date.parse(result?.quote?.expiresAt || '');
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    const error = new Error('The institutional quote expired before signature. Run preflight again.');
    error.code = 'QUOTE_EXPIRED';
    error.correlationId = result?.correlationId;
    throw error;
  }
}

const navigation = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'markets', label: 'Markets', icon: 'markets' },
  { id: 'create', label: 'Create Repo', icon: 'plus' },
  { id: 'portfolio', label: 'Portfolio', icon: 'portfolio' },
  { id: 'vault', label: 'Vault', icon: 'vault', version: 'V2' },
  { id: 'auctions', label: 'Auctions', icon: 'auction', version: 'V2' },
  { id: 'margin', label: 'Margin', icon: 'margin', version: 'V2' },
];

function Icon({ name, size = 18 }) {
  const paths = {
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    markets: <><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    portfolio: <><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18"/></>,
    wallet: <><path d="M20 7V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h16v10a2 2 0 0 1-2 2H5a3 3 0 0 1-3-3V6"/><path d="M16 14h2"/></>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3"/><path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5"/></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    layers: <><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5m-18 5 9 5 9-5"/></>,
    trend: <path d="m3 17 6-6 4 4 8-8m-6 0h6v6"/>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></>,
    vault: <><path d="M3 7h18v14H3z"/><path d="M7 7V4h10v3M8 13h8M12 10v6"/></>,
    auction: <><path d="m14 4 6 6M11 7l6 6M4 20l8-8M3 21h7"/></>,
    margin: <><path d="M4 19V5M4 19h16M8 15l3-4 3 2 5-7"/><path d="M17 6h2v2"/></>,
    x: <path d="M18 6 6 18M6 6l12 12"/>,
  };
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name] || <circle cx="12" cy="12" r="9"/>}</svg>;
}

const short = (value) => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : 'No wallet';
const statusLabels = { REPAID: 'Settled', DEFAULTED: 'Defaulted', CANCELLED: 'Cancelled', EXPIRED: 'Expired', EXPIRY_PENDING: 'Expiry pending', ACTIVE: 'Active', OPEN: 'Open' };
const titleStatus = (status) => statusLabels[status] || (status ? status[0] + status.slice(1).toLowerCase() : 'Unknown');
const effectiveRepoStatus = (row, now = Date.now()) => row.status === 'OPEN' && row.offerExpiry && new Date(row.offerExpiry).getTime() <= now ? 'EXPIRY_PENDING' : row.status;
const dateTime = (value) => value ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const activityTime = (value) => {
  if (!value) return '—';
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed >= 0 && elapsed < 60_000) return 'Now';
  if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed >= 0 && elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed >= 0 && elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d`;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(value));
};
const durationLabel = (seconds) => {
  const value = Number(seconds);
  if (value < 3600) return `${Math.round(value / 60)} min`;
  if (value < 86400) return `${Math.round(value / 3600)} hr`;
  return `${Math.round(value / 86400)} days`;
};

function Brand({ go }) {
  return <button className="brand" onClick={() => go('landing')}><span className="brand-mark"><span>R</span></span><span className="brand-name">RWCAR</span></button>;
}

function WalletControl({ auth, compliance, complianceState }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    if (!detailsOpen) return undefined;
    const close = (event) => { if (event.key === 'Escape') setDetailsOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [detailsOpen]);
  if (!auth.authenticated) return <button className="button primary small" disabled={!auth.ready} onClick={auth.login}><Icon name="wallet" size={16}/>{auth.ready ? 'Connect Wallet' : 'Initializing…'}</button>;
  const cviVerified = Boolean(compliance?.cviActive && (
    compliance?.verificationCode === 4
      || (compliance?.eligibilitySource === 'ONCHAIN_POLICY_POOL' && compliance?.poolEligible === true)
  ));
  const apassActive = Boolean(compliance?.cviActive && compliance?.apassStatus === 1);
  const pending = complianceState === 'loading' || complianceState === 'idle';
  const unavailable = complianceState === 'error';
  const cviTone = pending ? 'pending' : unavailable ? 'unavailable' : cviVerified ? 'verified' : 'required';
  const apassTone = pending ? 'pending' : unavailable ? 'unavailable' : apassActive ? 'active' : 'required';
  const expiry = unavailable ? 'Unavailable' : compliance?.apassExpiresAt ? dateTime(compliance.apassExpiresAt) : 'Not reported';
  return <>
    <div className="wallet-connected">
      <span className="wallet-address" title={auth.address}><span className="wallet-identicon"/><span className="wallet-address-text">{short(auth.address)}</span></span>
      <button type="button" className={`identity-badge ${cviTone}`} onClick={() => setDetailsOpen(true)}>
        <Icon name={cviVerified ? 'check' : 'shield'} size={12}/><span className="badge-full">{pending ? 'CVI Checking' : unavailable ? 'CVI Unavailable' : cviVerified ? 'CVI Verified' : 'CVI Required'}</span><span className="badge-short">{cviVerified ? 'CVI ✓' : 'CVI'}</span>
      </button>
      <button type="button" className={`identity-badge apass ${apassTone}`} onClick={() => setDetailsOpen(true)}>
        <span className="identity-pulse"/><span className="badge-full">{pending ? 'A-Pass Checking' : unavailable ? 'A-Pass Unavailable' : apassActive ? 'A-Pass Active' : 'A-Pass Inactive'}</span><span className="badge-short">{apassActive ? 'A-Pass ✓' : 'A-Pass'}</span>
      </button>
      <button type="button" className="wallet-disconnect" onClick={auth.logout} aria-label="Disconnect wallet" title="Disconnect wallet"><Icon name="logout" size={14}/><span>Disconnect</span></button>
    </div>
    {detailsOpen && <div className="identity-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetailsOpen(false); }}>
      <section className="identity-modal" role="dialog" aria-modal="true" aria-labelledby="identity-title">
        <div className="identity-modal-head"><div><span className="section-eyebrow">Cleanverse identity</span><h3 id="identity-title">CVI & A-Pass Details</h3></div><button type="button" onClick={() => setDetailsOpen(false)} aria-label="Close identity details"><Icon name="x"/></button></div>
        <div className="identity-summary"><span className={`identity-seal ${cviVerified ? 'verified' : ''}`}><Icon name="shield" size={23}/></span><div><strong>{unavailable ? 'Verification service unavailable' : cviVerified ? 'Cleanverse Verified Identity' : pending ? 'Verification in progress' : 'CVI verification required'}</strong><small>{short(auth.address)} · Monad Testnet</small></div></div>
        <dl className="identity-details">
          <div><dt>A-Pass status</dt><dd className={apassActive ? 'success-text' : ''}>{unavailable ? 'Unavailable' : apassActive ? 'Active' : pending ? 'Checking' : 'Inactive'}</dd></div>
          <div><dt>Identity tier</dt><dd>{compliance?.tier ?? '—'}{compliance?.subTier !== null && compliance?.subTier !== undefined ? ` / ${compliance.subTier}` : ''}</dd></div>
          <div><dt>Jurisdiction</dt><dd>{compliance?.countries?.join(', ') || 'Not reported'}</dd></div>
          <div><dt>Expires</dt><dd>{expiry}</dd></div>
          <div><dt>Pool eligibility</dt><dd className={compliance?.poolEligible ? 'success-text' : ''}>{unavailable ? 'Unavailable' : compliance?.poolEligible === true ? 'Eligible' : compliance?.poolEligible === false ? 'Not eligible' : 'Checking'}</dd></div>
          <div><dt>Verification code</dt><dd>{unavailable ? 'Unavailable' : compliance?.verificationCode ?? '—'}{!unavailable && cviVerified ? compliance?.eligibilitySource === 'ONCHAIN_POLICY_POOL' ? ' · On-chain policy eligible' : ' · Transfer allowed' : ''}</dd></div>
        </dl>
        <div className="identity-modal-foot"><Icon name="check" size={13}/><span>Live result checked {compliance?.checkedAt ? dateTime(compliance.checkedAt) : 'when wallet verification completes'}</span></div>
      </section>
    </div>}
  </>;
}

function Header({ page, go, auth, compliance, complianceState }) {
  return <header className="topbar"><Brand go={go}/><nav className="topnav">{navigation.map((item) => <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => go(item.id)}>{item.label}{item.version && <sup>{item.version}</sup>}</button>)}</nav><WalletControl auth={auth} compliance={compliance} complianceState={complianceState}/></header>;
}

function Sidebar({ page, go, configured, v2State }) {
  return <aside className="sidebar"><div className="sidebar-label">Workspace</div><nav className="side-nav">{navigation.map((item) => <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => go(item.id)}><Icon name={item.icon}/><span>{item.label}</span>{item.version && <b className={v2State === 'ready' ? 'ready' : ''}>{item.version}</b>}</button>)}</nav><div className="compliance-card"><span className="compliance-icon"><Icon name="shield"/></span><div><strong>{configured ? 'Protocol connected' : 'Deployment pending'}</strong><small>Monad Testnet · Cleanverse UAT</small></div></div><div className="sidebar-foot"><span>Network</span><strong><i/> Monad Testnet</strong></div></aside>;
}

function Heading({ eyebrow, title, description, action }) {
  return <div className="page-heading"><div><span className="section-eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div>{action}</div>;
}

function Metric({ label, value, note, icon }) {
  return <article className="metric-card"><div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon name={icon}/></span></div><strong>{value}</strong><div className="metric-note">{note}</div></article>;
}

function Status({ value }) {
  return <span className={`status ${String(value).toLowerCase()}`}><i/>{titleStatus(value)}</span>;
}

function CvaBadge({ asset, compact = false }) {
  const issued = Boolean(asset && asset.cleanverseStatus === 'ISSUED' && !asset.paused);
  return <span className={`cva-badge ${issued ? 'issued' : 'unverified'} ${compact ? 'compact' : ''}`}><Icon name={issued ? 'check' : 'shield'} size={11}/>{issued ? (compact ? 'CVA · Issued' : 'Cleanverse Verified Asset') : 'CVA Unverified'}</span>;
}

function Empty({ text, detail = 'Only confirmed, indexed Monad transactions appear here.' }) {
  return <div className="empty-state"><Icon name="file" size={24}/><strong>{text}</strong><p>{detail}</p></div>;
}

function MetricSkeletons() {
  return <section className="metric-grid" aria-label="Loading metrics">{Array.from({ length: 4 }, (_, index) => <article className="metric-card skeleton-card" key={index}><span className="skeleton line short"/><span className="skeleton value"/><span className="skeleton line"/></article>)}</section>;
}

function TableSkeleton({ rows = 3 }) {
  return <div className="table-skeleton" aria-label="Loading confirmed transactions">{Array.from({ length: rows }, (_, index) => <div key={index}><span className="skeleton avatar"/><span className="skeleton line"/><span className="skeleton line short"/><span className="skeleton pill"/></div>)}</div>;
}

function Landing({ go, auth, compliance, complianceState }) {
  return <div className="landing"><header className="public-header"><Brand go={go}/><div className="public-actions"><span className="network-pill"><i/> Cleanverse UAT</span><WalletControl auth={auth} compliance={compliance} complianceState={complianceState}/></div></header><main className="hero"><div className="eyebrow"><span/>The compliant liquidity layer for RWAs</div><h1>Institutional RWA<br/><em>Repo Market</em></h1><p>Verified real-world assets. Trusted short-term liquidity.<br/>Built on Monad with Cleanverse compliance.</p><div className="hero-actions"><button className="button primary hero-button" onClick={() => go('dashboard')}>Launch App <Icon name="arrow"/></button><button className="button secondary hero-button" onClick={() => go('markets')}>View Markets</button></div><div className="trust-row"><div><span className="trust-icon"><Icon name="shield"/></span><p><strong>Verified identity</strong><small>Cleanverse CVI</small></p></div><span className="trust-divider"/><div><span className="trust-icon"><Icon name="layers"/></span><p><strong>Verified assets</strong><small>Cleanverse CVA</small></p></div><span className="trust-divider"/><div><span className="trust-icon"><Icon name="file"/></span><p><strong>Atomic settlement</strong><small>Monad Testnet</small></p></div></div></main></div>;
}

function activityCopy(event) {
  const symbol = event.assetSymbol || 'CVA';
  if (event.eventName === 'RepoRepaid') return { title: `Repo #${event.repoId} settled atomically`, detail: `${symbol} · ${formatUnits(event.repurchaseAmount || event.principalAmount)} aUSDC repurchased`, icon: 'check', tone: 'repaid' };
  if (event.eventName === 'RepoDefaulted') return { title: `Repo #${event.repoId} default recorded`, detail: `${symbol} collateral finalized to the buyer`, icon: 'shield', tone: 'defaulted' };
  if (event.eventName === 'OfferCancelled') return { title: `Repo #${event.repoId} offer cancelled`, detail: `${symbol} collateral released`, icon: 'x', tone: 'cancelled' };
  if (event.eventName === 'OfferExpired') return { title: `Repo #${event.repoId} offer expired`, detail: `${symbol} · Unfilled collateral released`, icon: 'clock', tone: 'cancelled' };
  if (event.eventName === 'OfferAccepted') return { title: `Offer accepted by ${short(event.buyer)}`, detail: `Repo #${event.repoId} · ${symbol} · Atomic DvP`, icon: 'arrow', tone: 'active' };
  return { title: `Repo #${event.repoId} created`, detail: `${symbol} · ${formatUnits(event.principalAmount)} aUSDC requested`, icon: 'plus', tone: 'open' };
}

function Dashboard({ go, positions, offers, activity, address, assets, loading, activityLoading, v2Ready = false, v2Portfolio, v2Offers = [], v2Assets = [], settlement }) {
  const uniqueV2Positions = [...new Map([...(v2Portfolio?.sellerPositions || []), ...(v2Portfolio?.lenderPositions || [])].map((row) => [String(row.positionId), row])).values()];
  const bookPositions = v2Ready ? uniqueV2Positions : positions;
  const bookOffers = v2Ready ? v2Offers : offers;
  const bookAssets = v2Ready ? v2Assets : assets;
  const active = bookPositions.filter((row) => ['ACTIVE', 'DEFAULT_ELIGIBLE'].includes(row.status));
  const principalOf = (row) => BigInt(row.principalAmount ?? row.principal ?? row.targetPrincipal ?? 0);
  const exposure = active.reduce((sum, row) => sum + principalOf(row), 0n);
  const rateBasis = active.length ? active : bookOffers;
  const ratePrincipal = rateBasis.reduce((sum, row) => sum + principalOf(row), 0n);
  const weightedBps = ratePrincipal > 0n ? rateBasis.reduce((sum, row) => sum + principalOf(row) * BigInt(row.annualRateBps ?? row.repoRateBps ?? row.rateBps ?? 0), 0n) / ratePrincipal : null;
  const v2Activity = [...(v2Portfolio?.sellerOffers || []), ...uniqueV2Positions, ...(v2Portfolio?.history || [])]
    .sort((left, right) => new Date(right.updatedAt || right.observedAt || right.createdAt || 0) - new Date(left.updatedAt || left.observedAt || left.createdAt || 0))
    .slice(0, 4)
    .map((row) => {
      const isOffer = row.positionId == null;
      const resource = isOffer ? `Offer #${row.offerId}` : `Position #${row.positionId}`;
      return { key: `${isOffer ? 'offer' : 'position'}:${row.offerId || row.positionId}:${row.status}`, title: `${resource} · ${titleStatus(row.status)}`, detail: `${short(row.assetAddress)} · ${v2Ready ? 'Vault-settled V2' : 'Direct DvP'}`, icon: ['REPAID', 'LIQUIDATED'].includes(row.status) ? 'check' : isOffer ? 'plus' : 'layers', tone: String(row.status || '').toLowerCase(), observedAt: row.updatedAt || row.observedAt || row.createdAt };
    });
  const recent = v2Ready ? v2Activity : activity.slice(0, 4).map((event) => ({ ...activityCopy(event), key: `${event.txHash}:${event.logIndex}`, observedAt: event.observedAt }));
  const dashboardRows = active.map((row) => v2Ready ? {
    ...row,
    repoId: `V2-${row.positionId}`,
    principalAmount: String(row.principalAmount ?? row.principal ?? 0),
    buyer: row.buyer || row.lender,
  } : row);
  const symbol = v2Ready ? (settlement?.symbol || 'aUSDC') : 'aUSDC';
  const decimals = v2Ready ? Number(settlement?.decimals ?? 6) : 6;
  return <div className="page-view"><Heading eyebrow="Live protocol" title="RWCAR Dashboard" description={v2Ready ? 'Finalized Vault Market V2 positions, partial-fill offers and custody activity.' : 'Finalized data from the RepoMarketV1 event projection.'} action={<button className="button primary" onClick={() => go('create')}><Icon name="plus"/>Create Repo</button>}/>{loading ? <MetricSkeletons/> : <section className="metric-grid"><Metric label="Active Exposure" value={address ? `${formatUnits(exposure, decimals)} ${symbol}` : '—'} note="Gross outstanding principal" icon="layers"/><Metric label="Active Repos" value={address ? String(active.length) : '—'} note="Connected wallet" icon="portfolio"/><Metric label="Open Offers" value={String(bookOffers.length)} note={v2Ready ? 'Partial-fill marketplace' : 'Verified marketplace'} icon="markets"/><Metric label="Weighted Avg. Rate" value={weightedBps === null ? '—' : `${(Number(weightedBps) / 100).toFixed(2)}%`} note={active.length ? 'Principal-weighted exposure' : 'Principal-weighted market'} icon="trend"/></section>}<section className="content-grid dashboard-grid"><section className="card positions-card"><div className="card-header"><div><h3>Active repo positions</h3><p>{address ? `Wallet ${short(address)} · ${v2Ready ? 'V2' : 'V1'}` : 'Connect a wallet to load positions'}</p></div></div>{loading ? <TableSkeleton/> : dashboardRows.length ? <RepoTable rows={dashboardRows} address={address} assets={bookAssets}/> : <Empty text="No active repos yet" detail={address ? 'New active positions will appear after a verified offer is accepted.' : 'Connect a wallet to load your institutional positions.'}/>}</section><section className="card activity-card"><div className="card-header"><div><h3>Recent Activity</h3><p>{address ? `Latest finalized ${v2Ready ? 'V2 book changes' : 'actions for this wallet'}` : 'Latest finalized protocol actions'}</p></div><span className="activity-live"><i/>Live</span></div>{activityLoading ? <TableSkeleton rows={4}/> : recent.length ? <div className="activity-list">{recent.map((event) => <article className="activity-item" key={event.key}><span className={`activity-symbol ${event.tone}`}><Icon name={event.icon} size={13}/></span><div><strong>{event.title}</strong><small>{event.detail}</small></div><time>{activityTime(event.observedAt)}</time></article>)}</div> : <Empty text="No recent activity" detail="Verified repo actions will appear here after Monad confirmation."/>}</section></section></div>;
}

function RepoTable({ rows, address, assets, actions }) {
  const names = new Map(assets.map((asset) => [asset.address.toLowerCase(), asset]));
  return <div className="table-wrap"><table><thead><tr><th>Repo / Asset</th><th>Compliance</th><th>Side</th><th>Principal</th><th>Rate</th><th>Maturity</th><th>Status</th>{actions && <th/>}</tr></thead><tbody>{rows.map((row) => { const asset = names.get(row.assetAddress.toLowerCase()); const side = row.seller === address?.toLowerCase() ? 'Seller' : 'Buyer'; return <tr key={row.repoId}><td><div className="asset-cell"><span className="asset-monogram">{(asset?.symbol || 'CVA').slice(0,2)}</span><div><strong>{asset?.name || short(row.assetAddress)}</strong><small>Repo #{row.repoId} · {asset?.symbol || 'CVA'}</small></div></div></td><td><CvaBadge asset={asset} compact/></td><td><span className={`side ${side.toLowerCase()}`}>{side}</span></td><td className="number">{formatUnits(row.principalAmount)} aUSDC</td><td className="gold-text number">{(row.annualRateBps / 100).toFixed(2)}%</td><td>{dateTime(row.maturityAt)}</td><td><Status value={effectiveRepoStatus(row)}/></td>{actions && <td>{actions(row, side)}</td>}</tr>;})}</tbody></table></div>;
}

function Markets({ offers, assets, address, onAccept, busy, loading }) {
  const [search, setSearch] = useState('');
  const names = new Map(assets.map((asset) => [asset.address.toLowerCase(), asset]));
  const filtered = offers.filter((row) => { const asset = names.get(row.assetAddress.toLowerCase()); return `${asset?.name || ''} ${asset?.symbol || ''} ${row.seller}`.toLowerCase().includes(search.toLowerCase()); });
  return <div className="page-view"><Heading eyebrow="Verified market" title="Repo Markets" description="Public and targeted offers indexed from Monad." action={<div className="market-summary"><span><i/> Market live</span><strong>{filtered.length} open</strong></div>}/><section className="card markets-card"><div className="market-tools"><label className="search-box"><Icon name="search"/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search asset or seller"/></label></div><div className="results-meta"><span>{filtered.length} confirmed offers</span><span>Rates annualized · Settlement in aUSDC</span></div>{loading ? <TableSkeleton rows={4}/> : filtered.length ? <div className="table-wrap market-table"><table><thead><tr><th>Verified Asset</th><th>Principal</th><th>Duration</th><th>Repo Rate</th><th>Seller</th><th>Status</th><th/></tr></thead><tbody>{filtered.map((row) => { const asset = names.get(row.assetAddress.toLowerCase()); const targetedElsewhere = row.permittedBuyer && row.permittedBuyer !== address?.toLowerCase(); return <tr key={row.repoId}><td><div className="asset-cell"><span className="asset-monogram large">{(asset?.symbol || 'CVA').slice(0,2)}</span><div><strong>{asset?.name || short(row.assetAddress)}</strong><CvaBadge asset={asset}/></div></div></td><td className="number">{formatUnits(row.principalAmount)} aUSDC</td><td>{durationLabel(row.durationSeconds)}</td><td className="rate-cell number">{(row.annualRateBps / 100).toFixed(2)}%</td><td><div className="counterparty"><strong>{short(row.seller)}</strong><small><span>✓</span> CVI-checked seller</small></div></td><td><Status value={row.status}/></td><td><button className="table-action" disabled={busy || targetedElsewhere || row.seller === address?.toLowerCase()} onClick={() => onAccept(row)}>{targetedElsewhere ? 'Targeted' : row.seller === address?.toLowerCase() ? 'Your offer' : 'Review & Accept'}</button></td></tr>;})}</tbody></table></div> : <Empty text={search ? 'No matching verified offers' : 'No open repo offers'} detail={search ? 'Try a different asset, symbol, or seller address.' : 'New Cleanverse-verified offers will appear after Monad confirmation.'}/>}</section></div>;
}

function CreateRepo({ assets, config, address, onCreate, busy, lastPreflight }) {
  const [assetAddress, setAssetAddress] = useState('');
  const [collateral, setCollateral] = useState('10');
  const [principal, setPrincipal] = useState('0.01');
  const [rate, setRate] = useState('5.75');
  const [permittedBuyer, setPermittedBuyer] = useState('');
  useEffect(() => { if (!assetAddress && assets[0]) setAssetAddress(assets[0].address); }, [assets, assetAddress]);
  const selected = assets.find((asset) => asset.address === assetAddress);
  const duration = config?.terms?.allowedDurations?.[0] || 300;
  const submit = (event) => { event.preventDefault(); if (!selected) return; onCreate({ asset: selected, collateral, principal, rate, duration, permittedBuyer }); };
  return <div className="page-view create-view"><Heading eyebrow="New transaction" title="Create Repo Offer" description="Pledge an issued CVA and request aUSDC liquidity."/><form className="create-grid" onSubmit={submit}><section className="card form-card"><div className="form-section-title"><span>01</span><div><h3>Commercial terms</h3><p>All amounts are verified again immediately before signing.</p></div></div>{assets.length ? <><div className="field"><label>Tokenized asset</label><div className="custom-select"><select value={assetAddress} onChange={(event) => setAssetAddress(event.target.value)}>{assets.map((asset) => <option key={asset.address} value={asset.address}>{asset.name} ({asset.symbol})</option>)}</select><CvaBadge asset={selected}/></div></div><div className="field-row"><div className="field"><label>Collateral amount</label><div className="input-affix"><input value={collateral} onChange={(event) => setCollateral(event.target.value)}/><b>{selected?.symbol}</b></div></div><div className="field"><label>Principal amount</label><div className="input-affix"><input value={principal} onChange={(event) => setPrincipal(event.target.value)}/><b>aUSDC</b></div></div></div><div className="field-row"><div className="field"><label>Annual repo rate</label><div className="input-affix"><input type="number" step="0.01" value={rate} onChange={(event) => setRate(event.target.value)}/><b>% APR</b></div></div><div className="field"><label>Repo term</label><div className="input-affix"><input value={durationLabel(duration)} disabled/><b>UAT</b></div></div></div><div className="field"><label>Permitted buyer (optional)</label><input className="plain-input" value={permittedBuyer} onChange={(event) => setPermittedBuyer(event.target.value)} placeholder="0x… or leave public"/></div></> : <Empty text="No issued CVA is enabled" detail="Enable a Cleanverse-issued asset before creating a repo offer."/>}</section><aside className="create-aside"><section className="card verification-panel"><div className="panel-heading"><span className="shield-large"><Icon name="shield"/></span><div><h3>Preflight status</h3><p>Real Cleanverse and on-chain checks</p></div></div>{lastPreflight ? <div className="verification-list"><Verification title="CVI identity" ok={lastPreflight.compliance?.[0]?.cviActive}/><Verification title="CVA issued" ok={lastPreflight.compliance?.[0]?.assetIssued && !lastPreflight.compliance?.[0]?.assetPaused}/><Verification title="Pool eligible" ok={lastPreflight.compliance?.[0]?.poolEligible}/></div> : <p className="legal-note">Checks run when you submit. No synthetic verification is displayed.</p>}</section><section className="card execution-panel"><h3>Execution summary</h3><dl><div><dt>Asset</dt><dd>{selected?.symbol || '—'}</dd></div><div><dt>Principal</dt><dd>{principal} aUSDC</dd></div><div><dt>Repo term</dt><dd>{durationLabel(duration)}</dd></div><div><dt>Offer validity</dt><dd>{durationLabel(OFFER_VALIDITY_SECONDS)}</dd></div><div><dt>Repo rate</dt><dd>{rate}%</dd></div></dl><button type="submit" className="button primary full create-submit" disabled={busy || !address || !selected}>{busy ? 'Verifying / Signing…' : 'Verify with Cleanverse & Create Offer'}</button><p className="onchain-assurance"><Icon name="shield" size={12}/>Cleanverse eligibility is verified before signing and enforced on-chain at execution</p></section></aside></form></div>;
}

function Verification({ title, ok }) {
  return <div className="verification-item"><span className="check-circle"><Icon name={ok ? 'check' : 'clock'} size={13}/></span><div><strong>{title}</strong><small>{ok ? 'Verified' : 'Not confirmed'}</small></div></div>;
}

function Portfolio({ positions, assets, address, onRepurchase, onCancel, onExpire, onDefault, busy, loading }) {
  const [tab, setTab] = useState('active');
  const openOffers = positions.filter((row) => effectiveRepoStatus(row) === 'OPEN');
  const activeRepos = positions.filter((row) => effectiveRepoStatus(row) === 'ACTIVE');
  const history = positions.filter((row) => !['OPEN', 'ACTIVE'].includes(effectiveRepoStatus(row)));
  const tabs = [
    { id: 'open', label: 'Open Offers', rows: openOffers },
    { id: 'active', label: 'Active Repos', rows: activeRepos },
    { id: 'history', label: 'History', rows: history },
  ];
  const selectedTab = tabs.find((item) => item.id === tab) || tabs[1];
  const actions = (row, side) => {
    const status = effectiveRepoStatus(row);
    if (status === 'EXPIRY_PENDING') return <button className="table-action" disabled={busy} onClick={() => onExpire(row)}>Finalize expiry</button>;
    if (status === 'OPEN' && side === 'Seller') return <button className="table-action" disabled={busy} onClick={() => onCancel(row)}>Cancel</button>;
    if (status === 'ACTIVE' && row.graceEndsAt && new Date(row.graceEndsAt) < new Date()) return <button className="table-action" disabled={busy} onClick={() => onDefault(row)}>Mark default</button>;
    if (status === 'ACTIVE' && side === 'Seller' && row.maturityAt && new Date(row.maturityAt) <= new Date()) return <button className="table-action" disabled={busy} onClick={() => onRepurchase(row)}>Repurchase</button>;
    return null;
  };
  const emptyText = tab === 'open' ? 'No open offers' : tab === 'active' ? 'No active repo positions' : 'No historical positions';
  return <div className="page-view">
    <Heading eyebrow="On-chain positions" title="Institutional Portfolio" description="Offers and positions involving the connected wallet."/>
    {loading ? <MetricSkeletons/> : <section className="metric-grid portfolio-metrics">
      <Metric label="All Positions" value={address ? String(positions.length) : '—'} note="Indexed records" icon="layers"/>
      <Metric label="Open Offers" value={address ? String(openOffers.length) : '—'} note="Available to buyers" icon="markets"/>
      <Metric label="Active Repos" value={address ? String(activeRepos.length) : '—'} note="Awaiting maturity" icon="clock"/>
      <Metric label="Settled" value={address ? String(positions.filter((row) => row.status === 'REPAID').length) : '—'} note="Atomic repurchases" icon="shield"/>
    </section>}
    <section className="card portfolio-card">
      <div className="portfolio-tabs">
        <div>{tabs.map((item) => <button key={item.id} className={selectedTab.id === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}<span>{item.rows.length}</span></button>)}</div>
        <span>Finalized chain projection · Cleanverse compliant</span>
      </div>
      {loading ? <TableSkeleton rows={4}/> : selectedTab.rows.length ? <RepoTable rows={selectedTab.rows} address={address} assets={assets} actions={actions}/> : <Empty text={address ? emptyText : 'Connect a wallet to view positions'} detail={address ? 'Statuses are time-aware while on-chain finalization catches up.' : 'Your seller and buyer positions are private to the connected wallet view.'}/>}
    </section>
  </div>;
}

function OwnershipSetup({ address, authenticated, login, busy, onAccept }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      setError('');
      const [registry, market] = await Promise.all([
        readOwnership(DEPLOYED_CONTRACTS.assetRegistry),
        readOwnership(DEPLOYED_CONTRACTS.repoMarket),
      ]);
      setStatus({ registry, market });
    } catch (reason) {
      setError(reason.message || 'Unable to read ownership state.');
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const expected = '0xf7100bcc9b352f18b80018d7708177c3c04a128d';
  const correctWallet = address?.toLowerCase() === expected;
  const complete = status && [status.registry, status.market].every((item) => item.owner.toLowerCase() === expected);
  return <div className="page-view"><Heading eyebrow="UAT governance" title="Accept Contract Ownership" description="Complete the two-step ownership handoff using the designated buyer wallet."/><section className="card form-card"><div className="form-section-title"><span>02</span><div><h3>Pending ownership</h3><p>Both transactions call the standard Ownable2Step acceptOwnership function.</p></div></div><div className="cva-admin-grid"><OwnershipState label="CVA Registry" contract={DEPLOYED_CONTRACTS.assetRegistry} state={status?.registry}/><OwnershipState label="RepoMarketV1" contract={DEPLOYED_CONTRACTS.repoMarket} state={status?.market}/><div className="cva-stat"><span>Signing wallet</span><strong>{address ? short(address) : 'Not connected'}</strong><small>{correctWallet ? 'Correct pending owner' : 'Connect the designated buyer wallet'}</small></div></div>{error && <div className="runtime-banner error">{error}</div>}{complete ? <div className="runtime-banner success">Ownership is complete for both contracts.</div> : <button className="button primary" disabled={busy || (authenticated && !correctWallet)} onClick={() => authenticated ? onAccept(status, refresh) : login()}>{busy ? 'Confirm both wallet requests…' : authenticated ? 'Accept Both Contracts' : 'Connect Buyer Wallet'}</button>}</section></div>;
}

function OwnershipState({ label, contract, state }) {
  const accepted = state && state.owner.toLowerCase() === '0xf7100bcc9b352f18b80018d7708177c3c04a128d';
  return <div className="cva-stat"><span>{label}</span><strong className={accepted ? 'success-text' : 'gold-text'}>{accepted ? 'Ownership accepted' : 'Acceptance pending'}</strong><small>{short(contract)}</small></div>;
}

function rowsFrom(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.[key])) return payload[key];
  if (Array.isArray(payload?.data?.[key])) return payload.data[key];
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function marginDeploymentVerified(nextConfig) {
  const proof = nextConfig?.readiness?.crossMargin?.proof;
  return nextConfig?.deploymentTrust?.verified === true
    && isNonZeroAddress(nextConfig?.contracts?.marginEngine)
    && isNonZeroAddress(proof.asset)
    && isNonZeroAddress(proof.vault)
    && isNonZeroAddress(proof.auctionHouse)
    && isNonZeroAddress(proof.settlementEscrow);
}

function normalizeVaultBalances(payload) {
  const source = payload?.data && !Array.isArray(payload.data) ? payload.data : payload || {};
  const buckets = Array.isArray(source) ? source : source.buckets || source.balances || [];
  const liveByVault = new Map((source.liveAvailableByVault || []).map((row) => [row.vault?.toLowerCase(), row.available]));
  const byAsset = new Map();
  for (const row of buckets) {
    const key = row.assetAddress?.toLowerCase();
    if (!key) continue;
    const current = byAsset.get(key) || { assetAddress: row.assetAddress, vaultAddress: row.vaultAddress, available: '0', offerReserved: '0', positionLocked: '0', auctionLocked: '0', marginLocked: '0' };
    const field = {
      AVAILABLE: 'available',
      OFFER_RESERVED: 'offerReserved',
      POSITION_LOCKED: 'positionLocked',
      AUCTION_LOCKED: 'auctionLocked',
      MARGIN_LOCKED: 'marginLocked',
    }[row.bucket];
    if (field) current[field] = row.amount;
    byAsset.set(key, current);
  }
  const rows = [...byAsset.values()];
  for (const row of rows) {
    const liveAvailable = liveByVault.get(row.vaultAddress?.toLowerCase());
    if (liveAvailable !== null && liveAvailable !== undefined) row.available = String(liveAvailable);
  }
  if (rows.length === 1 && !liveByVault.size && source.liveAvailable !== null && source.liveAvailable !== undefined) rows[0].available = String(source.liveAvailable);
  return rows;
}

function v2DeploymentReady(nextConfig) {
  if (!nextConfig || nextConfig?.deploymentTrust?.verified !== true) return false;
  const contracts = nextConfig.contracts || nextConfig.deployments || {};
  const market = contracts.repoMarketV2 || contracts.repoMarket || contracts.market;
  // Deployment presence and entry readiness are intentionally separate. An
  // operator pause or revoked custody attestation must never hide close paths.
  return isNonZeroAddress(market);
}

function normalizeV2Portfolio(payload, walletAddress) {
  const lower = walletAddress?.toLowerCase();
  if (Array.isArray(payload)) {
    const active = payload.filter((row) => !['REPAID', 'LIQUIDATED', 'CANCELLED', 'EXPIRED', 'COLLATERAL_CLAIMED'].includes(row.status));
    const history = payload.filter((row) => !active.includes(row));
    return {
      sellerOffers: active.filter((row) => row.offerId != null && row.positionId == null && row.seller?.toLowerCase() === lower),
      sellerPositions: active.filter((row) => row.positionId != null && row.seller?.toLowerCase() === lower),
      lenderPositions: active.filter((row) => row.positionId != null && [row.buyer, row.lender].some((value) => value?.toLowerCase() === lower)),
      history,
    };
  }
  const source = payload?.data && !Array.isArray(payload.data) ? payload.data : payload || {};
  const allPositions = source.positions || [];
  const sellerPositions = source.sellerPositions || allPositions.filter((row) => row.seller?.toLowerCase() === lower && !['REPAID', 'LIQUIDATED', 'COLLATERAL_CLAIMED'].includes(row.status));
  const lenderPositions = source.lenderPositions || source.buyerPositions || allPositions.filter((row) => [row.buyer, row.lender].some((value) => value?.toLowerCase() === lower) && !['REPAID', 'LIQUIDATED', 'COLLATERAL_CLAIMED'].includes(row.status));
  return {
    sellerOffers: source.sellerOffers || source.offers || [],
    sellerPositions,
    lenderPositions,
    history: [
      ...(source.sellerOfferHistory || []),
      ...(source.history || allPositions.filter((row) => ['REPAID', 'LIQUIDATED', 'CANCELLED', 'EXPIRED', 'COLLATERAL_CLAIMED'].includes(row.status))),
    ],
  };
}

function VersionedMarkets({ version, setVersion, v2State, retryV2, v2Offers, assets, address, busy, v2Loading, onV2Action, settlement, entryEnabled, v1 }) {
  return <><div className="page-view protocol-rail"><ProtocolSwitch value={version} onChange={setVersion} v2State={v2State}/><span>{version === 'v2' ? 'Tri-party custody · Partial fills' : 'Legacy atomic title transfer'}</span></div>{version === 'v1' ? v1 : <div className="page-view"><Heading eyebrow="Institutional V2" title="Partial-fill Repo Markets" description={`Allocate ${settlement.symbol} across independent fills while verified CVA remains secured by the tri-party vault.`}/>{v2State === 'ready' ? <V2Markets offers={v2Offers} assets={assets} address={address} loading={v2Loading} busy={busy} onAction={onV2Action} settlement={settlement} entryEnabled={entryEnabled}/> : <V2Unavailable state={v2State} onRetry={retryV2}/>}</div>}</>;
}

function VersionedPortfolio({ version, setVersion, v2State, retryV2, v2Portfolio, claims, assets, address, busy, v2Loading, onV2Action, settlement, chainClock, v1 }) {
  return <><div className="page-view protocol-rail"><ProtocolSwitch value={version} onChange={setVersion} v2State={v2State}/><span>{version === 'v2' ? 'Seller and lender books · Early payoff' : 'Direct DvP records'}</span></div>{version === 'v1' ? v1 : <div className="page-view"><Heading eyebrow="Institutional V2" title="Vault-settled Portfolio" description="Monitor offers, lender fills, per-fill maturities and early repurchase obligations separately."/>{v2State === 'ready' ? <V2Portfolio portfolio={v2Portfolio} claims={claims} assets={assets} address={address} loading={v2Loading} busy={busy} onAction={onV2Action} settlement={settlement} chainClock={chainClock}/> : <V2Unavailable state={v2State} onRetry={retryV2}/>}</div>}</>;
}

function VersionedCreate({ version, setVersion, v2State, retryV2, assets, balances, marginAccounts, config, address, busy, onV2Action, settlement, preferredMarginAccount, chainClock, entryEnabled, v1 }) {
  return <><div className="page-view protocol-rail"><ProtocolSwitch value={version} onChange={setVersion} v2State={v2State}/><span>{version === 'v2' ? 'Partial fills · Vault-reserved collateral' : 'Single-fill Direct DvP'}</span></div>{version === 'v1' ? v1 : <div className="page-view create-view"><Heading eyebrow="Institutional V2" title="Create Partial-fill Repo Offer" description="Reserve verified collateral in the tri-party Vault and define independent per-fill maturities."/>{v2State === 'ready' ? <V2CreateOffer assets={assets} balances={balances} marginAccounts={marginAccounts} config={config} address={address} busy={busy} onAction={onV2Action} settlement={settlement} preferredMarginAccount={preferredMarginAccount} chainClock={chainClock} entryEnabled={entryEnabled}/> : <V2Unavailable state={v2State} onRetry={retryV2}/>}</div>}</>;
}

function AppLive() {
  const { ready, authenticated, user, logout, getAccessToken } = usePrivy();
  const { login } = useLogin();
  const { wallets } = useWallets();
  const linkedWallet = user?.linkedAccounts?.find((account) => account.type === 'wallet' || account.type === 'smart_wallet');
  const address = wallets[0]?.address || user?.wallet?.address || linkedWallet?.address || '';
  const activeAddress = useRef(address);
  activeAddress.current = address;
  const wallet = wallets.find((candidate) => candidate.address?.toLowerCase() === address.toLowerCase()) || wallets[0];
  const validPages = ['landing', 'ownership', ...navigation.map((item) => item.id)];
  const initial = window.location.hash.replace('#/', '') || 'landing';
  const [page, setPage] = useState(validPages.includes(initial) ? initial : 'landing');
  const [config, setConfig] = useState(null);
  const [assets, setAssets] = useState([]);
  const [offers, setOffers] = useState([]);
  const [positions, setPositions] = useState([]);
  const [activity, setActivity] = useState([]);
  const [compliance, setCompliance] = useState(null);
  const [complianceState, setComplianceState] = useState('idle');
  const [publicLoaded, setPublicLoaded] = useState(false);
  const [positionsLoaded, setPositionsLoaded] = useState(false);
  const [activityLoaded, setActivityLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [syncErrors, setSyncErrors] = useState({});
  const [lastPreflight, setLastPreflight] = useState(null);
  const [marketVersion, setMarketVersion] = useState('v1');
  const [portfolioVersion, setPortfolioVersion] = useState('v1');
  const [createVersion, setCreateVersion] = useState('v1');
  const [preferredMarginAccount, setPreferredMarginAccount] = useState(null);
  const [v2State, setV2State] = useState('loading');
  const [v2Config, setV2Config] = useState(null);
  const [v2Offers, setV2Offers] = useState([]);
  const [v2Portfolio, setV2Portfolio] = useState({ sellerOffers: [], sellerPositions: [], lenderPositions: [], history: [] });
  const [vaultBalances, setVaultBalances] = useState([]);
  const [auctions, setAuctions] = useState([]);
  const [marginAccounts, setMarginAccounts] = useState([]);
  const [settlementClaims, setSettlementClaims] = useState([]);
  const [v2ChainClock, setV2ChainClock] = useState(null);
  const [v2PublicLoaded, setV2PublicLoaded] = useState(false);
  const [v2WalletLoaded, setV2WalletLoaded] = useState(false);
  const [v2Execution, setV2Execution] = useState({ stage: 'idle' });
  const v2WasAutoSelected = useRef(false);
  const v2OffersRef = useRef([]);
  const trustedV2ConfigRef = useRef(null);
  const runtimeVerificationRef = useRef({ checkedAt: 0, result: null });
  const activeV2ExecutionRef = useRef(false);
  const v2RefreshInFlightRef = useRef(null);
  const [, setPendingRevision] = useState(0);
  const auth = { ready, authenticated, address, login, logout };
  const marginExitAvailable = marginDeploymentVerified(v2Config);

  const updateSyncError = useCallback((source, message = '') => {
    setSyncErrors((current) => {
      if (message) return current[source] === message ? current : { ...current, [source]: message };
      if (!current[source]) return current;
      const next = { ...current };
      delete next[source];
      return next;
    });
  }, []);

  const loadPublic = useCallback(async () => {
    try {
      const [nextConfig, nextAssets, nextOffers] = await Promise.all([apiRequest('/v1/config'), apiRequest('/v1/assets'), apiRequest('/v1/offers')]);
      setConfig(nextConfig); setAssets(nextAssets); setOffers(nextOffers);
      updateSyncError('public');
    } catch (reason) {
      updateSyncError('public', reason.message || 'Live market data is unavailable.');
      throw reason;
    }
  }, [updateSyncError]);
  const loadPositions = useCallback(async () => {
    if (!address) {
      setPositions([]);
      updateSyncError('positions');
      return;
    }
    const requestedAddress = address;
    try {
      const nextPositions = await apiRequest(`/v1/positions/${requestedAddress}`);
      if (activeAddress.current.toLowerCase() === requestedAddress.toLowerCase()) {
        setPositions(nextPositions);
        updateSyncError('positions');
      }
    } catch (reason) {
      if (activeAddress.current.toLowerCase() === requestedAddress.toLowerCase()) updateSyncError('positions', reason.message || 'Portfolio data is unavailable.');
      throw reason;
    }
  }, [address, updateSyncError]);
  const loadActivity = useCallback(async () => {
    const requestedAddress = address;
    const query = requestedAddress ? `?wallet=${encodeURIComponent(requestedAddress)}&limit=4` : '?limit=4';
    try {
      const nextActivity = await apiRequest(`/v1/activity${query}`);
      if (activeAddress.current.toLowerCase() === requestedAddress.toLowerCase()) {
        setActivity(nextActivity);
        updateSyncError('activity');
      }
    } catch (reason) {
      if (activeAddress.current.toLowerCase() === requestedAddress.toLowerCase()) updateSyncError('activity', reason.message || 'Activity data is unavailable.');
      throw reason;
    }
  }, [address, updateSyncError]);
  const detectV2 = useCallback(async (options = {}) => {
    setV2State((current) => current === 'ready' ? current : 'loading');
    try {
      const nextConfig = await apiRequest('/v2/config');
      const identity = compareApiConfigToManifest(nextConfig, TRUSTED_V2_MANIFEST);
      if (!identity.ok) {
        const mismatch = new Error(`V2 deployment identity check failed: ${identity.errors.join(', ')}`);
        mismatch.code = 'UNTRUSTED_V2_DEPLOYMENT';
        throw mismatch;
      }
      const verificationAge = Date.now() - runtimeVerificationRef.current.checkedAt;
      if (options?.forceCodeCheck === true || !runtimeVerificationRef.current.result || verificationAge > 5 * 60_000) {
        const runtime = await verifyManifestRuntimeCode(TRUSTED_V2_MANIFEST, readRuntimeCodeHash);
        runtimeVerificationRef.current = { checkedAt: Date.now(), result: runtime };
      }
      const trustedConfig = pinTrustedV2Config(nextConfig, TRUSTED_V2_MANIFEST, runtimeVerificationRef.current.result);
      trustedV2ConfigRef.current = trustedConfig;
      setV2Config(trustedConfig);
      const finalizedTimestamp = Number(trustedConfig?.finalized?.chainTimestamp);
      setV2ChainClock(Number.isFinite(finalizedTimestamp) && finalizedTimestamp > 0
        ? { chainTimeMs: finalizedTimestamp * 1000, monotonicMs: performance.now() }
        : null);
      const readyForUse = v2DeploymentReady(trustedConfig);
      setV2State(readyForUse ? 'ready' : 'unavailable');
      updateSyncError('v2-config');
      return readyForUse;
    } catch (reason) {
      const trustedFallback = trustedV2ConfigRef.current;
      if (trustedFallback) {
        // Immutable destinations remain pinned for recovery/exit rendering, but
        // stale dynamic pause/readiness state must never authorize new entry.
        setV2Config({
          ...trustedFallback,
          features: Object.fromEntries(Object.keys(trustedFallback.features || {}).map((key) => [key, false])),
        });
        setV2State('unavailable');
        updateSyncError('v2-config', reason.message || 'Dynamic V2 readiness is unavailable. New entry is fail-closed; reviewed exit destinations remain visible.');
        return false;
      }
      setV2Config(null);
      setV2ChainClock(null);
      setV2State('unavailable');
      if (reason.code && reason.code !== 'NOT_FOUND' && reason.code !== 'V2_NOT_DEPLOYED') updateSyncError('v2-config', reason.message || 'V2 deployment registry is unavailable.');
      return false;
    }
  }, [updateSyncError]);
  const loadV2Public = useCallback(async () => {
    const [offerResult, auctionResult] = await Promise.allSettled([
      apiRequest('/v2/offers'),
      apiRequest('/v2/auctions'),
    ]);
    if (offerResult.status === 'fulfilled') {
      const nextOffers = rowsFrom(offerResult.value, 'offers');
      v2OffersRef.current = nextOffers;
      setV2Offers(nextOffers);
      updateSyncError('v2-offers');
    } else updateSyncError('v2-offers', offerResult.reason?.message || 'V2 offers are unavailable.');
    if (auctionResult.status === 'fulfilled') {
      setAuctions(rowsFrom(auctionResult.value, 'auctions'));
      updateSyncError('v2-auctions');
    } else updateSyncError('v2-auctions', auctionResult.reason?.message || 'Auctions are unavailable.');
    const observedTimestamp = [offerResult, auctionResult]
      .filter((item) => item.status === 'fulfilled')
      .map((item) => Number(item.value?.asOf?.chainTimestamp))
      .filter((value) => Number.isFinite(value) && value > 0)
      .reduce((latest, value) => Math.max(latest, value), 0);
    if (observedTimestamp > 0) setV2ChainClock({ chainTimeMs: observedTimestamp * 1000, monotonicMs: performance.now() });
  }, [updateSyncError]);
  const loadV2Wallet = useCallback(async () => {
    if (!address) {
      setV2Portfolio({ sellerOffers: [], sellerPositions: [], lenderPositions: [], history: [] });
      setVaultBalances([]);
      setMarginAccounts([]);
      setSettlementClaims([]);
      updateSyncError('v2-wallet');
      return;
    }
    const requestedAddress = address;
    const [portfolioResult, vaultResult, marginResult, claimsResult] = await Promise.allSettled([
      apiRequest(`/v2/positions/${requestedAddress}`),
      apiRequest(`/v2/vault/${requestedAddress}/balances`),
      apiRequest(`/v2/margin/accounts/${requestedAddress}`),
      apiRequest(`/v2/claims/${requestedAddress}`),
    ]);
    if (activeAddress.current.toLowerCase() !== requestedAddress.toLowerCase()) return;
    if (portfolioResult.status === 'fulfilled') {
      const nextPortfolio = normalizeV2Portfolio(portfolioResult.value, requestedAddress);
      const currentOffers = v2OffersRef.current;
      if (!nextPortfolio.sellerOffers.length) {
        nextPortfolio.sellerOffers = currentOffers.filter((row) => row.seller?.toLowerCase() === requestedAddress.toLowerCase());
      }
      const offersById = new Map(currentOffers.map((row) => [String(row.offerId), row]));
      const withOfferTerms = (row) => ({
        ...(offersById.get(String(row.offerId)) || {}),
        ...(row.offerTerms || {}),
        ...row,
      });
      nextPortfolio.sellerPositions = nextPortfolio.sellerPositions.map(withOfferTerms);
      nextPortfolio.lenderPositions = nextPortfolio.lenderPositions.map(withOfferTerms);
      nextPortfolio.history = nextPortfolio.history.map(withOfferTerms);
      setV2Portfolio(nextPortfolio);
      updateSyncError('v2-portfolio');
    } else updateSyncError('v2-portfolio', portfolioResult.reason?.message || 'V2 portfolio is unavailable.');
    if (vaultResult.status === 'fulfilled') {
      setVaultBalances(normalizeVaultBalances(vaultResult.value));
      updateSyncError('v2-vault');
    } else updateSyncError('v2-vault', vaultResult.reason?.message || 'Vault balances are unavailable.');
    if (marginResult.status === 'fulfilled') {
      setMarginAccounts(rowsFrom(marginResult.value, 'accounts'));
      updateSyncError('v2-margin');
    } else updateSyncError('v2-margin', marginResult.reason?.message || 'Margin accounts are unavailable.');
    if (claimsResult.status === 'fulfilled') {
      setSettlementClaims(rowsFrom(claimsResult.value, 'claims'));
      updateSyncError('v2-claims');
    } else updateSyncError('v2-claims', claimsResult.reason?.message || 'Settlement claims are unavailable.');
  }, [address, updateSyncError]);
  const loadMarginExitData = useCallback(async () => {
    const requestedAddress = address;
    const [auctionResult, marginResult, claimsResult] = await Promise.allSettled([
      apiRequest('/v2/auctions'),
      requestedAddress ? apiRequest(`/v2/margin/accounts/${requestedAddress}`) : Promise.resolve([]),
      requestedAddress ? apiRequest(`/v2/claims/${requestedAddress}`) : Promise.resolve([]),
    ]);
    if (activeAddress.current.toLowerCase() !== requestedAddress.toLowerCase()) return;
    if (auctionResult.status === 'fulfilled') {
      setAuctions(rowsFrom(auctionResult.value, 'auctions'));
      updateSyncError('v2-auctions');
    } else updateSyncError('v2-auctions', auctionResult.reason?.message || 'Margin auctions are unavailable.');
    if (marginResult.status === 'fulfilled') {
      setMarginAccounts(rowsFrom(marginResult.value, 'accounts'));
      updateSyncError('v2-margin');
    } else updateSyncError('v2-margin', marginResult.reason?.message || 'Margin accounts are unavailable.');
    if (claimsResult.status === 'fulfilled') {
      setSettlementClaims(rowsFrom(claimsResult.value, 'claims'));
      updateSyncError('v2-claims');
    } else updateSyncError('v2-claims', claimsResult.reason?.message || 'Settlement claims are unavailable.');
  }, [address, updateSyncError]);
  const refreshV2Data = useCallback(async () => {
    if (v2State !== 'ready') return [];
    if (v2RefreshInFlightRef.current) return v2RefreshInFlightRef.current;
    const pending = Promise.allSettled([loadV2Public(), loadV2Wallet()])
      .finally(() => {
        if (v2RefreshInFlightRef.current === pending) v2RefreshInFlightRef.current = null;
      });
    v2RefreshInFlightRef.current = pending;
    return pending;
  }, [v2State, loadV2Public, loadV2Wallet]);
  const refreshLiveData = useCallback(
    () => Promise.allSettled([loadPublic(), loadPositions(), loadActivity()]),
    [loadPublic, loadPositions, loadActivity],
  );
  useEffect(() => {
    let active = true;
    setPublicLoaded(false);
    loadPublic()
      .catch(() => {})
      .finally(() => { if (active) setPublicLoaded(true); });
    return () => { active = false; };
  }, [loadPublic]);
  useEffect(() => {
    let active = true;
    setPositions([]);
    setPositionsLoaded(false);
    loadPositions()
      .catch(() => {
        if (!active) return;
        setPositions([]);
      })
      .finally(() => { if (active) setPositionsLoaded(true); });
    return () => { active = false; };
  }, [loadPositions]);
  useEffect(() => {
    let active = true;
    setActivity([]);
    setActivityLoaded(false);
    loadActivity()
      .catch(() => {
        if (!active) return;
        setActivity([]);
      })
      .finally(() => { if (active) setActivityLoaded(true); });
    return () => { active = false; };
  }, [loadActivity]);
  useEffect(() => {
    const timer = window.setInterval(refreshLiveData, 15_000);
    const onVisibility = () => { if (document.visibilityState === 'visible') void refreshLiveData(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [refreshLiveData]);
  useEffect(() => { void detectV2(); }, [detectV2]);
  useEffect(() => {
    if (v2State !== 'ready') {
      setV2PublicLoaded(v2State !== 'loading');
      setV2WalletLoaded(v2State !== 'loading');
      return undefined;
    }
    if (!v2WasAutoSelected.current) {
      v2WasAutoSelected.current = true;
      setMarketVersion('v2');
      setPortfolioVersion('v2');
      setCreateVersion('v2');
    }
    let active = true;
    setV2PublicLoaded(false);
    setV2WalletLoaded(false);
    const publicLoad = loadV2Public()
      .finally(() => { if (active) setV2PublicLoaded(true); });
    const walletLoad = loadV2Wallet()
      .finally(() => { if (active) setV2WalletLoaded(true); });
    void Promise.allSettled([publicLoad, walletLoad]);
    return () => { active = false; };
  }, [v2State, loadV2Public, loadV2Wallet]);
  useEffect(() => {
    if (v2State !== 'ready') return undefined;
    const timer = window.setInterval(refreshV2Data, 15_000);
    const onVisibility = () => { if (document.visibilityState === 'visible') void refreshV2Data(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [v2State, refreshV2Data]);
  useEffect(() => {
    if (v2State !== 'ready') return undefined;
    const timer = window.setInterval(() => void detectV2(), 60_000);
    const onVisibility = () => { if (document.visibilityState === 'visible') void detectV2(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [v2State, detectV2]);
  useEffect(() => {
    if (v2State === 'ready' || !marginExitAvailable) return undefined;
    let active = true;
    setV2PublicLoaded(false);
    setV2WalletLoaded(false);
    const refresh = () => loadMarginExitData().finally(() => {
      if (active) {
        setV2PublicLoaded(true);
        setV2WalletLoaded(true);
      }
    });
    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [v2State, marginExitAvailable, loadMarginExitData]);
  const identityAssetAddress = assets[0]?.address || '';
  useEffect(() => {
    let active = true;
    if (!authenticated || !address) {
      setCompliance(null);
      setComplianceState('idle');
      return () => { active = false; };
    }
    if (!identityAssetAddress) {
      setCompliance(null);
      setComplianceState(publicLoaded ? 'error' : 'idle');
      return () => { active = false; };
    }
    setCompliance(null);
    setComplianceState('loading');
    const verifyIdentity = async () => {
      try {
        const token = await getAccessToken();
        const result = await apiRequest('/v1/compliance/verify', { token, body: { wallet: address, asset: identityAssetAddress } });
        if (!active) return;
        setCompliance(result);
        setComplianceState('ready');
      } catch {
        if (!active) return;
        setComplianceState('error');
      }
    };
    void verifyIdentity();
    const timer = window.setInterval(verifyIdentity, 30_000);
    const onVisibility = () => { if (document.visibilityState === 'visible') void verifyIdentity(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [authenticated, address, identityAssetAddress, getAccessToken, publicLoaded]);
  useEffect(() => { const listener = () => { const next = window.location.hash.replace('#/', '') || 'landing'; if (validPages.includes(next)) { setError(''); setNotice(''); setPage(next); } }; window.addEventListener('hashchange', listener); return () => window.removeEventListener('hashchange', listener); }, []);

  const go = (next) => { setError(''); setNotice(''); setV2Execution({ stage: 'idle' }); setPage(next); window.location.hash = `/${next}`; window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const requireWallet = () => { if (!authenticated || !address || !wallet) { login(); throw new Error('Connect a wallet to continue.'); } if (!config?.contracts?.repoMarket) throw new Error('RepoMarketV1 has not been deployed/configured yet.'); };
  const preflightWithApprovals = async (path, body) => {
    const token = await getAccessToken();
    let result = await apiRequest(path, { token, body });
    setLastPreflight(result);
    const nonApprovalBlockers = result.blockingReasons.filter((reason) => reason !== 'INSUFFICIENT_ALLOWANCE');
    if (nonApprovalBlockers.length) throw new Error(`Preflight blocked: ${nonApprovalBlockers.join(', ')}`);
    for (const approval of result.requiredApprovals) await sendTransaction(wallet, approval.token, encodeApproval(approval.spender, approval.amount));
    if (result.requiredApprovals.length) { result = await apiRequest(path, { token, body }); setLastPreflight(result); }
    if (!result.eligible) throw new Error(`Preflight blocked: ${result.blockingReasons.join(', ')}`);
    return result;
  };
  const transact = async (work, success) => { setBusy(true); setError(''); setNotice(''); try { requireWallet(); const result = await work(); setNotice(typeof success === 'function' ? success(result) : success); await refreshLiveData(); } catch (reason) { setError(reason.message || 'Transaction failed.'); } finally { setBusy(false); } };

  const waitForV2Index = async (txHashes, maxAttempts = 30) => {
    const uniqueHashes = [...new Set(txHashes.filter(Boolean))];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const statuses = await Promise.all(uniqueHashes.map((hash) => apiRequest(`/v2/transactions/${hash}/status`).catch(() => null)));
      if (statuses.length && statuses.every((status) => status?.indexed === true && status?.finalized === true)) return true;
      if (attempt + 1 < maxAttempts) await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    }
    return false;
  };

  const persistPendingV2 = useCallback((record) => {
    const normalized = { ...record, id: record.id || pendingRecordId(record) };
    upsertPendingExecution(window.localStorage, normalized);
    setPendingRevision((value) => value + 1);
    return normalized.id;
  }, []);

  const clearPendingV2 = useCallback((id) => {
    if (!id) return;
    removePendingExecution(window.localStorage, id);
    setPendingRevision((value) => value + 1);
  }, []);

  const reconcilePendingV2 = useCallback(async () => {
    if (!address || activeV2ExecutionRef.current) return;
    const [record] = pendingForWallet(window.localStorage, MONAD_CHAIN_ID, address);
    if (!record) return;
    setBusy(true);
    if (record.phase === 'submitted') {
      const chainStatus = await readTransactionStatus(record.hash);
      if (chainStatus.status === 'pending') {
        setV2Execution({ stage: 'confirmation', detail: 'A submitted Monad transaction still has no final receipt. It remains locked against duplicate submission.', txHash: record.hash });
        return;
      }
      clearPendingV2(record.id);
      if (chainStatus.status === 'reverted') {
        setV2Execution({ stage: 'error', detail: 'The previously submitted Monad transaction reverted. Its action lock has been released.', code: 'TX_REVERTED', txHash: record.hash });
        if (!pendingForWallet(window.localStorage, MONAD_CHAIN_ID, address).length) setBusy(false);
        return;
      }
      if (!record.completesAction) {
        setV2Execution({ stage: 'success', detail: 'The interrupted transaction step confirmed. Run a fresh preflight to resume the remaining action safely.', txHash: record.hash });
        if (!pendingForWallet(window.localStorage, MONAD_CHAIN_ID, address).length) setBusy(false);
        await (record.kind === 'margin-action' && v2State !== 'ready' ? loadMarginExitData() : refreshV2Data());
        return;
      }
      persistPendingV2({
        chainId: MONAD_CHAIN_ID,
        wallet: address,
        phase: 'indexing',
        kind: record.kind,
        txHashes: record.txHashes?.length ? record.txHashes : [record.hash],
        successMessage: record.successMessage,
        createdAt: record.createdAt,
      });
      setV2Execution({ stage: 'indexing', detail: 'The recovered transaction confirmed. Waiting for finalized protocol projections.', txHash: record.hash });
      return;
    }
    const indexed = await waitForV2Index(record.txHashes, 1);
    if (!indexed) {
      setV2Execution({ stage: 'indexing', detail: 'The transaction is confirmed; finalized indexing is still pending. Duplicate submission remains locked.', txHash: record.txHashes.at(-1) });
      return;
    }
    clearPendingV2(record.id);
    await (record.kind === 'margin-action' && v2State !== 'ready' ? loadMarginExitData() : refreshV2Data());
    setV2Execution({ stage: 'success', detail: record.successMessage || 'Recovered execution is finalized and indexed.', txHash: record.txHashes.at(-1) });
    if (!pendingForWallet(window.localStorage, MONAD_CHAIN_ID, address).length) setBusy(false);
  }, [address, clearPendingV2, loadMarginExitData, persistPendingV2, refreshV2Data, v2State]);

  useEffect(() => {
    if (!address) return undefined;
    void reconcilePendingV2();
    const timer = window.setInterval(() => void reconcilePendingV2(), 5_000);
    const onVisibility = () => { if (document.visibilityState === 'visible') void reconcilePendingV2(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [address, reconcilePendingV2]);

  const executeV2Action = async (kind, body, successMessage) => {
    let keepExecutionLocked = false;
    let activePendingId = '';
    const refreshExecutedAction = kind === 'margin-action' && v2State !== 'ready' ? loadMarginExitData : refreshV2Data;
    activeV2ExecutionRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setV2Execution({ stage: 'preflight', detail: `Preparing ${kind.replaceAll('-', ' ')}.` });
    try {
      if (!authenticated || !address || !wallet) {
        login();
        throw new Error('Connect a wallet to continue.');
      }
      if (pendingForWallet(window.localStorage, MONAD_CHAIN_ID, address).length) {
        throw new Error('A previously submitted V2 transaction is still reconciling. Do not submit this action again.');
      }
      if (kind !== 'margin-action' && v2State !== 'ready') throw new Error('Institutional V2 is not deployed on this environment.');
      if (kind === 'margin-action') {
        if (!marginDeploymentVerified(v2Config)) throw new Error('The verified MarginEngine deployment is unavailable.');
        if (['OPEN_ACCOUNT', 'FUND_ACCOUNT'].includes(body.action) && v2Config?.features?.crossMargin !== true) {
          throw new Error('New margin entry is paused. Exit and risk-reduction actions remain available.');
        }
      }
      const token = await getAccessToken();
      const path = `/v2/preflight/${kind}`;
      let result = await apiRequest(path, { token, body });
      requireFreshV2Quote(result);
      let blockers = result.blockingReasons || result.checks?.blockingReasons || [];
      const blockerCodes = blockers.map((reason) => typeof reason === 'string' ? reason : reason.code || reason.message || 'PREFLIGHT_BLOCKED');
      const nonApprovalBlockers = blockerCodes.filter((reason) => !['INSUFFICIENT_ALLOWANCE', 'APPROVAL_REQUIRED'].includes(reason));
      if (nonApprovalBlockers.length) {
        const preflightError = new Error(`Preflight blocked: ${nonApprovalBlockers.join(', ')}`);
        preflightError.code = nonApprovalBlockers[0];
        preflightError.correlationId = result.correlationId;
        throw preflightError;
      }
      const approvals = validateApprovalInstructions(kind, body, result, v2Config);
      for (const approval of approvals) {
        const approvalToken = approval.token || approval.asset;
        setV2Execution({ stage: 'approval', detail: approval.label || `Approve ${approval.symbol || 'token'} for the exact execution amount.` });
        await sendTransaction(wallet, approvalToken, encodeApproval(approval.spender, approval.amount), {
          expectedFrom: address,
          onSubmitted: (txHash) => {
            activePendingId = persistPendingV2({
              chainId: MONAD_CHAIN_ID,
              wallet: address,
              phase: 'submitted',
              kind,
              hash: txHash,
              txHashes: [],
              completesAction: false,
              successMessage,
              createdAt: new Date().toISOString(),
            });
            setV2Execution({ stage: 'confirmation', detail: 'Confirming the exact token approval on Monad.', txHash });
          },
        });
        clearPendingV2(activePendingId);
        activePendingId = '';
      }
      if (approvals.length) {
        result = await apiRequest(path, { token, body });
        requireFreshV2Quote(result);
        const remainingApprovals = validateApprovalInstructions(kind, body, result, v2Config);
        if (remainingApprovals.length) throw new Error('The exact token approval is not confirmed yet. Wait for Monad finality before continuing.');
      }
      blockers = result.blockingReasons || result.checks?.blockingReasons || [];
      const allowed = result.allowed ?? result.eligible ?? (blockers.length === 0);
      if (!allowed || blockers.length) {
        const codes = blockers.map((reason) => typeof reason === 'string' ? reason : reason.code || reason.message || 'PREFLIGHT_BLOCKED');
        const preflightError = new Error(`Preflight blocked: ${codes.join(', ') || 'eligibility check failed'}`);
        preflightError.code = codes[0] || 'PREFLIGHT_BLOCKED';
        preflightError.correlationId = result.correlationId;
        throw preflightError;
      }
      const prepared = result.transactions || result.orderedTransactions || result.transactionRequests || result.calls || (result.transaction ? [result.transaction] : result.to && result.data ? [result] : []);
      const transactions = prepared.filter((item) => item?.to && (item.data || item.calldata));
      if (!transactions.length) throw new Error('Preflight succeeded but returned no wallet transaction instructions.');
      transactions.forEach((transaction, index) => assertTrustedV2Instruction(kind, transaction, v2Config, body, result, index, transactions.length));
      let finalHash = '';
      const protocolTxHashes = [];
      for (let index = 0; index < transactions.length; index += 1) {
        const transaction = transactions[index];
        setV2Execution({ stage: 'signature', detail: transaction.description || transaction.label || `Sign transaction ${index + 1} of ${transactions.length}.` });
        const confirmed = await sendTransaction(wallet, transaction.to, transaction.data || transaction.calldata, {
          value: transaction.value,
          expectedFrom: address,
          onSubmitted: (txHash) => {
            finalHash = txHash;
            activePendingId = persistPendingV2({
              chainId: MONAD_CHAIN_ID,
              wallet: address,
              phase: 'submitted',
              kind,
              hash: txHash,
              txHashes: [...protocolTxHashes, txHash],
              completesAction: index === transactions.length - 1,
              successMessage,
              createdAt: new Date().toISOString(),
            });
            setV2Execution({ stage: 'confirmation', detail: `Transaction ${index + 1} of ${transactions.length} is confirming on Monad.`, txHash });
          },
        });
        clearPendingV2(activePendingId);
        activePendingId = '';
        finalHash = confirmed.hash;
        protocolTxHashes.push(confirmed.hash);
      }
      const indexingRecordId = persistPendingV2({
        chainId: MONAD_CHAIN_ID,
        wallet: address,
        phase: 'indexing',
        kind,
        txHashes: protocolTxHashes,
        successMessage,
        createdAt: new Date().toISOString(),
      });
      setV2Execution({ stage: 'indexing', detail: 'Monad confirmed the transaction. Waiting for finalized protocol projections.', txHash: finalHash });
      const indexed = await waitForV2Index(protocolTxHashes);
      await refreshExecutedAction();
      if (indexed) {
        clearPendingV2(indexingRecordId);
        setV2Execution({ stage: 'success', detail: successMessage, txHash: finalHash });
      } else {
        keepExecutionLocked = true;
        setV2Execution({ stage: 'indexing', detail: 'Confirmed on Monad; finalized indexing is still pending. The page will refresh automatically—do not submit again.', txHash: finalHash });
        void waitForV2Index(protocolTxHashes, 570).then(async (indexedLater) => {
          await refreshExecutedAction();
          if (indexedLater) {
            clearPendingV2(indexingRecordId);
            setV2Execution({ stage: 'success', detail: successMessage, txHash: finalHash });
            if (!pendingForWallet(window.localStorage, MONAD_CHAIN_ID, address).length) setBusy(false);
          } else {
            setV2Execution({ stage: 'indexing', detail: 'The transaction is confirmed, but indexing remains unresolved. Its hash is persisted and duplicate submission stays locked.', code: 'INDEXING_TIMEOUT', txHash: finalHash });
          }
        });
      }
      return { ok: true, txHash: finalHash, indexed };
    } catch (reason) {
      const submittedHash = reason.txHash || '';
      if (reason.submitted && submittedHash && !activePendingId) {
        try {
          // A wallet submission can succeed even if local persistence throws. Retry the
          // recovery write here and conservatively treat the step as incomplete; after
          // confirmation the user must run a fresh preflight rather than risk replaying
          // an unknown multi-call sequence.
          activePendingId = persistPendingV2({
            chainId: MONAD_CHAIN_ID,
            wallet: address,
            phase: 'submitted',
            kind,
            hash: submittedHash,
            txHashes: [submittedHash],
            completesAction: false,
            successMessage,
            createdAt: new Date().toISOString(),
          });
        } catch {
          // Storage may be unavailable (for example quota/private-mode restrictions).
          // Keep the in-memory execution lock and surface the hash; never downgrade this
          // to an ordinary retryable error after the wallet has returned a transaction.
        }
      }
      if (reason.code === 'TX_REVERTED') {
        clearPendingV2(activePendingId);
        activePendingId = '';
        setV2Execution({ stage: 'error', detail: reason.message || 'The submitted transaction reverted.', code: reason.code, txHash: submittedHash });
      } else if (reason.submitted || activePendingId) {
        keepExecutionLocked = true;
        setV2Execution({
          stage: 'confirmation',
          detail: reason.message || 'The transaction was submitted but its receipt is still unknown. The action remains locked against duplicate submission.',
          code: reason.code || 'TX_STATUS_UNKNOWN',
          txHash: submittedHash,
        });
      } else {
        setV2Execution({
          stage: 'error',
          detail: reason.message || 'The action could not be completed.',
          code: reason.code,
          correlationId: reason.correlationId,
        });
      }
      return { ok: false, error: reason };
    } finally {
      activeV2ExecutionRef.current = false;
      if (!keepExecutionLocked) setBusy(false);
    }
  };

  const create = (form) => transact(async () => {
    const decimals = form.asset.decimals;
    const body = {
      seller: address,
      asset: form.asset.address,
      permittedBuyer: form.permittedBuyer || null,
      collateralAmount: parseUnits(form.collateral, decimals).toString(),
      principalAmount: parseUnits(form.principal, 6).toString(),
      annualRateBps: Math.round(Number(form.rate) * 100),
      durationSeconds: form.duration,
      offerExpiry: Math.floor(Date.now() / 1000) + OFFER_VALIDITY_SECONDS,
      valuationHash: form.asset.valuationHash,
    };
    if (!body.valuationHash) throw new Error('This CVA has no signed valuation snapshot hash.');
    await preflightWithApprovals('/v1/preflight/create', body);
    const data = encodeMarketCall('createOffer', [body.asset, BigInt(body.collateralAmount), BigInt(body.principalAmount), body.annualRateBps, BigInt(body.durationSeconds), BigInt(body.offerExpiry), body.permittedBuyer || ZERO_ADDRESS, body.valuationHash]);
    return sendTransaction(wallet, config.contracts.repoMarket, data);
  }, ({ hash }) => ({ message: 'Offer confirmed on Monad. Indexing may take a moment—do not submit it again.', txHash: hash }));

  const accept = (row) => transact(async () => { await preflightWithApprovals('/v1/preflight/accept', { actor: address, repoId: row.repoId }); await sendTransaction(wallet, config.contracts.repoMarket, encodeMarketCall('acceptOffer', [BigInt(row.repoId)])); }, 'Repo opened through atomic delivery-versus-payment.');
  const repurchase = (row) => transact(async () => { await preflightWithApprovals('/v1/preflight/repurchase', { actor: address, repoId: row.repoId }); await sendTransaction(wallet, config.contracts.repoMarket, encodeMarketCall('repurchase', [BigInt(row.repoId)])); }, 'Repurchase settled atomically.');
  const cancel = (row) => transact(() => sendTransaction(wallet, config.contracts.repoMarket, encodeMarketCall('cancelOffer', [BigInt(row.repoId)])), 'Offer cancelled.');
  const expire = (row) => transact(async () => {
    const state = await readRepoState(config.contracts.repoMarket, row.repoId);
    if (state.statusName !== 'OPEN') return { alreadyClosed: true, status: state.statusName };
    if (state.chainTimestamp <= state.offerExpiry) throw new Error('Monad has not reached this offer expiry yet. Please try again shortly.');
    const transaction = await sendTransaction(wallet, config.contracts.repoMarket, encodeMarketCall('expireOffer', [BigInt(row.repoId)]));
    return { ...transaction, alreadyClosed: false, status: 'EXPIRED' };
  }, (result) => result.alreadyClosed
    ? `This offer was already ${titleStatus(result.status).toLowerCase()} on Monad. Portfolio data has been refreshed.`
    : { message: 'Expired offer finalized on Monad. Portfolio indexing may take a moment.', txHash: result.hash });
  const markDefault = (row) => transact(() => sendTransaction(wallet, config.contracts.repoMarket, encodeMarketCall('markDefault', [BigInt(row.repoId)])), 'Default recorded on-chain.');
  const acceptOwnership = async (status, refresh) => {
    setBusy(true); setError(''); setNotice('');
    try {
      if (!authenticated || !address || !wallet) throw new Error('Connect the designated buyer wallet first.');
      const expected = address.toLowerCase();
      for (const [name, contract] of Object.entries(DEPLOYED_CONTRACTS)) {
        const current = status?.[name === 'assetRegistry' ? 'registry' : 'market'] || await readOwnership(contract);
        if (current.owner.toLowerCase() === expected) continue;
        if (current.pendingOwner.toLowerCase() !== expected) throw new Error(`${name} does not list this wallet as pending owner.`);
        await sendTransaction(wallet, contract, encodeAcceptOwnership());
      }
      await refresh();
      setNotice('Ownership accepted for both UAT contracts.');
    } catch (reason) {
      setError(reason.message || 'Ownership acceptance failed.');
    } finally {
      setBusy(false);
    }
  };

  const settlementSource = v2Config?.settlementToken || v2Config?.tokens?.settlement || v2Config?.data?.settlementToken || {};
  const settlement = {
    address: settlementSource.address || settlementSource.tokenAddress || '',
    symbol: settlementSource.symbol || 'aUSDC',
    decimals: Number(settlementSource.decimals ?? 6),
  };
  const configuredV2Assets = rowsFrom(v2Config, 'assets');
  const readinessProofs = v2Config?.readiness?.triPartyVault?.assetProofs || [];
  const readyProofByAsset = new Map(readinessProofs.map((proof) => [proof.asset?.toLowerCase(), proof]));
  const v2DisplayAssets = configuredV2Assets.length
    ? configuredV2Assets
    : assets.filter((asset) => readyProofByAsset.has(asset.address?.toLowerCase()));
  const v2Assets = v2DisplayAssets.filter((asset) => {
      if (configuredV2Assets.length) return asset.marketReady === true && asset.configuredVaultMatches === true && isNonZeroAddress(asset.vault);
      const proof = readyProofByAsset.get(asset.address?.toLowerCase());
      return proof?.marketReady === true && proof?.configuredVaultMatches === true && isNonZeroAddress(proof?.vault);
    });
  const isolatedEntryEnabled = v2Config?.features?.triPartyVault === true
    && v2Config?.readiness?.triPartyVault?.ready === true;
  const configuredMarginAsset = configuredV2Assets.find((asset) => asset.address?.toLowerCase() === v2Config?.readiness?.crossMargin?.proof?.asset?.toLowerCase());
  const marginPageAssets = configuredMarginAsset && !v2DisplayAssets.some((asset) => asset.address?.toLowerCase() === configuredMarginAsset.address?.toLowerCase())
    ? [...v2DisplayAssets, configuredMarginAsset]
    : v2DisplayAssets;
  const marginAuctions = auctions.filter((auction) => auction.marginAccountId !== null && auction.marginAccountId !== undefined);
  const isolatedRepoAuctions = auctions.filter((auction) => auction.marginAccountId === null || auction.marginAccountId === undefined);

  const legacyDataRelevant = (page === 'dashboard' && v2State !== 'ready')
    || (page === 'markets' && marketVersion === 'v1')
    || (page === 'create' && createVersion === 'v1')
    || (page === 'portfolio' && portfolioVersion === 'v1')
    || page === 'ownership';
  const v2DataRelevant = page === 'vault' || page === 'auctions' || page === 'margin'
    || (page === 'dashboard' && v2State === 'ready')
    || (page === 'markets' && marketVersion === 'v2')
    || (page === 'create' && createVersion === 'v2')
    || (page === 'portfolio' && portfolioVersion === 'v2');
  const syncIssue = [
    legacyDataRelevant ? syncErrors.public : '',
    legacyDataRelevant && ['dashboard', 'portfolio'].includes(page) ? syncErrors.positions : '',
    page === 'dashboard' ? syncErrors.activity : '',
    v2DataRelevant ? syncErrors['v2-config'] : '',
    page === 'dashboard' && v2State === 'ready' ? syncErrors['v2-offers'] || syncErrors['v2-portfolio'] : '',
    page === 'markets' && marketVersion === 'v2' ? syncErrors['v2-offers'] : '',
    page === 'portfolio' && portfolioVersion === 'v2' ? syncErrors['v2-portfolio'] || syncErrors['v2-claims'] : '',
    page === 'vault' ? syncErrors['v2-vault'] : '',
    ['auctions', 'margin'].includes(page) ? syncErrors['v2-auctions'] : '',
    page === 'margin' ? syncErrors['v2-margin'] : '',
  ].find(Boolean) || '';

  const current = useMemo(() => {
    if (page === 'dashboard') return <Dashboard go={go} positions={positions} offers={offers} activity={activity} address={address} assets={assets} loading={!publicLoaded || !positionsLoaded || (v2State === 'ready' && (!v2PublicLoaded || !v2WalletLoaded))} activityLoading={!activityLoaded} v2Ready={v2State === 'ready'} v2Portfolio={v2Portfolio} v2Offers={v2Offers} v2Assets={v2DisplayAssets} settlement={settlement}/>;
    if (page === 'markets') return <VersionedMarkets version={marketVersion} setVersion={setMarketVersion} v2State={v2State} retryV2={detectV2} v2Offers={v2Offers} assets={v2DisplayAssets} address={address} busy={busy} v2Loading={!v2PublicLoaded} onV2Action={executeV2Action} settlement={settlement} entryEnabled={isolatedEntryEnabled} v1={<Markets offers={offers} assets={assets} address={address} onAccept={accept} busy={busy} loading={!publicLoaded}/>}/>;
    if (page === 'create') return <VersionedCreate version={createVersion} setVersion={setCreateVersion} v2State={v2State} retryV2={detectV2} assets={v2Assets} balances={vaultBalances} marginAccounts={marginAccounts} config={v2Config} address={address} busy={busy} onV2Action={executeV2Action} settlement={settlement} preferredMarginAccount={preferredMarginAccount} chainClock={v2ChainClock} entryEnabled={isolatedEntryEnabled} v1={<CreateRepo assets={assets} config={config} address={address} onCreate={create} busy={busy} lastPreflight={lastPreflight}/>}/>;
    if (page === 'ownership') return <OwnershipSetup address={address} authenticated={authenticated} login={login} busy={busy} onAccept={acceptOwnership}/>;
    if (page === 'portfolio') return <VersionedPortfolio version={portfolioVersion} setVersion={setPortfolioVersion} v2State={v2State} retryV2={detectV2} v2Portfolio={v2Portfolio} claims={settlementClaims} assets={v2DisplayAssets} address={address} busy={busy} v2Loading={!v2WalletLoaded} onV2Action={executeV2Action} settlement={settlement} chainClock={v2ChainClock} v1={<Portfolio positions={positions} assets={assets} address={address} onRepurchase={repurchase} onCancel={cancel} onExpire={expire} onDefault={markDefault} busy={busy} loading={!positionsLoaded}/>}/>;
    if (page === 'vault') return v2State === 'ready' ? <VaultPage balances={vaultBalances} assets={v2DisplayAssets} address={address} loading={!v2WalletLoaded} busy={busy} onAction={executeV2Action} entryEnabled={isolatedEntryEnabled}/> : <div className="page-view"><V2Unavailable state={v2State} onRetry={detectV2}/></div>;
    if (page === 'auctions') return v2State === 'ready' ? <AuctionsPage auctions={isolatedRepoAuctions} assets={v2DisplayAssets} address={address} loading={!v2PublicLoaded} busy={busy} onAction={executeV2Action} settlement={settlement} chainClock={v2ChainClock}/> : <div className="page-view"><V2Unavailable state={v2State === 'loading' ? 'loading' : 'unavailable'} onRetry={detectV2}/></div>;
    return (v2State === 'ready' || marginExitAvailable) ? <MarginPage accounts={marginAccounts} auctions={marginAuctions} assets={marginPageAssets} address={address} loading={!v2WalletLoaded || !v2PublicLoaded} busy={busy} onAction={executeV2Action} settlement={settlement} deployed={marginExitAvailable} entryEnabled={v2State === 'ready' && v2Config?.features?.crossMargin === true} readiness={v2Config?.readiness?.crossMargin} durations={v2Config?.terms?.allowedDurations || []} chainClock={v2ChainClock}/> : <div className="page-view"><V2Unavailable state={v2State} onRetry={detectV2}/></div>;
  }, [page, positions, offers, activity, assets, address, authenticated, busy, config, lastPreflight, publicLoaded, positionsLoaded, activityLoaded, marketVersion, portfolioVersion, createVersion, preferredMarginAccount, v2State, v2Config, v2Offers, v2Portfolio, settlementClaims, v2ChainClock, vaultBalances, isolatedRepoAuctions, marginAuctions, marginAccounts, marginPageAssets, marginExitAvailable, v2DisplayAssets, v2Assets, isolatedEntryEnabled, v2PublicLoaded, v2WalletLoaded]);

  if (page === 'landing') return <Landing go={go} auth={auth} compliance={compliance} complianceState={complianceState}/>;
  return <div className="app-shell"><Header page={page} go={go} auth={auth} compliance={compliance} complianceState={complianceState}/><Sidebar page={page} go={go} configured={Boolean(config?.contracts?.repoMarket)} v2State={v2State}/><main className="main-content">{error && <div className="runtime-banner error">{error}</div>}{syncIssue && !error && <div className="runtime-banner warning"><span>Live data is temporarily unavailable. Retrying automatically.</span><button type="button" onClick={() => void (v2State === 'ready' ? Promise.allSettled([refreshLiveData(), refreshV2Data()]) : refreshLiveData())}>Retry now</button></div>}{notice && <div className="runtime-banner success"><span>{typeof notice === 'string' ? notice : notice.message}</span>{typeof notice === 'object' && notice.txHash && <a href={`${config?.chain?.explorerUrl || 'https://testnet.monadscan.com'}/tx/${notice.txHash}`} target="_blank" rel="noreferrer">View transaction</a>}</div>}<ExecutionStatus execution={v2Execution} explorerUrl={v2Config?.chain?.explorerUrl || config?.chain?.explorerUrl}/>{current}</main></div>;
}

export default AppLive;
